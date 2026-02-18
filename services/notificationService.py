"""
Notification service for Teams channel messages, DMs, SMS, and threaded updates.

Provides:
- Teams channel posting with Adaptive Cards (send_channel_message)
- Threaded replies to channel messages (reply_to_channel_message)
- Unified ticket notification (send_ticket_notification)
- Status update threading (send_status_update_notification)
- Resolution notification with KB trigger (send_resolution_notification)
- Direct Teams DMs (send_teams_message) — existing
- SMS via ClickSend (send_sms) — existing
- Admin routing lookup (get_routing_info) — existing

Required Graph API permissions:
- Chat.Create, ChatMessage.Send — for DMs
- ChannelMessage.Send — for channel posts and thread replies

Environment variables:
- TEAMS_TEAM_ID: The Team GUID for IT notification channel posts
- TEAMS_CHANNEL_ID: The Channel GUID within that team
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

FALLBACK_ADMIN_EMAIL = os.getenv("FALLBACK_ADMIN_EMAIL", "it@lotusassist.com.au")
FALLBACK_ADMIN_PHONE = os.getenv("FALLBACK_ADMIN_PHONE", "+61402633552")

GRAPH_BASE = "https://graph.microsoft.com/v1.0"


# ──────────────────────────────────────────────
# Internal helpers
# ──────────────────────────────────────────────

async def _get_graph_token(graph_client: GraphServiceClient) -> str:
    """
    Extract a bearer token from the graph client's credential.

    The GraphServiceClient wraps an Azure credential; we borrow it
    to make direct REST calls for endpoints not well-supported by
    the SDK (e.g., channel message attachments).
    """
    # The credential is stored on the adapter's auth provider
    # For DefaultAzureCredential, we can call get_token directly
    try:
        # Access the credential through the request adapter
        credential = graph_client._request_adapter._authentication_provider._credential
        token = credential.get_token("https://graph.microsoft.com/.default")
        return token.token
    except AttributeError:
        # Fallback: try using the adapter's auth provider directly
        from azure.identity import DefaultAzureCredential
        credential = DefaultAzureCredential()
        token = credential.get_token("https://graph.microsoft.com/.default")
        return token.token


def _build_card_attachment(card: dict) -> dict:
    """
    Wrap an Adaptive Card in the Graph API attachment format
    required for channel messages.
    """
    return {
        "contentType": "application/vnd.microsoft.card.adaptive",
        "content": card,
    }


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
    Schema expected: Title (Category), AdminEmail, AdminPhone, NotifySMS.

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

            # AdminEmail — may be Person/Group field (nested object) or plain text
            admin_email_field = fields.get("AdminEmail")
            email = None
            if isinstance(admin_email_field, dict):
                email = admin_email_field.get("Email") or admin_email_field.get("LookupValue")
            elif isinstance(admin_email_field, str):
                email = admin_email_field

            notify_sms = fields.get("NotifySMS", False)

            # PrimaryPhone — try display name first, then common internal names
            phone = (fields.get("PrimaryPhone")
                     or fields.get("field_5")
                     or fields.get("field_6"))
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

async def send_channel_message(graph_client: GraphServiceClient, team_id: str, channel_id: str, card: dict) -> str | None:
    """
    Posts an Adaptive Card to a Teams channel.

    Uses: POST /teams/{team_id}/channels/{channel_id}/messages
    Requires: ChannelMessage.Send Graph API application permission.

    Args:
        graph_client: Authenticated Microsoft Graph client.
        team_id: GUID of the Teams team.
        channel_id: GUID of the channel within the team.
        card: Adaptive Card dict (schema 1.4).

    Returns:
        The message ID (str) for threading, or None on failure.
    """
    try:
        token = await _get_graph_token(graph_client)
        url = f"{GRAPH_BASE}/teams/{team_id}/channels/{channel_id}/messages"

        payload = {
            "body": {
                "contentType": "html",
                "content": "<attachment id=\"card\"></attachment>",
            },
            "attachments": [
                {
                    "id": "card",
                    "contentType": "application/vnd.microsoft.card.adaptive",
                    "content": str(card) if not isinstance(card, str) else card,
                }
            ],
        }

        # Graph API requires the card content as a JSON string inside the attachment
        import json
        payload["attachments"][0]["content"] = json.dumps(card)

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
            )

            if response.status_code >= 400:
                logger.error(
                    "Channel message post failed: status=%d team=%s channel=%s body=%s",
                    response.status_code, team_id, channel_id, response.text
                )
                return None

            result = response.json()
            message_id = result.get("id")
            logger.info(
                "Channel message posted: message_id=%s team=%s channel=%s",
                message_id, team_id, channel_id
            )
            return message_id

    except Exception as e:
        logger.error(
            "Channel message post exception: team=%s channel=%s error=%s",
            team_id, channel_id, e
        )
        return None


async def reply_to_channel_message(
    graph_client: GraphServiceClient,
    team_id: str,
    channel_id: str,
    message_id: str,
    card: dict,
) -> bool:
    """
    Posts a reply to an existing channel message (threading).

    Uses: POST /teams/{team_id}/channels/{channel_id}/messages/{message_id}/replies
    Requires: ChannelMessage.Send Graph API application permission.

    Handles the case where the original message was deleted by logging
    the error and returning False (does not raise).

    Args:
        graph_client: Authenticated Microsoft Graph client.
        team_id: GUID of the Teams team.
        channel_id: GUID of the channel within the team.
        message_id: ID of the parent message to reply to.
        card: Adaptive Card dict (schema 1.4).

    Returns:
        True if the reply was posted, False otherwise.
    """
    try:
        token = await _get_graph_token(graph_client)
        url = (
            f"{GRAPH_BASE}/teams/{team_id}/channels/{channel_id}"
            f"/messages/{message_id}/replies"
        )

        import json
        payload = {
            "body": {
                "contentType": "html",
                "content": "<attachment id=\"card\"></attachment>",
            },
            "attachments": [
                {
                    "id": "card",
                    "contentType": "application/vnd.microsoft.card.adaptive",
                    "content": json.dumps(card),
                }
            ],
        }

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
            )

            if response.status_code == 404:
                logger.warning(
                    "Original channel message deleted or not found: "
                    "message_id=%s team=%s channel=%s",
                    message_id, team_id, channel_id
                )
                return False

            if response.status_code >= 400:
                logger.error(
                    "Channel reply failed: status=%d message_id=%s body=%s",
                    response.status_code, message_id, response.text
                )
                return False

            logger.info(
                "Channel reply posted: parent_message_id=%s team=%s channel=%s",
                message_id, team_id, channel_id
            )
            return True

    except Exception as e:
        logger.error(
            "Channel reply exception: message_id=%s error=%s",
            message_id, e
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
    1. Looks up admin routing for the ticket's category.
    2. Sends an Adaptive Card to the IT Teams channel (if TEAMS_TEAM_ID set).
    3. Sends a DM to the assigned admin.
    4. Sends an SMS if routing says so.

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

    # 1. Get routing info
    try:
        admin_info = await get_routing_info(
            graph_client, site_id, routing_list_id, category
        )
    except Exception as e:
        logger.error("Routing lookup failed during notification: %s", e)
        admin_info = {
            "email": FALLBACK_ADMIN_EMAIL,
            "phone": FALLBACK_ADMIN_PHONE,
        }

    # 2. Post Adaptive Card to Teams channel (if configured)
    if TEAMS_TEAM_ID and TEAMS_CHANNEL_ID:
        try:
            card = build_new_ticket_card(ticket_data)
            message_id = await send_channel_message(
                graph_client, TEAMS_TEAM_ID, TEAMS_CHANNEL_ID, card
            )
            result["channel_message_id"] = message_id
        except Exception as e:
            logger.error(
                "Channel notification failed for ticket=%s: %s",
                ticket_data.get("sharepointId", "unknown"), e
            )
    else:
        logger.info(
            "TEAMS_TEAM_ID or TEAMS_CHANNEL_ID not set — skipping channel notification."
        )

    # 3. Send DM to assigned admin
    admin_email = admin_info.get("email") if admin_info else None
    if admin_email:
        try:
            criticality = ticket_data.get("criticality", "Medium")
            summary = ticket_data.get("summary", "No summary")
            user_name = ticket_data.get("userName", "Unknown")
            ticket_id = ticket_data.get("sharepointId", "N/A")

            msg_text = (
                f"<b>New {criticality} Ticket #{ticket_id}</b><br/>"
                f"User: {user_name}<br/>"
                f"Issue: {summary}<br/>"
                f"Category: {category}"
            )

            dm_sent = await send_teams_message(graph_client, admin_email, msg_text)
            result["dm_sent"] = dm_sent
        except Exception as e:
            logger.error(
                "DM notification failed for admin=%s ticket=%s: %s",
                admin_email, ticket_data.get("sharepointId", "unknown"), e
            )

    # 4. Send SMS if routing says so
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
    Sends a status update notification to the Teams channel thread and DM.

    If teams_message_id exists and the channel is configured, replies to the
    existing thread. If not, posts a new channel message. Also sends a DM
    to the assigned admin.

    Notification failures are logged but never raised.

    Args:
        graph_client: Authenticated Graph client.
        ticket_data: Dict with ticket fields.
        old_status: Previous ticket status.
        new_status: New ticket status.
        teams_message_id: ID of the original channel message for threading (or None).

    Returns:
        True if at least one notification was sent, False otherwise.
    """
    any_sent = False
    card = build_status_update_card(ticket_data, old_status, new_status)

    # 1. Channel notification (thread or new message)
    if TEAMS_TEAM_ID and TEAMS_CHANNEL_ID:
        try:
            if teams_message_id:
                # Try to reply to the existing thread
                replied = await reply_to_channel_message(
                    graph_client, TEAMS_TEAM_ID, TEAMS_CHANNEL_ID,
                    teams_message_id, card
                )
                if replied:
                    any_sent = True
                else:
                    # Original message was deleted — post a new message
                    logger.info(
                        "Thread reply failed (message may be deleted), posting new message."
                    )
                    new_msg_id = await send_channel_message(
                        graph_client, TEAMS_TEAM_ID, TEAMS_CHANNEL_ID, card
                    )
                    if new_msg_id:
                        any_sent = True
            else:
                # No thread ID — post a new channel message
                new_msg_id = await send_channel_message(
                    graph_client, TEAMS_TEAM_ID, TEAMS_CHANNEL_ID, card
                )
                if new_msg_id:
                    any_sent = True
        except Exception as e:
            logger.error(
                "Status update channel notification failed for ticket=%s: %s",
                ticket_data.get("sharepointId", "unknown"), e
            )

    # 2. DM to admin about the status change
    try:
        admin_email = ticket_data.get("adminEmail") or FALLBACK_ADMIN_EMAIL
        ticket_id = ticket_data.get("sharepointId") or ticket_data.get("id", "N/A")
        summary = ticket_data.get("summary", "")

        dm_text = (
            f"<b>Ticket #{ticket_id} Status Updated</b><br/>"
            f"{old_status} &rarr; {new_status}<br/>"
            f"Summary: {summary}"
        )

        dm_sent = await send_teams_message(graph_client, admin_email, dm_text)
        if dm_sent:
            any_sent = True
    except Exception as e:
        logger.error(
            "Status update DM failed for ticket=%s: %s",
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
    Sends a resolution notification to the Teams channel thread.

    Posts the resolution card as a thread reply (or new message if no
    thread exists). If a resolution text is provided and KB generation
    is flagged in the ticket data, the card will include a KB badge.

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

    # 1. Channel notification (thread or new message)
    if TEAMS_TEAM_ID and TEAMS_CHANNEL_ID:
        try:
            if teams_message_id:
                replied = await reply_to_channel_message(
                    graph_client, TEAMS_TEAM_ID, TEAMS_CHANNEL_ID,
                    teams_message_id, card
                )
                if replied:
                    any_sent = True
                else:
                    logger.info(
                        "Resolution thread reply failed, posting new message."
                    )
                    new_msg_id = await send_channel_message(
                        graph_client, TEAMS_TEAM_ID, TEAMS_CHANNEL_ID, card
                    )
                    if new_msg_id:
                        any_sent = True
            else:
                new_msg_id = await send_channel_message(
                    graph_client, TEAMS_TEAM_ID, TEAMS_CHANNEL_ID, card
                )
                if new_msg_id:
                    any_sent = True
        except Exception as e:
            logger.error(
                "Resolution channel notification failed for ticket=%s: %s",
                ticket_data.get("sharepointId", "unknown"), e
            )

    # 2. DM to admin about resolution
    try:
        admin_email = ticket_data.get("adminEmail") or FALLBACK_ADMIN_EMAIL
        ticket_id = ticket_data.get("sharepointId") or ticket_data.get("id", "N/A")
        summary = ticket_data.get("summary", "")

        dm_text = (
            f"<b>Ticket #{ticket_id} Resolved</b><br/>"
            f"Summary: {summary}<br/>"
            f"Resolution: {resolution_text[:300] if resolution_text else 'N/A'}"
        )

        dm_sent = await send_teams_message(graph_client, admin_email, dm_text)
        if dm_sent:
            any_sent = True
    except Exception as e:
        logger.error(
            "Resolution DM failed for ticket=%s: %s",
            ticket_data.get("sharepointId", "unknown"), e
        )

    return any_sent
