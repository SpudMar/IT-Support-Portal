"""
Notification service for Teams channel messages, DMs, SMS, and threaded updates.

Provides:
- Teams channel posting via Power Automate webhook (send_channel_message)
- Threaded replies via webhook (reply_to_channel_message)
- Unified ticket notification (send_ticket_notification)
- Status update notification (send_status_update_notification)
- Resolution notification with KB trigger (send_resolution_notification)
- Direct Teams DMs (send_teams_message) — retained, not used in main flows
- SMS via ClickSend (send_sms) — existing
- Admin routing lookup (get_routing_info) — existing

Channel posting uses a Power Automate HTTP-trigger webhook instead of the
Graph API directly. The Managed Identity has no ChannelMessage.Send grant;
the Power Automate flow owns the Teams connector and posts on our behalf.

Webhook payload sent:  {"card": "<JSON-stringified Adaptive Card>"}
Power Automate flow should:
  Trigger : When an HTTP request is received
  Action  : Post adaptive card in a chat or channel
              Team    : IT Management Team
              Channel : #it-support-tickets
              Card    : @{triggerBody()?['card']}

Required Graph API permissions (Managed Identity):
- Chat.Create, ChatMessage.Send — only needed if DMs are re-enabled

Environment variables:
- TEAMS_WEBHOOK_URL: Power Automate HTTP trigger URL for channel card posting
- TEAMS_TEAM_ID: Kept for reference (no longer used for posting)
- TEAMS_CHANNEL_ID: Kept for reference (no longer used for posting)
- PORTAL_URL: Base URL of the portal (default: https://lotus-itsp-bridge.azurewebsites.net)
- FALLBACK_ADMIN_EMAIL: Fallback admin email when routing lookup fails
- FALLBACK_ADMIN_PHONE: Fallback admin phone when routing lookup fails
- CLICKSEND_USERNAME: ClickSend API username
- CLICKSEND_API_KEY: ClickSend API key
"""

import os
import logging
import httpx
from msgraph import GraphServiceClient
from msgraph.generated.models.chat_message import ChatMessage
from msgraph.generated.models.item_body import ItemBody
from msgraph.generated.models.body_type import BodyType
from msgraph.generated.models.chat import Chat
from msgraph.generated.models.chat_type import ChatType
from msgraph.generated.models.aad_user_conversation_member import AadUserConversationMember
from msgraph.generated.users.users_request_builder import UsersRequestBuilder

from services.teams_cards import (
    build_new_ticket_card,
    build_status_update_card,
    build_resolution_card,
)

logger = logging.getLogger("lotus_it")

# ──────────────────────────────────────────────
# Environment Variables
# ──────────────────────────────────────────────
CLICKSEND_USER = os.getenv("CLICKSEND_USERNAME")
CLICKSEND_KEY = os.getenv("CLICKSEND_API_KEY")

TEAMS_TEAM_ID = os.getenv("TEAMS_TEAM_ID")
TEAMS_CHANNEL_ID = os.getenv("TEAMS_CHANNEL_ID")
TEAMS_WEBHOOK_URL = os.getenv("TEAMS_WEBHOOK_URL")

FALLBACK_ADMIN_EMAIL = os.getenv("FALLBACK_ADMIN_EMAIL", "it@lotusassist.com.au")
FALLBACK_ADMIN_PHONE = os.getenv("FALLBACK_ADMIN_PHONE", "+61402633552")

GRAPH_BASE = "https://graph.microsoft.com/v1.0"


# ──────────────────────────────────────────────
# Internal helpers
# ──────────────────────────────────────────────

async def _post_card_to_webhook(card: dict) -> bool:
    """
    POST an Adaptive Card to the Power Automate HTTP-trigger webhook.

    Payload: {"card": "<JSON-stringified Adaptive Card>"}

    The receiving Power Automate flow posts the card to the
    #it-support-tickets Teams channel via its Teams connector.

    Returns True on 2xx, False otherwise.
    """
    import json

    if not TEAMS_WEBHOOK_URL:
        logger.warning("TEAMS_WEBHOOK_URL not set — skipping channel notification.")
        return False

    payload = {"card": json.dumps(card)}

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            TEAMS_WEBHOOK_URL,
            json=payload,
            headers={"Content-Type": "application/json"},
        )

    if response.status_code >= 400:
        logger.error(
            "Webhook post failed: status=%d body=%s",
            response.status_code, response.text,
        )
        return False

    logger.info("Webhook post succeeded: status=%d", response.status_code)
    return True


# ──────────────────────────────────────────────
# SMS (existing — unchanged)
# ──────────────────────────────────────────────

async def send_sms(to_phone: str, message: str):
    """
    Sends an SMS via ClickSend API.
    """
    if not CLICKSEND_USER or not CLICKSEND_KEY:
        logger.warning("ClickSend credentials missing. Skipping SMS.")
        return False

    url = "https://rest.clicksend.com/v3/sms/send"
    payload = {
        "messages": [
            {
                "source": "LotusIT",
                "body": message,
                "to": to_phone
            }
        ]
    }

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(
                url,
                json=payload,
                auth=(CLICKSEND_USER, CLICKSEND_KEY),
                headers={"Content-Type": "application/json"}
            )
            response.raise_for_status()
            return True
        except Exception as e:
            logger.error("SMS send failed to=%s: %s", to_phone, e)
            return False


# ──────────────────────────────────────────────
# Teams user lookup (existing — unchanged)
# ──────────────────────────────────────────────

async def get_user_id_by_email(graph_client: GraphServiceClient, email: str):
    """
    Look up a user's Entra ID (GUID) using their email.
    """
    try:
        result = await graph_client.users.get(
            request_configuration=lambda x: setattr(
                x.query_parameters, "filter", f"mail eq '{email}'"
            )
        )
        if result and result.value:
            return result.value[0].id
        return None
    except Exception as e:
        logger.error("Failed to find Teams user for email=%s: %s", email, e)
        return None


# ──────────────────────────────────────────────
# Teams DM (existing — unchanged)
# ──────────────────────────────────────────────

async def send_teams_message(graph_client: GraphServiceClient, to_email: str, message: str):
    """
    Sends a direct Teams message (DM) to the specified email.
    Requires: Chat.Create, ChatMessage.Send permissions.
    """
    try:
        # 1. Find User ID
        user_id = await get_user_id_by_email(graph_client, to_email)
        if not user_id:
            logger.warning("Could not find Teams user for email: %s", to_email)
            return False

        # 2. Create one-on-one chat
        request_body = Chat(
            chat_type=ChatType.OneOnOne,
            members=[
                AadUserConversationMember(
                    roles=["owner"],
                    additional_data={
                        "@odata.type": "#microsoft.graph.aadUserConversationMember",
                        "user@odata.bind": f"https://graph.microsoft.com/v1.0/users('{user_id}')"
                    }
                ),
            ]
        )

        chat_result = await graph_client.chats.post(request_body)

        if not chat_result or not chat_result.id:
            return False

        # 3. Send Message
        msg = ChatMessage(
            body=ItemBody(
                content=message,
                content_type=BodyType.Html
            )
        )

        await graph_client.chats.by_chat_id(chat_result.id).messages.post(msg)
        return True

    except Exception as e:
        logger.error("Teams DM send failed to=%s: %s", to_email, e)
        return False


# ──────────────────────────────────────────────
# Admin routing lookup (existing — updated to
# use env-var fallback instead of hardcoded)
# ──────────────────────────────────────────────

async def get_routing_info(graph_client: GraphServiceClient, site_id: str, routing_list_id: str, category: str):
    """
    Returns routing info dict for the given category by querying the
    'AdminRouting' SharePoint list.
    SharePoint fields: Title (Category), field_2 (Person→Email), PrimaryPhone, field_4 (NotifySMS).

    Falls back to FALLBACK_ADMIN_EMAIL / FALLBACK_ADMIN_PHONE env vars.
    """
    # 1. Fallback / Default Data — sourced from environment variables
    fallback = {
        "email": FALLBACK_ADMIN_EMAIL,
        "phone": FALLBACK_ADMIN_PHONE,
    }

    def get_fallback(cat):
        return dict(fallback)

    # 2. If no config, return fallback
    if not site_id or not routing_list_id:
        logger.warning("ROUTING_LIST_ID not set. Using fallback routing.")
        return get_fallback(category)

    # 3. Query SharePoint
    try:
        query_filter = f"fields/Title eq '{category}'"

        result = await graph_client.sites.by_site_id(site_id).lists.by_list_id(routing_list_id).items.get(
            request_configuration=lambda x: (
                setattr(x.query_parameters, "expand", ["fields"]),
                setattr(x.query_parameters, "filter", query_filter)
            )
        )

        if result and result.value:
            item = result.value[0]
            fields = item.fields.additional_data if item.fields else {}

            # field_2 is a Person/Group lookup — SharePoint returns a
            # list of objects: [{"Email": "...", "LookupValue": "..."}]
            admin_email_raw = fields.get("field_2")
            email = None
            if isinstance(admin_email_raw, list) and admin_email_raw:
                email = admin_email_raw[0].get("Email") or admin_email_raw[0].get("LookupValue")
            elif isinstance(admin_email_raw, dict):
                email = admin_email_raw.get("Email") or admin_email_raw.get("LookupValue")
            elif isinstance(admin_email_raw, str):
                email = admin_email_raw

            notify_sms = fields.get("field_4", False)

            # PrimaryPhone — try display name first, then internal field name
            phone = fields.get("PrimaryPhone") or fields.get("field_5")
            # Ensure E.164 format with + prefix for ClickSend
            if phone and isinstance(phone, str):
                phone = phone.strip()
                if not phone.startswith("+"):
                    phone = f"+{phone}"

            return {
                "email": email,
                "phone": phone,
                "notify_sms": notify_sms
            }
        else:
            logger.info("Category '%s' not found in Routing List. Using fallback.", category)
            return get_fallback("General")

    except Exception as e:
        logger.error("Routing lookup failed for category='%s': %s. Using fallback.", category, e)
        return get_fallback(category)


# ──────────────────────────────────────────────
# Teams Channel Messaging (NEW)
# ──────────────────────────────────────────────

async def send_channel_message(card: dict) -> bool:
    """
    Posts an Adaptive Card to the #it-support-tickets Teams channel via
    the Power Automate webhook (TEAMS_WEBHOOK_URL).

    The Power Automate flow receives {"card": "<JSON string>"} and posts
    the card to the channel using its own Teams connector — no Graph API
    permission required on the Managed Identity.

    Args:
        card: Adaptive Card dict (schema 1.4).

    Returns:
        True if the webhook accepted the payload, False otherwise.
    """
    try:
        return await _post_card_to_webhook(card)
    except Exception as e:
        logger.error("send_channel_message exception: %s", e)
        return False


async def reply_to_channel_message(
    message_id: str,
    card: dict,
) -> bool:
    """
    Posts a follow-up card to the channel for an existing ticket thread.

    Note: Power Automate webhook does not expose thread-reply targeting,
    so this posts a new top-level message to the channel. The Adaptive Card
    itself includes the ticket ID and status context. The message_id
    argument is accepted for API compatibility but is not used.

    Args:
        message_id: Original channel message ID (unused — kept for compat).
        card: Adaptive Card dict (schema 1.4).

    Returns:
        True if the webhook accepted the payload, False otherwise.
    """
    try:
        return await _post_card_to_webhook(card)
    except Exception as e:
        logger.error(
            "reply_to_channel_message exception: message_id=%s error=%s",
            message_id, e,
        )
        return False


# ──────────────────────────────────────────────
# Unified Ticket Notification (NEW)
# ──────────────────────────────────────────────

async def send_ticket_notification(
    graph_client: GraphServiceClient,
    ticket_data: dict,
    site_id: str,
    routing_list_id: str,
) -> dict:
    """
    Unified notification for new tickets. Replaces the inline notification
    logic that was previously in main.py's POST /api/tickets endpoint.

    Actions:
    1. Posts an Adaptive Card to the #it-support-tickets Teams channel.
    2. Looks up routing to check if SMS is required, then sends SMS if so.

    DMs to individuals are intentionally omitted — the channel post notifies
    all admins who are members of the channel. The Managed Identity has
    ChannelMessage.Send but not Chat.Create (DM scopes are delegated-only).

    Notification failures are logged but never raised — ticket operations
    must never be blocked by notification errors.

    Args:
        graph_client: Authenticated Graph client.
        ticket_data: Dict with ticket fields (summary, category, criticality, etc.)
        site_id: SharePoint site ID for routing lookup.
        routing_list_id: SharePoint list ID for admin routing.

    Returns:
        Dict with keys: channel_message_id (str|None), dm_sent (bool), sms_sent (bool)
    """
    result = {
        "channel_message_id": None,
        "dm_sent": False,
        "sms_sent": False,
    }

    category = ticket_data.get("category", "General")

    # 1. Post Adaptive Card to #it-support-tickets Teams channel via webhook
    if TEAMS_WEBHOOK_URL:
        try:
            card = build_new_ticket_card(ticket_data)
            posted = await send_channel_message(card)
            if posted:
                result["channel_message_id"] = "webhook"
        except Exception as e:
            logger.error(
                "Channel notification failed for ticket=%s: %s",
                ticket_data.get("sharepointId", "unknown"), e
            )
    else:
        logger.info(
            "TEAMS_WEBHOOK_URL not set — skipping channel notification."
        )

    # 2. SMS if routing rule requires it
    try:
        admin_info = await get_routing_info(
            graph_client, site_id, routing_list_id, category
        )
    except Exception as e:
        logger.error("Routing lookup failed during notification: %s", e)
        admin_info = {"phone": FALLBACK_ADMIN_PHONE, "notify_sms": False}

    admin_phone = admin_info.get("phone") if admin_info else None
    notify_sms = admin_info.get("notify_sms", False) if admin_info else False
    if admin_phone and notify_sms:
        try:
            criticality = ticket_data.get("criticality", "Medium")
            summary = ticket_data.get("summary", "No summary")
            user_name = ticket_data.get("userName", "Unknown")

            sms_text = (
                f"New {criticality} Ticket: "
                f"{summary} ({user_name})"
            )

            sms_sent = await send_sms(admin_phone, sms_text)
            result["sms_sent"] = sms_sent
        except Exception as e:
            logger.error(
                "SMS notification failed for phone=%s ticket=%s: %s",
                admin_phone, ticket_data.get("sharepointId", "unknown"), e
            )

    return result


# ──────────────────────────────────────────────
# Status Update Notification (NEW)
# ──────────────────────────────────────────────

async def send_status_update_notification(
    graph_client: GraphServiceClient,
    ticket_data: dict,
    old_status: str,
    new_status: str,
    teams_message_id: str | None,
) -> bool:
    """
    Posts a status update card to the #it-support-tickets channel thread.

    If teams_message_id exists, replies to the original thread. Otherwise
    posts a new channel message. DMs to individuals are omitted — the
    channel thread is the single source of truth for ticket updates.

    Notification failures are logged but never raised.

    Args:
        graph_client: Authenticated Graph client.
        ticket_data: Dict with ticket fields.
        old_status: Previous ticket status.
        new_status: New ticket status.
        teams_message_id: ID of the original channel message for threading (or None).

    Returns:
        True if the notification was sent, False otherwise.
    """
    any_sent = False
    card = build_status_update_card(ticket_data, old_status, new_status)

    # Post to channel via webhook
    if TEAMS_WEBHOOK_URL:
        try:
            sent = await (
                reply_to_channel_message(teams_message_id, card)
                if teams_message_id
                else send_channel_message(card)
            )
            if sent:
                any_sent = True
        except Exception as e:
            logger.error(
                "Status update channel notification failed for ticket=%s: %s",
                ticket_data.get("sharepointId", "unknown"), e
            )

    return any_sent


# ──────────────────────────────────────────────
# Resolution Notification (NEW)
# ──────────────────────────────────────────────

async def send_resolution_notification(
    graph_client: GraphServiceClient,
    ticket_data: dict,
    resolution_text: str,
    teams_message_id: str | None,
) -> bool:
    """
    Posts a resolution card to the #it-support-tickets channel thread.

    Posts as a thread reply if teams_message_id is available, otherwise
    posts a new channel message. DMs to individuals are omitted — the
    channel thread is the single source of truth for ticket lifecycle.

    Notification failures are logged but never raised.

    Args:
        graph_client: Authenticated Graph client.
        ticket_data: Dict with ticket fields.
        resolution_text: Free-text resolution description.
        teams_message_id: ID of the original channel message for threading (or None).

    Returns:
        True if the notification was sent, False otherwise.
    """
    any_sent = False
    card = build_resolution_card(ticket_data, resolution_text)

    # Post to channel via webhook
    if TEAMS_WEBHOOK_URL:
        try:
            sent = await (
                reply_to_channel_message(teams_message_id, card)
                if teams_message_id
                else send_channel_message(card)
            )
            if sent:
                any_sent = True
        except Exception as e:
            logger.error(
                "Resolution channel notification failed for ticket=%s: %s",
                ticket_data.get("sharepointId", "unknown"), e
            )

    return any_sent
