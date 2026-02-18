"""
Adaptive Card templates for Microsoft Teams notifications.

Builds schema 1.4 compliant cards for:
- New ticket notifications (with priority badges, security banners)
- Status change updates (compact threaded replies)
- Resolution notifications (with KB article badges)

Environment variables used:
- PORTAL_URL: Base URL of the IT Support Portal
                (default: https://lotus-itsp-bridge.azurewebsites.net)
"""

import os
import json
import logging

logger = logging.getLogger("lotus_it")

PORTAL_URL = os.getenv("PORTAL_URL", "https://lotus-itsp-bridge.azurewebsites.net")

# Priority badge colors
_PRIORITY_COLORS = {
    "P1": "attention",   # red
    "P2": "warning",     # orange/amber
    "P3": "accent",      # yellow/blue
    "P4": "default",     # grey
}

_PRIORITY_HEX = {
    "P1": "#D13438",
    "P2": "#FF8C00",
    "P3": "#FFB900",
    "P4": "#8A8886",
}


def _extract_priority(ticket_data: dict) -> str:
    """Extract priority from ticket data or thinking log LAIT metadata."""
    priority = ticket_data.get("priority")
    if priority:
        return priority

    # Try to extract from thinkingLog LAIT_META
    thinking_log = ticket_data.get("thinkingLog", "") or ""
    if "---LAIT_META---" in thinking_log:
        try:
            meta_str = thinking_log.split("---LAIT_META---")[-1].strip()
            meta = json.loads(meta_str)
            return meta.get("priority", "P4") or "P4"
        except (json.JSONDecodeError, IndexError):
            pass
    return "P4"


def _extract_security_flag(ticket_data: dict) -> bool:
    """Extract security flag from ticket data or thinking log LAIT metadata."""
    if ticket_data.get("securityFlag"):
        return True

    thinking_log = ticket_data.get("thinkingLog", "") or ""
    if "---LAIT_META---" in thinking_log:
        try:
            meta_str = thinking_log.split("---LAIT_META---")[-1].strip()
            meta = json.loads(meta_str)
            return bool(meta.get("security_flag", False))
        except (json.JSONDecodeError, IndexError):
            pass
    return False


def _get_last_user_message(ticket_data: dict) -> str:
    """Extract last user message from transcript, truncated to 200 chars."""
    transcript = ticket_data.get("transcript", [])
    if isinstance(transcript, str):
        try:
            transcript = json.loads(transcript)
        except (json.JSONDecodeError, TypeError):
            return ""

    # Walk backwards to find the last user message
    for msg in reversed(transcript):
        if isinstance(msg, dict) and msg.get("role") == "user":
            content = msg.get("content", "")
            if len(content) > 200:
                return content[:200] + "..."
            return content
    return ""


def _wrap_in_adaptive_card(body: list, actions: list = None) -> dict:
    """Wrap body elements in a valid Adaptive Card schema 1.4 envelope."""
    card = {
        "type": "AdaptiveCard",
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "version": "1.4",
        "body": body,
    }
    if actions:
        card["actions"] = actions
    return card


def build_new_ticket_card(ticket_data: dict) -> dict:
    """
    Build an Adaptive Card (schema 1.4) for a new ticket notification.

    Includes:
    - Red/orange header banner with "New IT Incident"
    - Priority badge (P1=red, P2=orange, P3=yellow, P4=grey)
    - Security incident banner if flagged
    - Fact set: Category, Criticality, Staff Name, Email, Summary
    - Last user message preview (200 chars)
    - Action buttons: View in Portal, Contact Staff via Teams
    """
    priority = _extract_priority(ticket_data)
    security_flag = _extract_security_flag(ticket_data)
    last_message = _get_last_user_message(ticket_data)

    category = ticket_data.get("category", "General")
    criticality = ticket_data.get("criticality", "Medium")
    staff_name = ticket_data.get("userName") or ticket_data.get("staffName", "Unknown")
    staff_email = ticket_data.get("userEmail") or ticket_data.get("staffEmail", "")
    summary = ticket_data.get("summary", "No summary provided")
    ticket_id = ticket_data.get("sharepointId") or ticket_data.get("id", "N/A")

    # Determine banner color based on criticality
    banner_color = "attention" if criticality == "High" else "warning"
    priority_color = _PRIORITY_HEX.get(priority, "#8A8886")

    body = []

    # Security incident banner (if applicable)
    if security_flag:
        body.append({
            "type": "Container",
            "style": "attention",
            "bleed": True,
            "items": [
                {
                    "type": "TextBlock",
                    "text": "SECURITY INCIDENT",
                    "weight": "bolder",
                    "size": "medium",
                    "color": "light",
                    "horizontalAlignment": "center",
                }
            ],
        })

    # Header banner
    body.append({
        "type": "Container",
        "style": banner_color,
        "bleed": True,
        "items": [
            {
                "type": "ColumnSet",
                "columns": [
                    {
                        "type": "Column",
                        "width": "stretch",
                        "items": [
                            {
                                "type": "TextBlock",
                                "text": "New IT Incident",
                                "weight": "bolder",
                                "size": "large",
                                "color": "light",
                            }
                        ],
                    },
                    {
                        "type": "Column",
                        "width": "auto",
                        "items": [
                            {
                                "type": "TextBlock",
                                "text": f"#{ticket_id}",
                                "weight": "bolder",
                                "color": "light",
                                "horizontalAlignment": "right",
                            }
                        ],
                    },
                ],
            }
        ],
    })

    # Priority badge
    body.append({
        "type": "ColumnSet",
        "spacing": "medium",
        "columns": [
            {
                "type": "Column",
                "width": "auto",
                "items": [
                    {
                        "type": "Container",
                        "style": _PRIORITY_COLORS.get(priority, "default"),
                        "items": [
                            {
                                "type": "TextBlock",
                                "text": f"Priority: {priority}",
                                "weight": "bolder",
                                "size": "small",
                                "color": "light",
                            }
                        ],
                    }
                ],
            },
            {
                "type": "Column",
                "width": "stretch",
                "items": [
                    {
                        "type": "TextBlock",
                        "text": f"Criticality: {criticality}",
                        "weight": "bolder",
                        "size": "small",
                    }
                ],
                "verticalContentAlignment": "center",
            },
        ],
    })

    # Fact set
    body.append({
        "type": "FactSet",
        "spacing": "medium",
        "facts": [
            {"title": "Category", "value": category},
            {"title": "Criticality", "value": criticality},
            {"title": "Staff Name", "value": staff_name},
            {"title": "Staff Email", "value": staff_email},
            {"title": "Summary", "value": summary},
        ],
    })

    # Last user message preview
    if last_message:
        body.append({
            "type": "Container",
            "spacing": "medium",
            "items": [
                {
                    "type": "TextBlock",
                    "text": "Latest from user:",
                    "weight": "bolder",
                    "size": "small",
                    "isSubtle": True,
                },
                {
                    "type": "TextBlock",
                    "text": last_message,
                    "wrap": True,
                    "size": "small",
                },
            ],
        })

    # Action buttons
    actions = [
        {
            "type": "Action.OpenUrl",
            "title": "View in Portal",
            "url": f"{PORTAL_URL}",
        },
    ]

    if staff_email:
        actions.append({
            "type": "Action.OpenUrl",
            "title": "Contact Staff via Teams",
            "url": f"https://teams.microsoft.com/l/chat/0/0?users={staff_email}",
        })

    return _wrap_in_adaptive_card(body, actions)


def build_status_update_card(ticket_data: dict, old_status: str, new_status: str) -> dict:
    """
    Build a compact Adaptive Card for a ticket status change.

    Includes:
    - Status transition: old -> new
    - Updated by: admin name (if available)
    - Quick facts: Category, Staff Name
    """
    ticket_id = ticket_data.get("sharepointId") or ticket_data.get("id", "N/A")
    category = ticket_data.get("category", "General")
    staff_name = ticket_data.get("userName") or ticket_data.get("staffName", "Unknown")
    admin_name = ticket_data.get("updatedBy", "Admin")

    body = [
        {
            "type": "TextBlock",
            "text": f"Ticket #{ticket_id} status changed: {old_status} \u2192 {new_status}",
            "weight": "bolder",
            "size": "medium",
            "wrap": True,
        },
        {
            "type": "FactSet",
            "spacing": "small",
            "facts": [
                {"title": "Updated by", "value": admin_name},
                {"title": "Category", "value": category},
                {"title": "Staff Name", "value": staff_name},
            ],
        },
    ]

    actions = [
        {
            "type": "Action.OpenUrl",
            "title": "View in Portal",
            "url": f"{PORTAL_URL}",
        },
    ]

    return _wrap_in_adaptive_card(body, actions)


def build_resolution_card(ticket_data: dict, resolution_text: str) -> dict:
    """
    Build an Adaptive Card for a ticket resolution notification.

    Includes:
    - Green "Ticket Resolved" banner
    - Resolution summary text
    - KB Article Generated badge (if applicable)
    - Facts: Category, Resolution Time (if calculable)
    """
    ticket_id = ticket_data.get("sharepointId") or ticket_data.get("id", "N/A")
    category = ticket_data.get("category", "General")
    summary = ticket_data.get("summary", "")
    kb_generated = ticket_data.get("kb_generated", False)

    # Attempt to calculate resolution time
    created_at = ticket_data.get("createdAt")
    resolution_time = None
    if created_at:
        try:
            import time
            # createdAt is typically epoch millis from frontend
            if isinstance(created_at, (int, float)):
                if created_at > 1e12:
                    created_at = created_at / 1000  # convert ms to seconds
                elapsed = time.time() - created_at
                if elapsed > 0:
                    hours = int(elapsed // 3600)
                    minutes = int((elapsed % 3600) // 60)
                    if hours > 0:
                        resolution_time = f"{hours}h {minutes}m"
                    else:
                        resolution_time = f"{minutes}m"
        except Exception:
            pass

    body = []

    # Green resolved banner
    body.append({
        "type": "Container",
        "style": "good",
        "bleed": True,
        "items": [
            {
                "type": "ColumnSet",
                "columns": [
                    {
                        "type": "Column",
                        "width": "stretch",
                        "items": [
                            {
                                "type": "TextBlock",
                                "text": "Ticket Resolved",
                                "weight": "bolder",
                                "size": "large",
                                "color": "light",
                            }
                        ],
                    },
                    {
                        "type": "Column",
                        "width": "auto",
                        "items": [
                            {
                                "type": "TextBlock",
                                "text": f"#{ticket_id}",
                                "weight": "bolder",
                                "color": "light",
                                "horizontalAlignment": "right",
                            }
                        ],
                    },
                ],
            }
        ],
    })

    # KB badge (if applicable)
    if kb_generated:
        body.append({
            "type": "Container",
            "style": "accent",
            "items": [
                {
                    "type": "TextBlock",
                    "text": "KB Article Generated",
                    "weight": "bolder",
                    "size": "small",
                    "color": "light",
                    "horizontalAlignment": "center",
                }
            ],
        })

    # Summary
    body.append({
        "type": "TextBlock",
        "text": f"**{summary}**",
        "wrap": True,
        "spacing": "medium",
    })

    # Resolution text
    body.append({
        "type": "TextBlock",
        "text": "**Resolution:**",
        "spacing": "medium",
        "size": "small",
        "isSubtle": True,
    })
    body.append({
        "type": "TextBlock",
        "text": resolution_text if resolution_text else "No resolution details provided.",
        "wrap": True,
        "size": "small",
    })

    # Facts
    facts = [
        {"title": "Category", "value": category},
    ]
    if resolution_time:
        facts.append({"title": "Resolution Time", "value": resolution_time})

    body.append({
        "type": "FactSet",
        "spacing": "medium",
        "facts": facts,
    })

    actions = [
        {
            "type": "Action.OpenUrl",
            "title": "View in Portal",
            "url": f"{PORTAL_URL}",
        },
    ]

    return _wrap_in_adaptive_card(body, actions)
