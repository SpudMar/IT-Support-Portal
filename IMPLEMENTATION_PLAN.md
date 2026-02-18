# IT Support Portal — Production Implementation Plan

> **Created:** 2026-02-18 | **Branch:** `claude/redesign-gemini-ai-support-M6bbH`
> **Target:** Live production deployment on Azure Web App `lotus-itsp-bridge`
> **Status:** COMPLETE — All workstreams implemented

---

## Workstreams — All DONE

### WS1: Backend API Authentication + Input Sanitisation [DONE]
- `auth_middleware.py` (279 lines) — Azure AD JWT validation with JWKS caching, key rotation handling
- `get_current_user` dependency on ALL `/api/*` endpoints (except `/api/health`)
- `require_admin` dependency on admin-only endpoints (checks `IT.Admin` role)
- OData injection prevention via `EMAIL_RE` regex validation
- SharePoint ID validation via `SP_ID_RE` numeric check
- CORS locked to `ALLOWED_ORIGIN` env var (default: Azure Web App URL)
- Security headers: `X-Content-Type-Options`, `X-Frame-Options`, `Strict-Transport-Security`, `Referrer-Policy`
- All error details stripped from responses — generic messages only, full details logged server-side

### WS2: Gemini API Moved Server-Side [DONE]
- `services/gemini_backend.py` (445 lines) — `chat_with_gemini`, `chat_with_admin_expert`, `generate_kb_from_ticket`
- `/api/chat` endpoint handles KB search + log_incident function calls server-side
- `/api/chat/admin` endpoint for Gemini Pro admin consultation
- `@google/genai` removed from `package.json` — API key never reaches the browser
- `vite.config.ts` cleaned — no more `define` block
- `services/geminiService.ts` (125 lines) — thin fetch wrapper with auth headers

### WS3: Deployment Pipeline Hardening [DONE]
- `deploy.yml`: `SCM_DO_BUILD_DURING_DEPLOYMENT: 'false'`
- `requirements.txt`: all 12 deps pinned to exact versions
- `startup.sh`: `set -e`, `exec gunicorn`, `--timeout 120`, access/error logging
- `main.py`: startup validation — crashes if required env vars missing
- All `print()` replaced with `logging` module (`lotus_it` logger)
- All bare `except:` replaced with `except Exception as e:` + proper logging

### WS4: Offline Ticket Persistence [DONE]
- `services/offlineStore.ts` (372 lines) — IndexedDB `lotus_it_portal` database
- `OfflineStore` class: `queueTicket`, `getPendingTickets`, `removeTicket`, `getPendingCount`
- `SyncManager` class: automatic sync on `online` event, periodic 30s retry, max 10 attempts per ticket
- `apiService.ts`: `saveTicket` automatically queues to IndexedDB on network/5xx failure
- `App.tsx`: pending count badge in header, auto-refresh when queue drains

### WS5: Admin Auth via Entra ID App Roles [DONE]
- `auth_middleware.py`: `require_admin` checks for `IT.Admin` in JWT `roles` claim
- `App.tsx`: reads `idTokenClaims.roles` for frontend admin detection
- Falls back to string matching for backwards compatibility until Azure Portal roles configured
- **Manual Azure Portal step required:** App Registration → App Roles → Add "IT.Admin" → Assign to admin users

### WS6: Full Admin Panel (Frontend + Backend) [DONE]
- `components/AdminDashboard.tsx` (1,456 lines) — complete rewrite with 4 tabs:
  - **Dashboard:** KPI cards (total, open, today, SLA), bar chart by category, pie chart by status, recent tickets
  - **Tickets:** Full data table with search, status/category/criticality filters, inline status change, detail slide-over
  - **Ticket Detail:** Slide-over panel with info grid, conversation transcript, admin notes timeline, AI consultation, KB generation
  - **Analytics:** Line chart (tickets over 30 days), bar chart by category, pie charts for criticality/status
  - **Routing:** Editable routing rules table (admin email, phone, SMS toggle)
- `components/ui/Toast.tsx` (137 lines) — toast notification system (success/error/info, auto-dismiss)
- Backend: 8 new admin endpoints in `main.py` (GET/PATCH tickets, notes, analytics, routing)
- `apiService.ts`: 8 new admin methods + chatWithAdmin
- `types.ts`: AdminTicket, AdminAnalytics, RoutingRule, AdminNote, KBSuggestion interfaces

### WS7: Teams Integration for Ongoing Comms + KB Building [DONE]
- `services/teams_cards.py` (468 lines) — Adaptive Card v1.4 templates:
  - `build_new_ticket_card`: colour-coded by priority, security banner, action buttons
  - `build_status_update_card`: compact status change notification
  - `build_resolution_card`: green resolution banner with KB badge
- `services/notificationService.py` (743 lines) — enhanced with:
  - `send_channel_message`: posts Adaptive Card to Teams channel
  - `reply_to_channel_message`: threaded replies for status updates
  - `send_ticket_notification`: unified entry point (channel + DM + SMS)
  - `send_status_update_notification`: threads status changes
  - `send_resolution_notification`: posts resolution + optional KB badge
  - Hardcoded contacts replaced with `FALLBACK_ADMIN_EMAIL` / `FALLBACK_ADMIN_PHONE` env vars
- Backend endpoints: `/api/teams/notify`, `/api/teams/status-update`, `/api/tickets/{id}/resolve`
- Ticket creation auto-stores `teams_message_id` in ThinkingLog for threading
- Status updates auto-thread to original channel message

---

## File Changes Summary

### Modified (15 files):
| File | Lines | What Changed |
|------|-------|-------------|
| `main.py` | 1,536 | Auth, Gemini, Teams, admin endpoints, logging, validation |
| `components/AdminDashboard.tsx` | 1,456 | Full rewrite — tabs, charts, detail panel, routing |
| `services/notificationService.py` | 743 | Adaptive Cards, channel posting, threading, resolution |
| `services/apiService.ts` | 301 | Auth headers, offline fallback, admin methods |
| `App.tsx` | 308 | Offline queue UI, role-based admin, ToastProvider |
| `services/geminiService.ts` | 125 | Rewritten as thin fetch wrapper (was SDK client) |
| `types.ts` | 132 | Admin types added |
| `authConfig.ts` | 41 | Shared MSAL instance, API token scope |
| `index.tsx` | 21 | Uses shared msalInstance |
| `vite.config.ts` | 19 | API key define block removed |
| `package.json` | 25 | @google/genai removed |
| `requirements.txt` | 12 | All deps pinned + PyJWT, cryptography, google-genai added |
| `deploy.yml` | 88 | SCM_DO_BUILD_DURING_DEPLOYMENT=false |
| `startup.sh` | 31 | set -e, exec gunicorn, timeout, logging |
| `components/ChatInterface.tsx` | 179 | Updated for server-side Gemini API response shape |

### New Files (7):
| File | Lines | Purpose |
|------|-------|---------|
| `auth_middleware.py` | 279 | Azure AD JWT validation + role guards |
| `services/gemini_backend.py` | 445 | Server-side Gemini AI integration |
| `services/offlineStore.ts` | 372 | IndexedDB offline ticket queue |
| `services/teams_cards.py` | 468 | Adaptive Card templates |
| `components/ui/Toast.tsx` | 137 | Toast notification system |
| `IMPLEMENTATION_PLAN.md` | this file | Implementation tracking |

### Total: ~5,900 lines of production code across 22 files

---

## Environment Variables Required

### Existing (already in Azure App Settings):
- `SHAREPOINT_SITE_ID` — SharePoint site GUID
- `SHAREPOINT_LIST_ID` — Tickets list GUID
- `SHAREPOINT_ROUTING_LIST_ID` — Routing list GUID
- `SHAREPOINT_KB_LIST_ID` — KB list GUID (default fallback in code)
- `API_KEY` / `GEMINI_API_KEY` — Google Gemini API key (now server-only)

### New (add to Azure App Settings):
- `ALLOWED_ORIGIN` — CORS origin (default: `https://lotus-itsp-bridge.azurewebsites.net`)
- `TEAMS_TEAM_ID` — Teams team GUID for IT channel notifications (optional — skip channel if unset)
- `TEAMS_CHANNEL_ID` — Channel GUID within that team
- `PORTAL_URL` — Base URL for "View in Portal" links (default: Azure Web App URL)
- `FALLBACK_ADMIN_EMAIL` — Fallback admin email (default: `it@lotusassist.com.au`)
- `FALLBACK_ADMIN_PHONE` — Fallback admin phone (default: `+61402633552`)

### Azure Portal Manual Steps:
1. **App Registration → App Roles:** Add "IT.Admin" role (value: `IT.Admin`)
2. **Enterprise Applications → Users & Groups:** Assign IT.Admin role to admin users
3. **App Registration → Expose an API:** Add scope `access_as_user` (URI: `api://{client_id}`)
4. **App Registration → API Permissions:** Grant `Chat.Create`, `ChatMessage.Send`, `ChannelMessage.Send`

---

## Continuation Notes

If resuming this work in a future session:
1. Branch: `claude/redesign-gemini-ai-support-M6bbH`
2. Check `git log` for the latest commit
3. All env vars confirmed working as of 2026-02-18
4. Azure subscription is active
5. This file documents every change made and every file touched
6. The security audit findings from the review session are all addressed

---

*Completed: 2026-02-18*
