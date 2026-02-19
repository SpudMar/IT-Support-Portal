
import os
import json
import time
import base64
import logging
import pathlib
from typing import Optional

from google import genai
from google.genai import types

logger = logging.getLogger("gemini_backend")
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("[%(asctime)s] %(levelname)s %(name)s: %(message)s"))
    logger.addHandler(handler)


def _load_resolution_paths() -> str:
    """Load curated resolution steps from LAIT spec. Called once at module load."""
    try:
        paths_file = (
            pathlib.Path(__file__).parent.parent
            / "LAIT"
            / "self-service"
            / "resolution-paths.json"
        )
        with open(paths_file) as f:
            data = json.load(f)
        lines = [
            "\n\nSELF-SERVICE RESOLUTION SCRIPTS:",
            "When a user's issue matches a sub-category below, follow EXACTLY these steps.",
            "Do not improvise alternative steps — these are tested for the Lotus Assist M365 environment.\n",
        ]
        for path in data.get("resolution_paths", []):
            lines.append(f"[{path['title']}]")
            for i, step in enumerate(path["steps"], 1):
                lines.append(f"  {i}. {step}")
            lines.append(f"  > If not resolved: {path['if_not_resolved']}\n")
        result = "\n".join(lines)
        logger.info(
            "Loaded %d resolution paths from LAIT spec.", len(data.get("resolution_paths", []))
        )
        return result
    except Exception as e:
        logger.warning("Could not load resolution paths from LAIT spec: %s", e)
        return ""


# --- API Key ---
def _get_gemini_key() -> str:
    """Read key at call time so Azure env vars are always visible."""
    key = os.getenv("GEMINI_API_KEY") or os.getenv("API_KEY", "")
    if not key:
        logger.error("GEMINI_API_KEY is empty! GEMINI_API_KEY=%r  API_KEY=%r",
                      os.getenv("GEMINI_API_KEY"), os.getenv("API_KEY"))
    return key

# --- Models ---
MODEL_FLASH = "gemini-2.5-flash"
MODEL_PRO = "gemini-2.5-pro"

# --- System Instruction ---
_BASE_SYSTEM_INSTRUCTION = """
You are the "Lotus Assist IT Support Co-pilot" — the front-line triage assistant for a small Australian business running Microsoft 365 Business Premium (20-30 users). You work alongside a single IT administrator.

VOICE & TONE:
- You are a helpful colleague, not a form. Conversational Australian English.
- Ask one question at a time. Keep responses under 3 short paragraphs.
- Acknowledge inconvenience before diving into fixes. No jargon.
- Say "restart your computer" not "perform a cold boot cycle."

CORE RULES:
1. SELF-SERVICE FIRST: Always attempt ONE guided fix before escalating. If it resolves, confirm and close warmly. If not, escalate immediately — don't make them try multiple things.
2. SECURITY ALWAYS ESCALATES: Phishing, suspicious emails, compromised accounts, ransomware, malware, data breaches = immediate P1 escalation. No self-service. Tell user help is on the way, don't click anything.
3. NEVER ASK FOR LOCATION OR TIME: These are auto-captured from the session. Never ask "Where are you?" or "When are you available?" — the system handles this.
4. NEVER ASK FOR PASSWORDS: Never suggest fixes requiring local admin rights without flagging admin_required: true.
5. FRUSTRATION DETECTION: Escalate IMMEDIATELY (minimum P2, with empathy) if the user says any of the following or expresses similar sentiment:
   "ridiculous", "frustrated", "fed up", "waste of time", "been dealing with this",
   "I'm lost", "nothing works", "I give up", "this is broken", "every single time"
   Do NOT push more troubleshooting when frustration is detected. Get a human involved immediately.
6. OUTAGE DETECTION: If context indicates 3+ users with the same issue, flag as potential outage, escalate to P1.
7. MULTIMODAL: If user describes an error they can't articulate, ask for a screenshot/photo.
8. THINK BEFORE ACTING: Use your reasoning budget to determine quick-fix vs systemic failure.

PRIORITY LEVELS:
- P1 (Critical): Security incidents, outages (3+ users), complete inability to work. SLA 15 min.
- P2 (High): Single user unable to work, key app down, data at risk. SLA 1 hour.
- P3 (Medium): Degraded functionality, workaround available. SLA 4 hours.
- P4 (Low): Feature requests, cosmetic issues, non-urgent. SLA next business day.

SUPPORTED CATEGORIES (use these for classification):
1. Microsoft 365 — Outlook, Teams, SharePoint, OneDrive, Word/Excel/PowerPoint
2. Identity & Access — Passwords, MFA, SSO, Account Lockouts, Conditional Access
3. Xero — Login, Bank Feeds, Invoicing, Reports, Integrations
4. Careview — Login, Records, Reporting, Performance, Database
5. enableHR — Login, Leave, Payroll, Documents
6. Hardware — Laptops, Displays, Keyboards, Battery, Docking, Printers, Peripherals
7. Network & Connectivity — Wi-Fi, VPN, Internet, DNS
8. Security — Phishing, Account Compromise, Malware, Data Breach (ALWAYS P1)
9. General — Software Requests, New User, Offboarding, General Questions

CONVERSATION FLOW:
Phase 1: Greet warmly, ask what's going on naturally
Phase 2: 1-2 clarifying questions max, classify the issue
Phase 3: Offer ONE self-service fix using the scripts below (skip for security)
Phase 4: If fixed then confirm and close. If not then call log_incident immediately.

FUNCTION CALLING:
- Call 'search_knowledge_base' FIRST when you identify the issue. Use results to inform your fix suggestion. Don't show raw results to user.
- Call 'log_incident' when: self-service failed, admin needed, security detected, user frustrated, outage detected.
- Do NOT call 'capture_logistics'. Location/time/phone are auto-captured from the session.
"""

# Augment with curated resolution paths from LAIT spec (loaded once at module init)
SYSTEM_INSTRUCTION = _BASE_SYSTEM_INSTRUCTION + _load_resolution_paths()

# --- Function Declarations (ported exactly from geminiService.ts) ---
SEARCH_KB_DECL = types.FunctionDeclaration(
    name="search_knowledge_base",
    parameters=types.Schema(
        type="OBJECT",
        description="Searches the Lotus Assist internal knowledge base for known issues and solutions.",
        properties={
            "query": types.Schema(
                type="STRING",
                description="The search query or keyword related to the issue.",
            ),
        },
        required=["query"],
    ),
)

LOG_INCIDENT_DECL = types.FunctionDeclaration(
    name="log_incident",
    parameters=types.Schema(
        type="OBJECT",
        description="Logs a structured IT support ticket for admin follow-up. Call when self-service fails, admin access is needed, security is detected, user is frustrated, or outage detected.",
        properties={
            "summary": types.Schema(
                type="STRING",
                description="A concise 10-word technical summary of the issue.",
            ),
            "category": types.Schema(
                type="STRING",
                description="Top-level issue category.",
                enum=["Microsoft 365", "Identity & Access", "Xero", "Careview", "enableHR", "Hardware", "Network & Connectivity", "Security", "General"],
            ),
            "sub_category": types.Schema(
                type="STRING",
                description='Specific sub-category (e.g. "Outlook - Sync Issues", "VPN Issues", "Phishing/Suspicious Email").',
            ),
            "priority": types.Schema(
                type="STRING",
                description="Priority level. P1=Critical (security/outage), P2=High (user blocked), P3=Medium (degraded), P4=Low (non-urgent).",
                enum=["P1", "P2", "P3", "P4"],
            ),
            "admin_required": types.Schema(
                type="BOOLEAN",
                description="Whether the fix requires admin/elevated access.",
            ),
            "self_service_attempted": types.Schema(
                type="BOOLEAN",
                description="Whether a self-service fix was attempted before escalating.",
            ),
            "self_service_result": types.Schema(
                type="STRING",
                description="Outcome of the self-service attempt.",
                enum=["resolved", "not_resolved", "not_attempted", "security_bypass"],
            ),
            "security_flag": types.Schema(
                type="BOOLEAN",
                description="True if this is a security incident requiring immediate attention.",
            ),
            "outage_flag": types.Schema(
                type="BOOLEAN",
                description="True if this appears to be part of a broader outage (3+ users).",
            ),
            "affected_application": types.Schema(
                type="STRING",
                description="The primary application or system affected.",
            ),
            "ai_recommended_actions": types.Schema(
                type="ARRAY",
                description="Suggested next steps for the IT admin.",
                items=types.Schema(type="STRING"),
            ),
            "priority_justification": types.Schema(
                type="STRING",
                description="Brief explanation of why this priority level was assigned (e.g. 'User completely unable to work, primary application down').",
            ),
            "diagnostic_data": types.Schema(
                type="OBJECT",
                description="Structured diagnostic information gathered during the conversation.",
                properties={
                    "error_message": types.Schema(
                        type="STRING",
                        description="Exact error message reported by the user, if any.",
                    ),
                    "device_type": types.Schema(
                        type="STRING",
                        description="Type of device affected.",
                        enum=["laptop", "desktop", "mobile", "tablet", "printer", "other"],
                    ),
                    "affected_user_count": types.Schema(
                        type="INTEGER",
                        description="Number of users affected. 1 = single user, 3+ = potential outage.",
                    ),
                    "issue_duration": types.Schema(
                        type="STRING",
                        description="How long the issue has been occurring (e.g. 'since this morning', 'about an hour').",
                    ),
                    "steps_already_tried": types.Schema(
                        type="ARRAY",
                        description="Steps the user or AI already attempted before escalating.",
                        items=types.Schema(type="STRING"),
                    ),
                },
            ),
        },
        required=["summary", "category", "priority", "admin_required", "self_service_attempted"],
    ),
)

TOOLS = [types.Tool(function_declarations=[SEARCH_KB_DECL, LOG_INCIDENT_DECL])]

# --- Image Validation ---
MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024  # 10 MB


def _validate_image(image_data: str) -> tuple[str, bytes]:
    """Validate and decode base64 image data. Returns (mime_type, raw_bytes)."""
    # Strip data URI prefix if present
    if "," in image_data:
        header, b64_data = image_data.split(",", 1)
        # Extract mime type from "data:image/jpeg;base64"
        if ":" in header and ";" in header:
            mime_type = header.split(":")[1].split(";")[0]
        else:
            mime_type = "image/jpeg"
    else:
        b64_data = image_data
        mime_type = "image/jpeg"

    raw = base64.b64decode(b64_data)
    if len(raw) > MAX_IMAGE_SIZE_BYTES:
        raise ValueError(f"Image exceeds maximum size of {MAX_IMAGE_SIZE_BYTES // (1024*1024)}MB")
    return mime_type, raw


def _build_contents(messages: list, image_data: str | None = None) -> list:
    """Convert message history [{role, content}] to Gemini SDK content format."""
    contents = []
    for msg in messages:
        role = "user" if msg.get("role") == "user" else "model"
        parts = [types.Part.from_text(text=msg.get("content", ""))]
        contents.append(types.Content(role=role, parts=parts))

    # Attach image to the last user message
    if image_data and contents:
        mime_type, raw_bytes = _validate_image(image_data)
        # Find last user message and add image part
        for i in range(len(contents) - 1, -1, -1):
            if contents[i].role == "user":
                contents[i].parts.append(
                    types.Part.from_bytes(data=raw_bytes, mime_type=mime_type)
                )
                break

    return contents


def _extract_text(response) -> str:
    """Extract text parts from Gemini response, ignoring thinking/thought parts."""
    try:
        parts = response.candidates[0].content.parts
        text_parts = []
        for p in parts:
            if hasattr(p, "text") and p.text is not None:
                # Skip thought parts
                if hasattr(p, "thought") and p.thought:
                    continue
                text_parts.append(p.text)
        return "".join(text_parts)
    except (IndexError, AttributeError):
        try:
            return response.text or ""
        except Exception:
            return ""


def _extract_function_calls(response) -> list:
    """Extract function calls from Gemini response."""
    calls = []
    try:
        parts = response.candidates[0].content.parts
        for p in parts:
            if hasattr(p, "function_call") and p.function_call is not None:
                fc = p.function_call
                args = dict(fc.args) if fc.args else {}
                calls.append({"name": fc.name, "args": args})
    except (IndexError, AttributeError):
        pass
    return calls


def _log_usage(model: str, start_time: float, response=None):
    """Log model call metrics for cost monitoring."""
    latency_ms = int((time.time() - start_time) * 1000)
    token_info = ""
    try:
        if response and hasattr(response, "usage_metadata") and response.usage_metadata:
            um = response.usage_metadata
            prompt_tokens = getattr(um, "prompt_token_count", None)
            candidates_tokens = getattr(um, "candidates_token_count", None)
            thinking_tokens = getattr(um, "thinking_token_count", None)
            parts = []
            if prompt_tokens is not None:
                parts.append(f"prompt={prompt_tokens}")
            if candidates_tokens is not None:
                parts.append(f"completion={candidates_tokens}")
            if thinking_tokens is not None:
                parts.append(f"thinking={thinking_tokens}")
            if parts:
                token_info = f" tokens=[{', '.join(parts)}]"
    except Exception:
        pass
    logger.info(f"Gemini call: model={model} latency={latency_ms}ms{token_info}")


# =============================================================================
# PUBLIC API
# =============================================================================

async def chat_with_gemini(messages: list, image_data: str | None = None) -> dict:
    """
    Main user-facing chat with Gemini Flash.

    Args:
        messages: List of {role: 'user'|'model', content: str}
        image_data: Optional base64-encoded image (with or without data URI prefix)

    Returns:
        dict with keys: text (str), function_calls (list), error (str|None)
    """
    start = time.time()
    try:
        client = genai.Client(api_key=_get_gemini_key())

        # Validate image if present
        if image_data:
            try:
                _validate_image(image_data)
            except ValueError as ve:
                return {"text": "", "function_calls": [], "error": str(ve)}

        contents = _build_contents(messages, image_data)

        response = client.models.generate_content(
            model=MODEL_FLASH,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTION,
                thinking_config=types.ThinkingConfig(thinking_budget=24576),
                tools=TOOLS,
            ),
        )

        _log_usage(MODEL_FLASH, start, response)

        text = _extract_text(response)
        function_calls = _extract_function_calls(response)

        return {"text": text, "function_calls": function_calls, "error": None}

    except Exception as e:
        _log_usage(MODEL_FLASH, start)
        error_msg = str(e)
        # Handle rate limiting
        if "429" in error_msg or "RESOURCE_EXHAUSTED" in error_msg:
            logger.warning(f"Rate limited on {MODEL_FLASH}: {error_msg}")
            return {
                "text": "",
                "function_calls": [],
                "error": "Our AI service is currently busy. Please wait a moment and try again.",
            }
        logger.error(f"Gemini Flash error: {error_msg}", exc_info=True)
        return {
            "text": "",
            "function_calls": [],
            "error": "Something went wrong with the AI service. Please try again shortly.",
        }


async def chat_with_admin_expert(ticket_context: dict, messages: list) -> dict:
    """
    Admin expert consultation using Gemini Pro.

    Args:
        ticket_context: dict with keys id, category, summary, criticality, sharepointId
        messages: List of {role: 'user'|'model', content: str}

    Returns:
        dict with keys: text (str), error (str|None)
    """
    start = time.time()
    try:
        client = genai.Client(api_key=_get_gemini_key())

        system_prompt = f"""
    You are the "Lotus Assist Senior IT Architect". You are assisting an IT Admin in resolving an incident.
    USER INCIDENT CONTEXT:
    - ID: {ticket_context.get('id', 'N/A')}
    - SharePoint ID: {ticket_context.get('sharepointId', 'Not yet synced')}
    - Category: {ticket_context.get('category', 'General')}
    - Summary: {ticket_context.get('summary', '')}
    - Criticality: {ticket_context.get('criticality', 'Medium')}

    MISSION: Provide high-level technical remediation steps. If the issue is complex (e.g., Azure Entra ID or Careview database locks), reason through dependencies.
"""

        contents = _build_contents(messages)

        response = client.models.generate_content(
            model=MODEL_PRO,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                thinking_config=types.ThinkingConfig(thinking_budget=32768),
            ),
        )

        _log_usage(MODEL_PRO, start, response)

        text = _extract_text(response)
        return {"text": text, "error": None}

    except Exception as e:
        _log_usage(MODEL_PRO, start)
        error_msg = str(e)
        if "429" in error_msg or "RESOURCE_EXHAUSTED" in error_msg:
            logger.warning(f"Rate limited on {MODEL_PRO}: {error_msg}")
            return {
                "text": "",
                "error": "The AI architect service is currently busy. Please wait a moment and try again.",
            }
        logger.error(f"Gemini Pro error: {error_msg}", exc_info=True)
        return {
            "text": "",
            "error": "Something went wrong consulting the AI architect. Please try again shortly.",
        }


async def generate_kb_from_ticket(summary: str, transcript: list, category: str) -> dict:
    """
    Generate a KB article suggestion from a resolved ticket.

    Args:
        summary: Ticket summary
        transcript: List of message dicts [{role, content}]
        category: Ticket category

    Returns:
        dict with keys: title, category, answer, keywords
    """
    start = time.time()
    try:
        client = genai.Client(api_key=_get_gemini_key())

        conversation_text = "\n".join(
            [f"{m.get('role', 'unknown')}: {m.get('content', '')}" for m in transcript]
        )

        prompt = f"""Based on this IT support ticket, generate a Knowledge Base article.

Ticket Summary: {summary}
Category: {category}

Conversation:
{conversation_text}

Generate a JSON response with:
- title: A clear, searchable question (e.g., "How to fix Outlook not syncing?")
- category: One of: Microsoft 365, Identity & Access, Xero, Careview, enableHR, Hardware, Network & Connectivity, Security, General
- answer: Step-by-step solution (200-300 words)
- keywords: Array of 3-5 searchable keywords

Return ONLY valid JSON, no markdown."""

        response = client.models.generate_content(
            model=MODEL_FLASH,
            contents=[types.Content(role="user", parts=[types.Part.from_text(text=prompt)])],
            config=types.GenerateContentConfig(
                thinking_config=types.ThinkingConfig(thinking_budget=8192),
            ),
        )

        _log_usage(MODEL_FLASH, start, response)

        raw_text = _extract_text(response).strip()
        # Strip markdown code fences if present
        raw_text = raw_text.replace("```json", "").replace("```", "").strip()
        suggestion = json.loads(raw_text)
        return suggestion

    except Exception as e:
        _log_usage(MODEL_FLASH, start)
        error_msg = str(e)
        if "429" in error_msg or "RESOURCE_EXHAUSTED" in error_msg:
            logger.warning(f"Rate limited on KB generation: {error_msg}")
        else:
            logger.error(f"KB generation error: {error_msg}", exc_info=True)
        # Return a sensible fallback
        return {
            "title": summary,
            "category": category,
            "answer": "Please provide a detailed solution based on the ticket resolution.",
            "keywords": [category.lower()],
        }
