
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
from msgraph.generated.models.list_item import ListItem
from msgraph.generated.models.field_value_set import FieldValueSet

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
            try: phone_val = int(digits)
            except: phone_val = None

    field_data = {
        "Title": ticket.summary,
        "Category": ticket.category,
        "StaffPhone": phone_val,
        "StaffName": ticket.userName,
        "StaffEmail": ticket.userEmail,
        "Location": ticket.location,
        "Availability": ticket.availability,
        "Criticality": ticket.criticality,
        "Status": ticket.status,
        "Transcript": json.dumps(ticket.transcript),
        "ThinkingLog": ticket.thinkingLog or ""
    }

    try:
        if ticket.sharepointId and ticket.sharepointId != "local":
            fields = FieldValueSet(additional_data=field_data)
            await graph_client.sites.by_site_id(SITE_ID).lists.by_list_id(LIST_ID).items.by_list_item_id(ticket.sharepointId).fields.patch(fields)
            return {"sharepoint_id": ticket.sharepointId}
        else:
            new_item = ListItem(fields=FieldValueSet(additional_data=field_data))
            result = await graph_client.sites.by_site_id(SITE_ID).lists.by_list_id(LIST_ID).items.post(new_item)
            return {"sharepoint_id": result.id}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/tickets/search/{email}")
async def search_tickets(email: str):
    try:
        query_filter = f"fields/StaffEmail eq '{email}'"
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
                tickets.append({
                    "sharepointId": item.id,
                    "summary": f.get("Title"),
                    "status": f.get("Status"),
                    "category": f.get("Category"),
                    "criticality": f.get("Criticality"),
                    "createdAt": item.created_date_time.timestamp() * 1000 if item.created_date_time else 0
                })
        return {"tickets": tickets}
    except:
        return {"tickets": []}

@app.patch("/api/tickets/status")
async def update_status(payload: dict = Body(...)):
    sp_id = payload.get("sharepointId")
    status = payload.get("status")
    try:
        await graph_client.sites.by_site_id(SITE_ID).lists.by_list_id(LIST_ID).items.by_list_item_id(sp_id).fields.patch({"Status": status})
        return {"success": True}
    except:
        raise HTTPException(status_code=500)

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
