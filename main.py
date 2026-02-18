
import os
import sys
import json
import re
import logging
from datetime import datetime, timezone, timedelta
from typing import List, Optional
from fastapi import FastAPI, HTTPException, Body, Request, Depends, Response, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

# Azure & Microsoft Graph
from azure.identity import DefaultAzureCredential
from msgraph import GraphServiceClient
import httpx

# Auth middleware
from auth_middleware import get_current_user, require_admin, UserContext

# Server-side Gemini AI
from services.gemini_backend import chat_with_gemini, chat_with_admin_expert, generate_kb_from_ticket

# NOTE: SP list-item writes use httpx directly against the Graph REST API.
# The msgraph-sdk's FieldValueSet.additional_data silently drops custom fields
# during serialization, causing generalException. Reads still use the SDK.

# SharePoint Internal Column Name Mappings (verified via Graph API 2026-02-15)
# IMPORTANT: Reads via additional_data return DISPLAY names. Writes require INTERNAL names.
#
# Tickets List (f36dbf6a):
#   field_1=Category  field_2=StaffPhone(number,E.164)  field_3=StaffEmail
#   field_4=StaffName  field_5=Location  field_6=Availability
#   field_7=Criticality  field_8=Status  field_9=Transcript  field_10=ThinkingLog
#
# KB List (a035c017): internal names MATCH display names (Category, Answer, Keywords)
# Routing List (5b899e4a): field_1=AdminName field_2=AdminEmail(text) field_3=BackupAdmin field_4=NotifySMS(bool)

# ──────────────────────────────────────────────
# Logging
# ──────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("lotus_it")

# ──────────────────────────────────────────────
# Startup validation — fail fast if config is missing
# ──────────────────────────────────────────────
REQUIRED_ENV_VARS = [
    "SHAREPOINT_SITE_ID",
    "SHAREPOINT_LIST_ID",
    "SHAREPOINT_ROUTING_LIST_ID",
]

_missing = [v for v in REQUIRED_ENV_VARS if not os.getenv(v)]
if _missing:
    logger.critical(
        "Missing required environment variables: %s — cannot start.",
        ", ".join(_missing),
    )
    sys.exit(1)

# ──────────────────────────────────────────────
# Input validation helpers
# ──────────────────────────────────────────────
EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")
SP_ID_RE = re.compile(r"^\d+$")


def validate_email(email: str) -> str:
    """Validate email format to prevent OData injection."""
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="Invalid email format")
    return email


def validate_sp_id(sp_id: str) -> str:
    """Validate SharePoint ID is numeric only."""
    if not SP_ID_RE.match(sp_id):
        raise HTTPException(status_code=400, detail="Invalid identifier format")
    return sp_id


# ──────────────────────────────────────────────
# App setup
# ──────────────────────────────────────────────
app = FastAPI(title="Lotus IT Support Unified Portal")

# --- 1. CORS Setup ---
ALLOWED_ORIGIN = os.getenv(
    "ALLOWED_ORIGIN", "https://lotus-itsp-bridge.azurewebsites.net"
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Security headers middleware ---
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response: Response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Strict-Transport-Security"] = "max-age=31536000"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


# --- 2. Configuration ---
SITE_ID = os.getenv("SHAREPOINT_SITE_ID")
LIST_ID = os.getenv("SHAREPOINT_LIST_ID")
ROUTING_LIST_ID = os.getenv("SHAREPOINT_ROUTING_LIST_ID")

# --- 3. Clients ---
credential = DefaultAzureCredential()
graph_client = GraphServiceClient(credential)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"


async def graph_post(path: str, body: dict) -> dict:
    """Direct Graph API POST — bypasses SDK serialization issues."""
    token = credential.get_token("https://graph.microsoft.com/.default").token
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{GRAPH_BASE}{path}",
            json=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        if r.status_code >= 400:
            logger.error("Graph POST %s returned %d: %s", path, r.status_code, r.text)
            raise HTTPException(
                status_code=r.status_code, detail="SharePoint operation failed"
            )
        return r.json()


async def graph_patch(path: str, body: dict) -> dict:
    """Direct Graph API PATCH — bypasses SDK serialization issues."""
    token = credential.get_token("https://graph.microsoft.com/.default").token
    async with httpx.AsyncClient() as client:
        r = await client.patch(
            f"{GRAPH_BASE}{path}",
            json=body,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        if r.status_code >= 400:
            logger.error(
                "Graph PATCH %s returned %d: %s", path, r.status_code, r.text
            )
            raise HTTPException(
                status_code=r.status_code, detail="SharePoint operation failed"
            )
        return r.json()


# --- 4. Models ---
class Ticket(BaseModel):
    id: Optional[str] = None
    sharepointId: Optional[str] = None
    summary: str
    userName: str
    userEmail: str
    userPhone: Optional[str] = None
    criticality: str
    priority: Optional[str] = None
    status: str
    category: Optional[str] = "General"
    subCategory: Optional[str] = None
    location: Optional[str] = None
    availability: Optional[str] = None
    thinkingLog: Optional[str] = None
    transcript: List[dict]
    securityFlag: Optional[bool] = False
    outageFlag: Optional[bool] = False
    selfServiceAttempted: Optional[bool] = False
    selfServiceResult: Optional[str] = None


# --- 5. API Endpoints ---


@app.get("/api/health")
async def health():
    return {"status": "online", "identity": "ManagedIdentity"}


# --- Gemini AI Chat Endpoints (server-side) ---


@app.post("/api/chat")
async def chat_endpoint(
    payload: dict = Body(...), user: UserContext = Depends(get_current_user)
):
    """
    Main user-facing chat endpoint. Proxies to server-side Gemini.
    Handles function call execution (KB search, log_incident) server-side.

    Accepts: {messages: [{role, content}], image?: base64_string}
    Returns: {text: str, function_calls: list, incident_data: dict|None, error: str|None}
    """
    messages = payload.get("messages", [])
    image = payload.get("image")

    if not messages:
        raise HTTPException(status_code=400, detail="Messages are required")

    # Call Gemini
    result = await chat_with_gemini(messages, image)

    if result.get("error"):
        return {
            "text": "",
            "function_calls": [],
            "incident_data": None,
            "error": result["error"],
        }

    function_calls = result.get("function_calls", [])
    incident_data = None
    final_text = result.get("text", "")

    if function_calls:
        for fc in function_calls:
            if fc["name"] == "search_knowledge_base":
                # Execute KB search server-side
                query = fc.get("args", {}).get("query", "")
                kb_list_id = os.getenv(
                    "SHAREPOINT_KB_LIST_ID",
                    "a035c017-edee-4923-9277-ecf7d080eaee",
                )
                try:
                    kb_result = (
                        await graph_client.sites.by_site_id(SITE_ID)
                        .lists.by_list_id(kb_list_id)
                        .items.get(
                            request_configuration=lambda x: (
                                setattr(
                                    x.query_parameters, "expand", ["fields"]
                                ),
                                setattr(x.query_parameters, "top", 50),
                            )
                        )
                    )
                    articles = []
                    if kb_result and kb_result.value:
                        search_term = query.lower()
                        for item in kb_result.value:
                            f = (
                                item.fields.additional_data
                                if item.fields
                                else {}
                            )
                            title = f.get("Title", "")
                            answer = f.get("Answer", "")
                            keywords_str = f.get("Keywords", "")
                            cat = f.get("Category", "General")
                            if (
                                search_term in title.lower()
                                or search_term in answer.lower()
                                or search_term in keywords_str.lower()
                                or search_term in cat.lower()
                            ):
                                articles.append(
                                    {
                                        "title": title,
                                        "content": answer,
                                        "category": cat,
                                    }
                                )
                except Exception as kb_err:
                    logger.warning("KB search in chat failed: %s", kb_err)
                    articles = []

                kb_summary = (
                    "Matches found: {}. Details: {}".format(
                        ", ".join(a["title"] for a in articles),
                        "\n".join(a["content"] for a in articles),
                    )
                    if articles
                    else "No matches found."
                )

                # Follow-up call with KB results
                follow_up_messages = messages + [
                    {
                        "role": "model",
                        "content": f"Knowledge Base Results: {kb_summary}",
                    }
                ]
                follow_up = await chat_with_gemini(follow_up_messages)
                if not follow_up.get("error"):
                    final_text = follow_up.get("text", final_text)

            elif fc["name"] == "log_incident":
                # Return incident data to the frontend for ticket creation
                incident_data = fc.get("args", {})

                # Follow-up call so Gemini confirms the escalation to the user
                category = incident_data.get("category", "General")
                priority = incident_data.get("priority", "P3")
                follow_up_messages = messages + [
                    {
                        "role": "model",
                        "content": f"Incident logged for {category} at {priority} priority.",
                    }
                ]
                follow_up = await chat_with_gemini(follow_up_messages)
                if not follow_up.get("error"):
                    final_text = follow_up.get("text", final_text)

    return {
        "text": final_text,
        "function_calls": [
            {"name": fc["name"], "args": fc["args"]} for fc in function_calls
        ],
        "incident_data": incident_data,
        "error": None,
    }


@app.post("/api/chat/admin")
async def admin_chat_endpoint(
    payload: dict = Body(...), admin: UserContext = Depends(require_admin)
):
    """
    Admin expert consultation endpoint. Uses Gemini Pro.

    Accepts: {ticket: {id, category, summary, criticality, sharepointId}, messages: [{role, content}]}
    Returns: {text: str, error: str|None}
    """
    ticket_context = payload.get("ticket", {})
    messages = payload.get("messages", [])

    if not messages:
        raise HTTPException(status_code=400, detail="Messages are required")
    if not ticket_context:
        raise HTTPException(status_code=400, detail="Ticket context is required")

    result = await chat_with_admin_expert(ticket_context, messages)
    return {"text": result.get("text", ""), "error": result.get("error")}


@app.post("/api/tickets")
async def upsert_ticket(ticket: Ticket, user: UserContext = Depends(get_current_user)):
    phone_val = None
    if ticket.userPhone:
        digits = re.sub(r"\D", "", ticket.userPhone)
        if digits:
            # Convert AU mobile to E.164 numeric: 0402... -> 61402...
            if digits.startswith("0") and len(digits) == 10:
                digits = "61" + digits[1:]
            elif digits.startswith("61") and len(digits) == 11:
                pass  # Already E.164 without +
            try:
                phone_val = int(digits)
            except ValueError:
                phone_val = None

    # Validate email to prevent OData injection
    validate_email(ticket.userEmail)

    # Validate SharePoint ID if provided
    if ticket.sharepointId and ticket.sharepointId != "local":
        validate_sp_id(ticket.sharepointId)

    # Build enhanced thinking log with LAIT metadata
    thinking_data = ticket.thinkingLog or ""
    if (
        ticket.priority
        or ticket.subCategory
        or ticket.securityFlag
        or ticket.outageFlag
    ):
        lait_meta = json.dumps(
            {
                "priority": ticket.priority,
                "sub_category": ticket.subCategory,
                "security_flag": ticket.securityFlag,
                "outage_flag": ticket.outageFlag,
                "self_service_attempted": ticket.selfServiceAttempted,
                "self_service_result": ticket.selfServiceResult,
            }
        )
        thinking_data = (
            f"{thinking_data}\n---LAIT_META---\n{lait_meta}"
            if thinking_data
            else lait_meta
        )

    field_data = {
        "Title": ticket.summary,
        "field_1": ticket.category,  # Category
        "field_2": phone_val,  # StaffPhone (number, E.164)
        "field_3": ticket.userEmail,  # StaffEmail
        "field_4": ticket.userName,  # StaffName
        "field_5": ticket.location,  # Location
        "field_6": ticket.availability,  # Availability
        "field_7": ticket.criticality,  # Criticality (Choice dropdown)
        "field_8": ticket.status,  # Status (Choice dropdown)
        "field_9": json.dumps(ticket.transcript),  # Transcript
        "field_10": thinking_data,  # ThinkingLog + LAIT metadata
    }
    # Strip None values — SP rejects explicit nulls on some column types
    field_data = {k: v for k, v in field_data.items() if v is not None}

    try:
        if ticket.sharepointId and ticket.sharepointId != "local":
            await graph_patch(
                f"/sites/{SITE_ID}/lists/{LIST_ID}/items/{ticket.sharepointId}/fields",
                field_data,
            )
            return {"sharepoint_id": ticket.sharepointId}
        else:
            result = await graph_post(
                f"/sites/{SITE_ID}/lists/{LIST_ID}/items",
                {"fields": field_data},
            )

            # --- NOTIFICATIONS (Fire & Forget) ---
            # Uses unified send_ticket_notification which handles:
            # - Adaptive Card to Teams channel (if TEAMS_TEAM_ID set)
            # - DM to assigned admin
            # - SMS if routing says so
            # Notification failure never blocks ticket creation.
            sharepoint_id = result.get("id")
            channel_message_id = None
            try:
                from services.notificationService import send_ticket_notification

                ticket_data = {
                    "sharepointId": sharepoint_id,
                    "summary": ticket.summary,
                    "userName": ticket.userName,
                    "userEmail": ticket.userEmail,
                    "criticality": ticket.criticality,
                    "priority": ticket.priority,
                    "category": ticket.category,
                    "status": ticket.status,
                    "transcript": ticket.transcript,
                    "thinkingLog": thinking_data,
                    "securityFlag": ticket.securityFlag,
                    "outageFlag": ticket.outageFlag,
                }

                notify_result = await send_ticket_notification(
                    graph_client, ticket_data, SITE_ID, ROUTING_LIST_ID
                )
                channel_message_id = notify_result.get("channel_message_id")

                # Store channel_message_id in ThinkingLog so status updates
                # can thread replies to the original channel message.
                if channel_message_id:
                    teams_meta = json.dumps({"teams_message_id": channel_message_id})
                    updated_thinking = thinking_data or ""
                    updated_thinking += f"\n---TEAMS_META---\n{teams_meta}"
                    try:
                        await graph_patch(
                            f"/sites/{SITE_ID}/lists/{LIST_ID}/items/{sharepoint_id}/fields",
                            {"field_10": updated_thinking},
                        )
                    except Exception as meta_ex:
                        logger.warning(
                            "Failed to store Teams message ID for ticket %s: %s",
                            sharepoint_id, meta_ex,
                        )
            except Exception as notify_ex:
                logger.warning("Notification Error: %s", notify_ex)
            # -------------------------------------

            return {"sharepoint_id": sharepoint_id}
    except HTTPException:
        raise  # Re-raise Graph API errors from graph_post/graph_patch
    except Exception as e:
        logger.exception("SharePoint Upsert Error")
        raise HTTPException(status_code=500, detail="Failed to save ticket")


@app.get("/api/tickets/search/{email}")
async def search_tickets(email: str, user: UserContext = Depends(get_current_user)):
    # Validate email to prevent OData injection
    validate_email(email)

    try:
        # StaffEmail is the column name
        query_filter = f"fields/field_3 eq '{email}'"  # field_3 = StaffEmail
        result = (
            await graph_client.sites.by_site_id(SITE_ID)
            .lists.by_list_id(LIST_ID)
            .items.get(
                request_configuration=lambda x: (
                    setattr(x.query_parameters, "expand", ["fields"]),
                    setattr(x.query_parameters, "filter", query_filter),
                )
            )
        )
        tickets = []
        if result and result.value:
            for item in result.value:
                f = item.fields.additional_data if item.fields else {}

                # Parse transcript from JSON string
                transcript_raw = f.get("Transcript", "[]")  # Transcript
                try:
                    transcript = (
                        json.loads(transcript_raw) if transcript_raw else []
                    )
                except (json.JSONDecodeError, TypeError) as exc:
                    logger.warning(
                        "Failed to parse transcript for item %s: %s",
                        item.id,
                        exc,
                    )
                    transcript = []

                tickets.append(
                    {
                        "sharepointId": item.id,
                        "summary": f.get("Title"),
                        "status": f.get("Status"),
                        "category": f.get("Category"),
                        "criticality": f.get("Criticality"),
                        "createdAt": (
                            item.created_date_time.timestamp() * 1000
                            if item.created_date_time
                            else 0
                        ),
                        "transcript": transcript,
                    }
                )
        return {"tickets": tickets}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Ticket search failed for email=%s", email)
        return {"tickets": []}


@app.patch("/api/tickets/status")
async def update_status(
    payload: dict = Body(...), admin: UserContext = Depends(require_admin)
):
    sp_id = payload.get("sharepointId")
    new_status = payload.get("status")
    old_status = payload.get("oldStatus", "Unknown")

    if not sp_id or not new_status:
        raise HTTPException(status_code=400, detail="Missing required fields")

    # Validate SharePoint ID
    validate_sp_id(str(sp_id))

    try:
        # 1. Fetch current ticket data for notification context
        ticket_data = {}
        teams_message_id = None
        try:
            token = credential.get_token("https://graph.microsoft.com/.default").token
            async with httpx.AsyncClient() as client:
                url = f"{GRAPH_BASE}/sites/{SITE_ID}/lists/{LIST_ID}/items/{sp_id}"
                r = await client.get(
                    url,
                    params={"$expand": "fields"},
                    headers={"Authorization": f"Bearer {token}"},
                )
                if r.status_code < 400:
                    raw_item = r.json()
                    f = raw_item.get("fields", {})
                    old_status = f.get("Status", old_status)
                    ticket_data = {
                        "sharepointId": sp_id,
                        "summary": f.get("Title", ""),
                        "category": f.get("Category", "General"),
                        "criticality": f.get("Criticality", "Medium"),
                        "userName": f.get("StaffName", ""),
                        "userEmail": f.get("StaffEmail", ""),
                        "updatedBy": admin.name or admin.email,
                    }

                    # Extract teams_message_id from ThinkingLog
                    thinking_log = f.get("ThinkingLog", "") or ""
                    if "---TEAMS_META---" in thinking_log:
                        try:
                            meta_str = thinking_log.split("---TEAMS_META---")[-1].strip()
                            # Handle case where ADMIN_NOTES comes after TEAMS_META
                            if "---ADMIN_NOTES---" in meta_str:
                                meta_str = meta_str.split("---ADMIN_NOTES---")[0].strip()
                            meta = json.loads(meta_str)
                            teams_message_id = meta.get("teams_message_id")
                        except (json.JSONDecodeError, IndexError):
                            pass
        except Exception as fetch_ex:
            logger.warning("Could not fetch ticket for status notification: %s", fetch_ex)

        # 2. Update the status in SharePoint
        await graph_patch(
            f"/sites/{SITE_ID}/lists/{LIST_ID}/items/{sp_id}/fields",
            {"field_8": new_status},  # Status (Choice dropdown)
        )

        # 3. Send status update notification (fire & forget)
        try:
            from services.notificationService import send_status_update_notification

            await send_status_update_notification(
                graph_client, ticket_data, old_status, new_status, teams_message_id
            )
        except Exception as notify_ex:
            logger.warning("Status update notification failed: %s", notify_ex)

        return {"success": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Status update failed for sp_id=%s", sp_id)
        raise HTTPException(status_code=500, detail="Failed to update status")


@app.get("/api/kb/search")
async def search_knowledge_base(
    q: str, user: UserContext = Depends(get_current_user)
):
    """
    Search the KnowledgeBase list in SharePoint.
    Columns: Title (Question), Category, Answer, Keywords
    """
    kb_list_id = os.getenv(
        "SHAREPOINT_KB_LIST_ID", "a035c017-edee-4923-9277-ecf7d080eaee"
    )

    try:
        result = (
            await graph_client.sites.by_site_id(SITE_ID)
            .lists.by_list_id(kb_list_id)
            .items.get(
                request_configuration=lambda x: (
                    setattr(x.query_parameters, "expand", ["fields"]),
                    setattr(x.query_parameters, "top", 50),
                )
            )
        )

        articles = []
        if result and result.value:
            for item in result.value:
                f = item.fields.additional_data if item.fields else {}
                title = f.get("Title", "")
                cat = f.get("Category", "General")
                answer = f.get("Answer", "")
                keywords = f.get("Keywords", "")

                # Loose matching
                search_term = q.lower()
                if (
                    search_term in title.lower()
                    or search_term in answer.lower()
                    or search_term in keywords.lower()
                    or search_term in cat.lower()
                ):
                    articles.append(
                        {
                            "id": item.id,
                            "title": title,
                            "category": cat,
                            "content": answer,
                            "keywords": [
                                k.strip()
                                for k in keywords.split(",")
                                if k.strip()
                            ],
                        }
                    )

        return {"articles": articles}
    except Exception as e:
        logger.exception("KB Search Failed")
        return {"articles": []}


@app.post("/api/kb/generate")
async def generate_kb_article(
    payload: dict = Body(...), admin: UserContext = Depends(require_admin)
):
    """
    Generate KB article suggestion from a ticket using server-side Gemini.
    Accepts ticket data and returns suggested Title, Category, Answer, Keywords.
    """
    ticket_summary = payload.get("summary", "")
    category = payload.get("category", "General")
    transcript = payload.get("transcript", [])

    suggestion = await generate_kb_from_ticket(ticket_summary, transcript, category)
    return {"suggestion": suggestion}


@app.post("/api/kb/create")
async def create_kb_article(
    payload: dict = Body(...), admin: UserContext = Depends(require_admin)
):
    """
    Create a new KB article in SharePoint.
    """
    kb_list_id = os.getenv(
        "SHAREPOINT_KB_LIST_ID", "a035c017-edee-4923-9277-ecf7d080eaee"
    )

    try:
        title = payload.get("title")
        category = payload.get("category")
        answer = payload.get("answer")
        keywords = payload.get("keywords", [])

        if not title or not answer:
            raise HTTPException(
                status_code=400, detail="Title and answer are required"
            )

        # Keywords as comma-separated string
        keywords_str = (
            ", ".join(keywords) if isinstance(keywords, list) else keywords
        )

        field_data = {
            "Title": title,
            "Category": category,
            "Answer": answer,
            "Keywords": keywords_str,
        }

        result = await graph_post(
            f"/sites/{SITE_ID}/lists/{kb_list_id}/items",
            {"fields": field_data},
        )

        return {"success": True, "id": result.get("id")}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("KB Creation Failed")
        raise HTTPException(
            status_code=500, detail="Failed to create knowledge base article"
        )


# ──────────────────────────────────────────────
# Admin Panel API Endpoints
# ──────────────────────────────────────────────


def _parse_raw_sp_item(raw_item: dict) -> dict:
    """Parse a raw JSON item from Graph REST API into admin ticket dict."""
    f = raw_item.get("fields", {})

    transcript_raw = f.get("Transcript", "[]")
    try:
        transcript = json.loads(transcript_raw) if transcript_raw else []
    except (json.JSONDecodeError, TypeError):
        transcript = []

    thinking_log = f.get("ThinkingLog", "") or ""
    admin_notes = []
    if "---ADMIN_NOTES---" in thinking_log:
        parts = thinking_log.split("---ADMIN_NOTES---")
        thinking_log_clean = parts[0].strip()
        try:
            admin_notes = json.loads(parts[1].strip()) if len(parts) > 1 else []
        except (json.JSONDecodeError, TypeError):
            admin_notes = []
    else:
        thinking_log_clean = thinking_log

    return {
        "sharepointId": raw_item.get("id", ""),
        "summary": f.get("Title", ""),
        "status": f.get("Status", "New"),
        "category": f.get("Category", "General"),
        "criticality": f.get("Criticality", "Medium"),
        "userName": f.get("StaffName", ""),
        "userEmail": f.get("StaffEmail", ""),
        "userPhone": str(f.get("StaffPhone", "")) if f.get("StaffPhone") else "",
        "location": f.get("Location", ""),
        "availability": f.get("Availability", ""),
        "thinkingLog": thinking_log_clean,
        "transcript": transcript,
        "createdDateTime": raw_item.get("createdDateTime", ""),
        "adminNotes": admin_notes,
    }


async def _fetch_all_sp_tickets(
    status_filter: Optional[str] = None,
    category_filter: Optional[str] = None,
    top: int = 50,
    skip: int = 0,
) -> tuple:
    """Fetch tickets from SharePoint with optional filters. Returns (items, raw_data)."""
    token = credential.get_token("https://graph.microsoft.com/.default").token

    params = {
        "$expand": "fields",
        "$top": str(top),
        "$skip": str(skip),
        "$orderby": "createdDateTime desc",
    }

    filters = []
    if status_filter:
        filters.append(f"fields/field_8 eq '{status_filter}'")
    if category_filter:
        filters.append(f"fields/field_1 eq '{category_filter}'")
    if filters:
        params["$filter"] = " and ".join(filters)

    async with httpx.AsyncClient() as client:
        url = f"{GRAPH_BASE}/sites/{SITE_ID}/lists/{LIST_ID}/items"
        r = await client.get(
            url,
            params=params,
            headers={
                "Authorization": f"Bearer {token}",
                "Prefer": "HonorNonIndexedQueriesWarningMayFailRandomly",
            },
        )
        if r.status_code >= 400:
            logger.error("Graph GET tickets returned %d: %s", r.status_code, r.text)
            raise HTTPException(
                status_code=r.status_code, detail="Failed to fetch tickets"
            )
        data = r.json()

    return data.get("value", []), data


@app.get("/api/admin/tickets")
async def admin_get_tickets(
    status: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    top: int = Query(50, ge=1, le=200),
    skip: int = Query(0, ge=0),
    admin: UserContext = Depends(require_admin),
):
    """Fetch ALL tickets from SharePoint for the admin panel."""
    try:
        raw_items, raw_data = await _fetch_all_sp_tickets(
            status_filter=status,
            category_filter=category,
            top=top,
            skip=skip,
        )
        tickets = [_parse_raw_sp_item(item) for item in raw_items]

        # Approximate total — Graph API doesn't always return @odata.count
        total_hint = skip + len(tickets)
        if len(tickets) == top:
            total_hint = skip + top + 1  # Signal there may be more

        return {"tickets": tickets, "total": total_hint}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Admin tickets fetch failed")
        raise HTTPException(status_code=500, detail="Failed to fetch tickets")


@app.get("/api/admin/tickets/{item_id}")
async def admin_get_ticket(
    item_id: str,
    admin: UserContext = Depends(require_admin),
):
    """Fetch a single ticket by SharePoint item ID."""
    validate_sp_id(item_id)

    try:
        token = credential.get_token("https://graph.microsoft.com/.default").token
        async with httpx.AsyncClient() as client:
            url = f"{GRAPH_BASE}/sites/{SITE_ID}/lists/{LIST_ID}/items/{item_id}"
            r = await client.get(
                url,
                params={"$expand": "fields"},
                headers={"Authorization": f"Bearer {token}"},
            )
            if r.status_code == 404:
                raise HTTPException(status_code=404, detail="Ticket not found")
            if r.status_code >= 400:
                logger.error(
                    "Graph GET ticket/%s returned %d", item_id, r.status_code
                )
                raise HTTPException(
                    status_code=r.status_code, detail="Failed to fetch ticket"
                )
            raw_item = r.json()

        return _parse_raw_sp_item(raw_item)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Admin single ticket fetch failed for id=%s", item_id)
        raise HTTPException(status_code=500, detail="Failed to fetch ticket")


@app.patch("/api/admin/tickets/{item_id}")
async def admin_update_ticket(
    item_id: str,
    payload: dict = Body(...),
    admin: UserContext = Depends(require_admin),
):
    """Update ticket fields: status, criticality, category."""
    validate_sp_id(item_id)

    field_updates = {}
    if "status" in payload:
        field_updates["field_8"] = payload["status"]
    if "criticality" in payload:
        field_updates["field_7"] = payload["criticality"]
    if "category" in payload:
        field_updates["field_1"] = payload["category"]

    if not field_updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    try:
        await graph_patch(
            f"/sites/{SITE_ID}/lists/{LIST_ID}/items/{item_id}/fields",
            field_updates,
        )
        return {"success": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Admin ticket update failed for id=%s", item_id)
        raise HTTPException(status_code=500, detail="Failed to update ticket")


@app.post("/api/admin/tickets/{item_id}/notes")
async def admin_add_note(
    item_id: str,
    payload: dict = Body(...),
    admin: UserContext = Depends(require_admin),
):
    """Add timestamped admin note to a ticket's ThinkingLog field."""
    validate_sp_id(item_id)

    note_text = payload.get("note", "").strip()
    author = payload.get("author", admin.name or admin.email).strip()
    if not note_text:
        raise HTTPException(status_code=400, detail="Note text is required")

    try:
        # 1. Fetch current ThinkingLog
        token = credential.get_token("https://graph.microsoft.com/.default").token
        async with httpx.AsyncClient() as client:
            url = f"{GRAPH_BASE}/sites/{SITE_ID}/lists/{LIST_ID}/items/{item_id}"
            r = await client.get(
                url,
                params={"$expand": "fields($select=ThinkingLog)"},
                headers={"Authorization": f"Bearer {token}"},
            )
            if r.status_code >= 400:
                raise HTTPException(
                    status_code=r.status_code, detail="Failed to read ticket"
                )
            current_data = r.json()

        fields = current_data.get("fields", {})
        thinking_log = fields.get("ThinkingLog", "") or ""

        # 2. Parse existing admin notes
        admin_notes = []
        base_log = thinking_log
        if "---ADMIN_NOTES---" in thinking_log:
            parts = thinking_log.split("---ADMIN_NOTES---")
            base_log = parts[0].strip()
            try:
                admin_notes = (
                    json.loads(parts[1].strip()) if len(parts) > 1 else []
                )
            except (json.JSONDecodeError, TypeError):
                admin_notes = []

        # 3. Append new note
        new_note = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "author": author,
            "note": note_text,
        }
        admin_notes.append(new_note)

        # 4. Rebuild ThinkingLog with notes section
        updated_log = base_log
        if updated_log:
            updated_log += "\n"
        updated_log += f"---ADMIN_NOTES---\n{json.dumps(admin_notes)}"

        # 5. Patch back
        await graph_patch(
            f"/sites/{SITE_ID}/lists/{LIST_ID}/items/{item_id}/fields",
            {"field_10": updated_log},
        )

        return {"success": True, "note": new_note}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Admin add note failed for id=%s", item_id)
        raise HTTPException(status_code=500, detail="Failed to add note")


@app.get("/api/admin/analytics")
async def admin_analytics(
    admin: UserContext = Depends(require_admin),
):
    """Return aggregated ticket statistics for the admin dashboard."""
    try:
        token = credential.get_token("https://graph.microsoft.com/.default").token

        async with httpx.AsyncClient() as client:
            url = f"{GRAPH_BASE}/sites/{SITE_ID}/lists/{LIST_ID}/items"
            params = {
                "$expand": "fields($select=Title,Status,Category,Criticality,StaffName,StaffEmail)",
                "$top": "500",
                "$orderby": "createdDateTime desc",
            }
            r = await client.get(
                url,
                params=params,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Prefer": "HonorNonIndexedQueriesWarningMayFailRandomly",
                },
            )
            if r.status_code >= 400:
                logger.error(
                    "Analytics fetch returned %d: %s", r.status_code, r.text
                )
                raise HTTPException(
                    status_code=500, detail="Failed to fetch analytics data"
                )
            data = r.json()
            all_tickets = data.get("value", [])

        # Compute aggregates
        total = len(all_tickets)
        today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        open_statuses = {"New", "IT Contacted", "Courier Dispatched"}

        by_status: dict = {}
        by_category: dict = {}
        by_criticality: dict = {}
        open_count = 0
        today_count = 0
        tickets_by_day: dict = {}

        for item in all_tickets:
            f = item.get("fields", {})
            status_val = f.get("Status", "New")
            category_val = f.get("Category", "General")
            criticality_val = f.get("Criticality", "Medium")
            created = item.get("createdDateTime", "")

            by_status[status_val] = by_status.get(status_val, 0) + 1
            by_category[category_val] = by_category.get(category_val, 0) + 1
            by_criticality[criticality_val] = (
                by_criticality.get(criticality_val, 0) + 1
            )

            if status_val in open_statuses:
                open_count += 1

            if created:
                day = created[:10]
                tickets_by_day[day] = tickets_by_day.get(day, 0) + 1
                if day == today_str:
                    today_count += 1

        # Build last 30 days series
        now = datetime.now(timezone.utc)
        day_series = []
        for i in range(29, -1, -1):
            d = (now - timedelta(days=i)).strftime("%Y-%m-%d")
            day_series.append({"date": d, "count": tickets_by_day.get(d, 0)})

        # Recent 5 tickets
        recent = []
        for item in all_tickets[:5]:
            f = item.get("fields", {})
            recent.append(
                {
                    "sharepointId": item.get("id", ""),
                    "summary": f.get("Title", ""),
                    "status": f.get("Status", "New"),
                    "category": f.get("Category", "General"),
                    "criticality": f.get("Criticality", "Medium"),
                    "userName": f.get("StaffName", ""),
                    "userEmail": f.get("StaffEmail", ""),
                    "createdDateTime": item.get("createdDateTime", ""),
                }
            )

        return {
            "total_tickets": total,
            "open_tickets": open_count,
            "tickets_today": today_count,
            "by_status": by_status,
            "by_category": by_category,
            "by_criticality": by_criticality,
            "recent_tickets": recent,
            "tickets_by_day": day_series,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Admin analytics failed")
        raise HTTPException(status_code=500, detail="Failed to compute analytics")


@app.get("/api/admin/routing")
async def admin_get_routing(
    admin: UserContext = Depends(require_admin),
):
    """List all admin routing rules from the Routing SharePoint list."""
    try:
        result = (
            await graph_client.sites.by_site_id(SITE_ID)
            .lists.by_list_id(ROUTING_LIST_ID)
            .items.get(
                request_configuration=lambda x: (
                    setattr(x.query_parameters, "expand", ["fields"]),
                    setattr(x.query_parameters, "top", 50),
                )
            )
        )

        rules = []
        if result and result.value:
            for item in result.value:
                f = item.fields.additional_data if item.fields else {}

                # AdminEmail may be a Person field (dict) or plain text
                admin_email_field = f.get("AdminEmail", "")
                email = ""
                if isinstance(admin_email_field, dict):
                    email = admin_email_field.get("Email") or admin_email_field.get(
                        "LookupValue", ""
                    )
                elif isinstance(admin_email_field, str):
                    email = admin_email_field

                phone = (
                    f.get("PrimaryPhone", "")
                    or f.get("field_5", "")
                    or f.get("field_6", "")
                    or ""
                )
                if isinstance(phone, (int, float)):
                    phone = str(int(phone))

                rules.append(
                    {
                        "id": item.id,
                        "category": f.get("Title", ""),
                        "adminEmail": email,
                        "adminPhone": str(phone),
                        "notifySms": bool(f.get("NotifySMS", False)),
                    }
                )

        return rules
    except Exception as e:
        logger.exception("Admin routing fetch failed")
        raise HTTPException(status_code=500, detail="Failed to fetch routing rules")


@app.patch("/api/admin/routing/{item_id}")
async def admin_update_routing(
    item_id: str,
    payload: dict = Body(...),
    admin: UserContext = Depends(require_admin),
):
    """Update a routing rule (email, phone, notify_sms)."""
    validate_sp_id(item_id)

    field_updates = {}
    if "adminEmail" in payload:
        field_updates["field_2"] = payload["adminEmail"]
    if "adminPhone" in payload:
        field_updates["field_5"] = payload["adminPhone"]
    if "notifySms" in payload:
        field_updates["field_4"] = bool(payload["notifySms"])

    if not field_updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    try:
        await graph_patch(
            f"/sites/{SITE_ID}/lists/{ROUTING_LIST_ID}/items/{item_id}/fields",
            field_updates,
        )
        return {"success": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Admin routing update failed for id=%s", item_id)
        raise HTTPException(status_code=500, detail="Failed to update routing rule")


# ──────────────────────────────────────────────
# Teams Notification Endpoints
# ──────────────────────────────────────────────


@app.post("/api/teams/notify")
async def teams_notify(
    payload: dict = Body(...), admin: UserContext = Depends(require_admin)
):
    """
    Send a ticket notification to the Teams channel.

    Fetches the ticket from SharePoint, builds an Adaptive Card, posts to
    the configured Teams channel, sends a DM to the routed admin, and
    optionally sends an SMS.

    Accepts: {ticket_id: str}  (SharePoint list item ID)
    Returns: {channel_message_id: str|None, dm_sent: bool, sms_sent: bool}
    """
    ticket_id = payload.get("ticket_id")
    if not ticket_id:
        raise HTTPException(status_code=400, detail="ticket_id is required")

    validate_sp_id(str(ticket_id))

    # 1. Fetch ticket from SharePoint
    try:
        token = credential.get_token("https://graph.microsoft.com/.default").token
        async with httpx.AsyncClient() as client:
            url = f"{GRAPH_BASE}/sites/{SITE_ID}/lists/{LIST_ID}/items/{ticket_id}"
            r = await client.get(
                url,
                params={"$expand": "fields"},
                headers={"Authorization": f"Bearer {token}"},
            )
            if r.status_code == 404:
                raise HTTPException(status_code=404, detail="Ticket not found")
            if r.status_code >= 400:
                raise HTTPException(
                    status_code=r.status_code, detail="Failed to fetch ticket"
                )
            raw_item = r.json()
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Teams notify: failed to fetch ticket %s", ticket_id)
        raise HTTPException(status_code=500, detail="Failed to fetch ticket")

    f = raw_item.get("fields", {})
    ticket_data = {
        "sharepointId": ticket_id,
        "summary": f.get("Title", ""),
        "category": f.get("Category", "General"),
        "criticality": f.get("Criticality", "Medium"),
        "userName": f.get("StaffName", ""),
        "userEmail": f.get("StaffEmail", ""),
        "status": f.get("Status", "New"),
        "thinkingLog": f.get("ThinkingLog", ""),
    }

    # Parse transcript for the card
    transcript_raw = f.get("Transcript", "[]")
    try:
        ticket_data["transcript"] = json.loads(transcript_raw) if transcript_raw else []
    except (json.JSONDecodeError, TypeError):
        ticket_data["transcript"] = []

    # 2. Send notification
    try:
        from services.notificationService import send_ticket_notification

        notify_result = await send_ticket_notification(
            graph_client, ticket_data, SITE_ID, ROUTING_LIST_ID
        )

        # Store channel_message_id in ThinkingLog for threading
        channel_message_id = notify_result.get("channel_message_id")
        if channel_message_id:
            thinking_log = f.get("ThinkingLog", "") or ""
            teams_meta = json.dumps({"teams_message_id": channel_message_id})
            updated_thinking = thinking_log
            if "---TEAMS_META---" not in updated_thinking:
                updated_thinking += f"\n---TEAMS_META---\n{teams_meta}"
            try:
                await graph_patch(
                    f"/sites/{SITE_ID}/lists/{LIST_ID}/items/{ticket_id}/fields",
                    {"field_10": updated_thinking},
                )
            except Exception as meta_ex:
                logger.warning(
                    "Failed to store Teams message ID for ticket %s: %s",
                    ticket_id, meta_ex,
                )

        return notify_result
    except Exception as e:
        logger.exception("Teams notify failed for ticket %s", ticket_id)
        # Return partial result — notification failure should not 500
        return {"channel_message_id": None, "dm_sent": False, "sms_sent": False}


@app.post("/api/teams/status-update")
async def teams_status_update(
    payload: dict = Body(...), admin: UserContext = Depends(require_admin)
):
    """
    Send a status update notification to the Teams channel thread.

    Accepts: {
        ticket_id: str,
        old_status: str,
        new_status: str,
        teams_message_id: str | None
    }
    Returns: {success: bool}
    """
    ticket_id = payload.get("ticket_id")
    old_status = payload.get("old_status", "Unknown")
    new_status = payload.get("new_status")
    teams_message_id = payload.get("teams_message_id")

    if not ticket_id or not new_status:
        raise HTTPException(
            status_code=400, detail="ticket_id and new_status are required"
        )

    validate_sp_id(str(ticket_id))

    # Fetch ticket data for notification context
    ticket_data = {
        "sharepointId": ticket_id,
        "updatedBy": admin.name or admin.email,
    }
    try:
        token = credential.get_token("https://graph.microsoft.com/.default").token
        async with httpx.AsyncClient() as client:
            url = f"{GRAPH_BASE}/sites/{SITE_ID}/lists/{LIST_ID}/items/{ticket_id}"
            r = await client.get(
                url,
                params={"$expand": "fields"},
                headers={"Authorization": f"Bearer {token}"},
            )
            if r.status_code < 400:
                raw_item = r.json()
                f = raw_item.get("fields", {})
                ticket_data.update({
                    "summary": f.get("Title", ""),
                    "category": f.get("Category", "General"),
                    "criticality": f.get("Criticality", "Medium"),
                    "userName": f.get("StaffName", ""),
                    "userEmail": f.get("StaffEmail", ""),
                })

                # Try to extract teams_message_id from ThinkingLog if not provided
                if not teams_message_id:
                    thinking_log = f.get("ThinkingLog", "") or ""
                    if "---TEAMS_META---" in thinking_log:
                        try:
                            meta_str = thinking_log.split("---TEAMS_META---")[-1].strip()
                            if "---ADMIN_NOTES---" in meta_str:
                                meta_str = meta_str.split("---ADMIN_NOTES---")[0].strip()
                            meta = json.loads(meta_str)
                            teams_message_id = meta.get("teams_message_id")
                        except (json.JSONDecodeError, IndexError):
                            pass
    except Exception as fetch_ex:
        logger.warning("Could not fetch ticket for status-update notification: %s", fetch_ex)

    try:
        from services.notificationService import send_status_update_notification

        success = await send_status_update_notification(
            graph_client, ticket_data, old_status, new_status, teams_message_id
        )
        return {"success": success}
    except Exception as e:
        logger.exception("Teams status-update notification failed for ticket %s", ticket_id)
        return {"success": False}


@app.post("/api/tickets/{item_id}/resolve")
async def resolve_ticket(
    item_id: str,
    payload: dict = Body(...),
    admin: UserContext = Depends(require_admin),
):
    """
    Mark a ticket as Closed, capture the resolution, and optionally
    generate a KB article suggestion via Gemini.

    Accepts: {resolution: str, generate_kb: bool}
    Returns: {success: bool, kb_suggestion: dict | None}
    """
    validate_sp_id(item_id)

    resolution = payload.get("resolution", "")
    generate_kb = payload.get("generate_kb", False)

    if not resolution:
        raise HTTPException(status_code=400, detail="Resolution text is required")

    # 1. Update status to Closed in SharePoint
    try:
        await graph_patch(
            f"/sites/{SITE_ID}/lists/{LIST_ID}/items/{item_id}/fields",
            {"field_8": "Closed"},  # Status = Closed
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to close ticket %s", item_id)
        raise HTTPException(status_code=500, detail="Failed to close ticket")

    # 2. Fetch ticket data for notification and KB generation
    ticket_data = {"sharepointId": item_id}
    teams_message_id = None
    transcript = []

    try:
        token = credential.get_token("https://graph.microsoft.com/.default").token
        async with httpx.AsyncClient() as client:
            url = f"{GRAPH_BASE}/sites/{SITE_ID}/lists/{LIST_ID}/items/{item_id}"
            r = await client.get(
                url,
                params={"$expand": "fields"},
                headers={"Authorization": f"Bearer {token}"},
            )
            if r.status_code < 400:
                raw_item = r.json()
                f = raw_item.get("fields", {})
                ticket_data.update({
                    "summary": f.get("Title", ""),
                    "category": f.get("Category", "General"),
                    "criticality": f.get("Criticality", "Medium"),
                    "userName": f.get("StaffName", ""),
                    "userEmail": f.get("StaffEmail", ""),
                    "kb_generated": generate_kb,
                })

                # Parse createdDateTime for resolution time calculation
                created_dt = raw_item.get("createdDateTime")
                if created_dt:
                    try:
                        from datetime import datetime as dt_cls
                        created = dt_cls.fromisoformat(created_dt.replace("Z", "+00:00"))
                        ticket_data["createdAt"] = created.timestamp()
                    except Exception:
                        pass

                # Parse transcript for KB generation
                transcript_raw = f.get("Transcript", "[]")
                try:
                    transcript = json.loads(transcript_raw) if transcript_raw else []
                except (json.JSONDecodeError, TypeError):
                    transcript = []

                # Extract teams_message_id
                thinking_log = f.get("ThinkingLog", "") or ""
                if "---TEAMS_META---" in thinking_log:
                    try:
                        meta_str = thinking_log.split("---TEAMS_META---")[-1].strip()
                        if "---ADMIN_NOTES---" in meta_str:
                            meta_str = meta_str.split("---ADMIN_NOTES---")[0].strip()
                        meta = json.loads(meta_str)
                        teams_message_id = meta.get("teams_message_id")
                    except (json.JSONDecodeError, IndexError):
                        pass
    except Exception as fetch_ex:
        logger.warning("Could not fetch ticket for resolve notification: %s", fetch_ex)

    # 3. Send resolution notification to Teams (fire & forget)
    try:
        from services.notificationService import send_resolution_notification

        await send_resolution_notification(
            graph_client, ticket_data, resolution, teams_message_id
        )
    except Exception as notify_ex:
        logger.warning("Resolution notification failed for ticket %s: %s", item_id, notify_ex)

    # 4. Generate KB article if requested
    kb_suggestion = None
    if generate_kb:
        try:
            summary = ticket_data.get("summary", "")
            category = ticket_data.get("category", "General")

            suggestion = await generate_kb_from_ticket(summary, transcript, category)
            kb_suggestion = suggestion
        except Exception as kb_ex:
            logger.warning("KB generation failed for ticket %s: %s", item_id, kb_ex)
            # Return a fallback suggestion
            kb_suggestion = {
                "title": ticket_data.get("summary", ""),
                "category": ticket_data.get("category", "General"),
                "answer": f"Resolution: {resolution}",
                "keywords": [ticket_data.get("category", "general").lower()],
            }

    return {"success": True, "kb_suggestion": kb_suggestion}


# --- 6. Serve Frontend ---
# This looks for a 'dist' folder (standard React build output)
if os.path.exists("dist"):
    app.mount("/", StaticFiles(directory="dist", html=True), name="static")

    @app.exception_handler(404)
    async def not_found_handler(request: Request, exc: HTTPException):
        # Always serve index.html for 404s to support React Router
        return FileResponse("dist/index.html")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
