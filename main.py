
import os
import json
import re
from typing import List, Optional
from fastapi import FastAPI, HTTPException, Body, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

# Azure & Microsoft Graph
from azure.identity import DefaultAzureCredential
from msgraph import GraphServiceClient
# NOTE: Using raw dicts for SP writes instead of ListItem/FieldValueSet SDK objects.
# The SDK's additional_data serialization silently drops fields, causing generalException.

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

app = FastAPI(title="Lotus IT Support Unified Portal")

# --- 1. CORS Setup (Still useful for local dev) ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- 2. Configuration ---
SITE_ID = os.getenv("SHAREPOINT_SITE_ID")
LIST_ID = os.getenv("SHAREPOINT_LIST_ID")
ROUTING_LIST_ID = os.getenv("SHAREPOINT_ROUTING_LIST_ID")

# --- 3. Clients ---
credential = DefaultAzureCredential()
graph_client = GraphServiceClient(credential)

# --- 4. Models ---
class Ticket(BaseModel):
    id: Optional[str] = None
    sharepointId: Optional[str] = None
    summary: str
    userName: str
    userEmail: str
    userPhone: Optional[str] = None
    criticality: str
    status: str
    category: Optional[str] = "General"
    location: Optional[str] = None
    availability: Optional[str] = None
    thinkingLog: Optional[str] = None
    transcript: List[dict]

# --- 5. API Endpoints ---

@app.get("/api/health")
async def health():
    return {"status": "online", "identity": "ManagedIdentity"}

@app.post("/api/tickets")
async def upsert_ticket(ticket: Ticket):
    phone_val = None
    if ticket.userPhone:
        digits = re.sub(r'\D', '', ticket.userPhone)
        if digits:
            # Convert AU mobile to E.164 numeric: 0402... → 61402...
            if digits.startswith('0') and len(digits) == 10:
                digits = '61' + digits[1:]
            elif digits.startswith('61') and len(digits) == 11:
                pass  # Already E.164 without +
            try: phone_val = int(digits)
            except: phone_val = None

    field_data = {
        "Title": ticket.summary,
        "field_1": ticket.category,            # Category
        "field_2": phone_val,                  # StaffPhone (number, E.164)
        "field_3": ticket.userEmail,           # StaffEmail
        "field_4": ticket.userName,            # StaffName
        "field_5": ticket.location,            # Location
        "field_6": ticket.availability,        # Availability
        "field_7": ticket.criticality,         # Criticality
        "field_8": ticket.status,              # Status
        "field_9": json.dumps(ticket.transcript),  # Transcript
        "field_10": ticket.thinkingLog or ""   # ThinkingLog
    }
    # Strip None values — SP rejects explicit nulls on some column types
    field_data = {k: v for k, v in field_data.items() if v is not None}

    try:
        if ticket.sharepointId and ticket.sharepointId != "local":
            await graph_client.sites.by_site_id(SITE_ID).lists.by_list_id(LIST_ID).items.by_list_item_id(ticket.sharepointId).fields.patch(
                body=field_data
            )
            return {"sharepoint_id": ticket.sharepointId}
        else:
            result = await graph_client.sites.by_site_id(SITE_ID).lists.by_list_id(LIST_ID).items.post(
                body={"fields": field_data}
            )
            
            # --- NOTIFICATIONS (Fire & Forget) ---
            # We don't want to block the HTTP response if notifications fail, 
            # so we could wrap this in a background task, but for now we await it quickly.
            try:
                from services.notificationService import get_routing_info, send_sms, send_teams_message
                admin_info = await get_routing_info(graph_client, SITE_ID, ROUTING_LIST_ID, ticket.category)
                
                if admin_info:
                    msg_text = f"🚨 <b>New {ticket.criticality} Ticket</b><br/>User: {ticket.userName}<br/>Issue: {ticket.summary}<br/>Category: {ticket.category}"
                    sms_text = f"New {ticket.criticality} Ticket: {ticket.summary} ({ticket.userName})"
                    
                    # Send Teams
                    if admin_info.get("email"):
                        await send_teams_message(graph_client, admin_info["email"], msg_text)
                    
                    # Send SMS (Only for HIGH or if specifically requested)
                    if admin_info.get("phone") and ticket.criticality.lower() == "high":
                        await send_sms(admin_info["phone"], sms_text)
            except Exception as notify_ex:
                print(f"Notification Error: {notify_ex}")
            # -------------------------------------

            return {"sharepoint_id": result.id}
    except Exception as e:
        import traceback
        print(f"SharePoint Upsert Error: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/tickets/search/{email}")
async def search_tickets(email: str):
    try:
        # StaffEmail is the column name
        query_filter = f"fields/field_3 eq '{email}'"  # field_3 = StaffEmail
        result = await graph_client.sites.by_site_id(SITE_ID).lists.by_list_id(LIST_ID).items.get(
            request_configuration=lambda x: (
                setattr(x.query_parameters, "expand", ["fields"]),
                setattr(x.query_parameters, "filter", query_filter)
            )
        )
        tickets = []
        if result and result.value:
            for item in result.value:
                f = item.fields.additional_data if item.fields else {}
                
                # Parse transcript from JSON string
                transcript_raw = f.get("Transcript", "[]")  # Transcript
                try:
                    transcript = json.loads(transcript_raw) if transcript_raw else []
                except:
                    transcript = []
                
                tickets.append({
                    "sharepointId": item.id,
                    "summary": f.get("Title"),
                    "status": f.get("Status"),
                    "category": f.get("Category"),
                    "criticality": f.get("Criticality"),
                    "createdAt": item.created_date_time.timestamp() * 1000 if item.created_date_time else 0,
                    "transcript": transcript  # Add transcript for resumption
                })
        return {"tickets": tickets}
    except:
        return {"tickets": []}

@app.patch("/api/tickets/status")
async def update_status(payload: dict = Body(...)):
    sp_id = payload.get("sharepointId")
    status = payload.get("status")
    try:
        await graph_client.sites.by_site_id(SITE_ID).lists.by_list_id(LIST_ID).items.by_list_item_id(sp_id).fields.patch(
            body={"field_8": status}  # Status
        )
        return {"success": True}
    except:
        raise HTTPException(status_code=500)

@app.get("/api/kb/search")
async def search_knowledge_base(q: str):
    """
    Search the KnowledgeBase list in SharePoint.
    Columns: Title (Question), Category, Answer, Keywords
    """
    kb_list_id = os.getenv("SHAREPOINT_KB_LIST_ID", "a035c017-edee-4923-9277-ecf7d080eaee")
    
    try:
        # Simple substring search on Title and Keywords
        # Note: SharePoint OData 'substringof' is often limited or requires specific request configuration.
        # For simplicity and robustness, we fetch all (or top X) and filter in Python if list is small, 
        # or use 'startswith' if 'substringof' fails. 
        # Ideally, we should use Microsoft Search API for full text, but List Item API is simpler for small KBs.
        
        # We will try a filter for broad matching or just fetch latest.
        # Given this is a prototype, fetching top 50 and filtering locally is reliable.
        result = await graph_client.sites.by_site_id(SITE_ID).lists.by_list_id(kb_list_id).items.get(
            request_configuration=lambda x: (
                setattr(x.query_parameters, "expand", ["fields"]),
                setattr(x.query_parameters, "top", 50)
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
                if (search_term in title.lower() or 
                    search_term in answer.lower() or 
                    search_term in keywords.lower() or
                    search_term in cat.lower()):
                    
                    articles.append({
                        "id": item.id,
                        "title": title,
                        "category": cat,
                        "content": answer,
                        "keywords": [k.strip() for k in keywords.split(',') if k.strip()]
                    })
        
        return {"articles": articles}
    except Exception as e:
        print(f"KB Search Failed: {e}")
        return {"articles": []}

@app.post("/api/kb/generate")
async def generate_kb_article(payload: dict = Body(...)):
    """
    Generate KB article suggestion from a ticket using Gemini AI.
    Accepts ticket data and returns suggested Title, Category, Answer, Keywords.
    """
    try:
        ticket_summary = payload.get("summary", "")
        transcript = payload.get("transcript", [])
        category = payload.get("category", "General")
        
        # Build context for Gemini
        conversation_text = "\n".join([f"{m.get('role', 'unknown')}: {m.get('content', '')}" for m in transcript])
        
        prompt = f"""Based on this IT support ticket, generate a Knowledge Base article.

Ticket Summary: {ticket_summary}
Category: {category}

Conversation:
{conversation_text}

Generate a JSON response with:
- title: A clear, searchable question (e.g., "How to fix Outlook not syncing?")
- category: One of: Microsoft 365, Xero, Careview, Hardware, Network, General
- answer: Step-by-step solution (200-300 words)
- keywords: Array of 3-5 searchable keywords

Return ONLY valid JSON, no markdown."""

        # Use Gemini to generate suggestion
        import google.generativeai as genai
        genai.configure(api_key=os.getenv("API_KEY"))
        model = genai.GenerativeModel('gemini-2.0-flash-exp')
        response = model.generate_content(prompt)
        
        # Parse response
        suggestion = json.loads(response.text.strip().replace("```json", "").replace("```", ""))
        
        return {"suggestion": suggestion}
    except Exception as e:
        print(f"KB Generation Failed: {e}")
        return {"suggestion": {
            "title": ticket_summary,
            "category": category,
            "answer": "Please provide a detailed solution based on the ticket resolution.",
            "keywords": [category.lower()]
        }}

@app.post("/api/kb/create")
async def create_kb_article(payload: dict = Body(...)):
    """
    Create a new KB article in SharePoint.
    """
    kb_list_id = os.getenv("SHAREPOINT_KB_LIST_ID", "a035c017-edee-4923-9277-ecf7d080eaee")
    
    try:
        title = payload.get("title")
        category = payload.get("category")
        answer = payload.get("answer")
        keywords = payload.get("keywords", [])
        
        # Keywords as comma-separated string
        keywords_str = ", ".join(keywords) if isinstance(keywords, list) else keywords
        
        field_data = {
            "Title": title,
            "Category": category,
            "Answer": answer,
            "Keywords": keywords_str
        }
        
        result = await graph_client.sites.by_site_id(SITE_ID).lists.by_list_id(kb_list_id).items.post(
            body={"fields": field_data}
        )
        
        return {"success": True, "id": result.id}
    except Exception as e:
        print(f"KB Creation Failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

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
