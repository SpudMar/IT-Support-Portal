
import os
import httpx
from msgraph import GraphServiceClient
from msgraph.generated.models.chat_message import ChatMessage
from msgraph.generated.models.item_body import ItemBody
from msgraph.generated.models.body_type import BodyType
from msgraph.generated.models.chat import Chat
from msgraph.generated.models.chat_type import ChatType
from msgraph.generated.models.aad_user_conversation_member import AadUserConversationMember
from msgraph.generated.users.users_request_builder import UsersRequestBuilder

# Environment Variables
CLICKSEND_USER = os.getenv("CLICKSEND_USERNAME")
CLICKSEND_KEY = os.getenv("CLICKSEND_API_KEY")

async def send_sms(to_phone: str, message: str):
    """
    Sends an SMS via ClickSend API.
    """
    if not CLICKSEND_USER or not CLICKSEND_KEY:
        print("ClickSend credentials missing. Skipping SMS.")
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
            print(f"SMS Failed: {e}")
            return False

async def get_user_id_by_email(graph_client: GraphServiceClient, email: str):
    """
    Look up a user's Entra ID (GUID) using their email.
    """
    try:
        # Note: In Graph SDK v1.0, filtering users can be tricky with the fluent API.
        # We will try a direct request if the SDK wrapper is too complex, 
        # but here we attempt standard SDK usage.
        result = await graph_client.users.get(request_configuration=lambda x: setattr(x.query_parameters, "filter", f"mail eq '{email}'"))
        if result and result.value:
            return result.value[0].id
        return None
    except Exception as e:
        print(f"Failed to find user {email}: {e}")
        return None

async def send_teams_message(graph_client: GraphServiceClient, to_email: str, message: str):
    """
    Sends a direct Teams message to the specified email.
    Requires: Chat.Create, ChatMessage.Send permissions.
    """
    try:
        # 1. Find User ID
        user_id = await get_user_id_by_email(graph_client, to_email)
        if not user_id:
            print(f"Could not find Teams user for email: {to_email}")
            return False

        # 2. Get 'Me' (The Service Principal / Bot)
        # Note: Service Principals usually can't "Create Chat" easily in delegated scope without Application permissions.
        # Assuming we have 'Chat.Create' Application permission.
        
        # 3. Create Chat
        # For App-to-User chat, we need to specify members installation details or use specific Graph calls.
        # Simplest path for 'Application' permission: /chats
        
        request_body = Chat(
            chat_type=ChatType.OneOnOne,
            members=[
                AadUserConversationMember(
                    roles=["owner"],
                    additional_data={"@odata.type": "#microsoft.graph.aadUserConversationMember", "user@odata.bind": f"https://graph.microsoft.com/v1.0/users('{user_id}')"}
                ),
                # The App itself is automatically added if we verify installed app, but for pure API calls we might need to rely on existing chats or specific install flow.
                # However, for Service Principals, creating a chat directly is supported if 'Chat.Create' is granted.
                # Usually we also need to add the caller (ourselves). But getting our own ID as an App is distinct.
                # We will try adding just the target user, which often implies "Chat with Me".
            ]
        )
        
        chat_result = await graph_client.chats.post(request_body)
        
        if not chat_result or not chat_result.id:
            return False

        # 4. Send Message
        msg = ChatMessage(
            body=ItemBody(
                content=message,
                content_type=BodyType.Html
            )
        )
        
        await graph_client.chats.by_chat_id(chat_result.id).messages.post(msg)
        return True

    except Exception as e:
        print(f"Teams Send Failed: {e}")
        return False

async def get_routing_info(graph_client: GraphServiceClient, site_id: str, routing_list_id: str, category: str):
    """
    Returns (email, phone) for the given category by querying the 'AdminRouting' SharePoint list.
    Schema expected: Title (Category), AdminEmail, AdminPhone.
    """
    # 1. Fallback / Default Data
    defaults = {
        "Xero": {"email": "it@lotusassist.com.au", "phone": "+61402633552"},
        "Microsoft 365": {"email": "it@lotusassist.com.au", "phone": "+61402633552"},
        "Hardware": {"email": "it@lotusassist.com.au", "phone": "+61402633552"},
        "General": {"email": "it@lotusassist.com.au", "phone": "+61402633552"}
    }
    
    def get_fallback(cat):
        return defaults.get(cat, defaults["General"])

    # 2. If no config, return fallback
    if not site_id or not routing_list_id:
        print("Warning: ROUTING_LIST_ID not set. Using hardcoded routing.")
        return get_fallback(category)

    # 3. Query SharePoint
    try:
        # Filter: Title equals the category (Standard 'Title' field is usually used for the lookup key)
        # Note: If 'Category' was renamed from Title, the internal name is still 'Title'.
        query_filter = f"fields/Title eq '{category}'"
        
        result = await graph_client.sites.by_site_id(site_id).lists.by_list_id(routing_list_id).items.get(
            request_configuration=lambda x: (
                setattr(x.query_parameters, "expand", ["fields"]),
                setattr(x.query_parameters, "filter", query_filter)
            )
        )
        
        if result and result.value:
            # Match found
            item = result.value[0]
            fields = item.fields.additional_data if item.fields else {}
            
            # AdminEmail is a Person or Group field — Graph API returns a nested object
            # e.g. {"LookupId": 6, "LookupValue": "John Smith", "Email": "john@example.com"}
            admin_email_field = fields.get("AdminEmail")
            email = None
            if isinstance(admin_email_field, dict):
                email = admin_email_field.get("Email") or admin_email_field.get("LookupValue")
            elif isinstance(admin_email_field, str):
                email = admin_email_field

            notify_sms = fields.get("NotifySMS", False)

            return {
                "email": email,
                "phone": None,  # AdminPhone column doesn't exist in list
                "notify_sms": notify_sms
            }
        else:
            # Category not found in list -> Try 'General' from List? Or generic fallback
            print(f"Category '{category}' not found in Routing List. Using fallback.")
            return get_fallback("General")

    except Exception as e:
        print(f"Routing Lookup Failed: {e}. Using fallback.")
        return get_fallback(category)
