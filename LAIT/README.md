# LotusAssist IT Support Triage System

AI-powered IT support conversation task for LotusAssist staff. Uses Google Gemini to guide users through reporting and troubleshooting Microsoft 365 Business Premium issues.

## Overview

This system redesigns the Gemini AI conversation task to focus on the **real IT issues** that LotusAssist staff face daily:
- Outlook Classic vs New Outlook confusion
- OneDrive sync stuck/pending
- Software version mismatches (32/64-bit, Click-to-Run channels)
- MFA issues after phone changes
- Firmware and driver problems
- General M365 desktop app pain points

**Key change:** Location and time are **auto-captured** from the system session, **never asked** as conversation questions.

## Project Structure

```
LAIT/
├── gemini-task/
│   ├── system-prompt.md          Core Gemini AI instruction
│   └── conversation-config.json  Model config, rules, SLAs
├── schema/
│   ├── taxonomy.json             9 categories, 50+ sub-categories
│   └── ticket-schema.json        Structured ticket output format
├── self-service/
│   └── resolution-paths.json     25+ step-by-step fix scripts
└── README.md
```

## Categories (9)

| Code | Category | Common Issues |
|------|----------|--------------|
| EMAIL | Email & Calendar | Outlook version confusion, password prompts, shared mailbox, calendar sync |
| FILES | Files & Storage | OneDrive sync, Known Folder Move, file conflicts, storage full |
| SOFTWARE | Software & Apps | Wrong Office version, not updating, activation errors, crashes |
| ACCOUNT | Login & Access | Forgotten password, MFA issues, account lockout, cached credentials |
| TEAMS | Teams & Meetings | Audio/video, screen sharing, notifications, can't join |
| DEVICE | Device & Hardware | Printer, laptop slow, Bluetooth/WiFi, USB, won't boot |
| SECURITY | Security Concern | Phishing, clicked bad link, data breach (always escalate) |
| ACCESS_REQUEST | New Staff / Requests | New staff setup, access to shared resources, software installs |
| NETWORK | Connectivity | Internet down, VPN, WiFi dropping, internal resources |

## Conversation Flow

1. **Greeting** - Uses first name from M365 SSO, warm tone
2. **Problem Capture** - AI classifies from natural language (no menu)
3. **Diagnostic Questions** - Max 3-4 category-specific questions
4. **Self-Service Resolution** - One guided fix attempt (if eligible)
5. **Close** - Resolved or escalated with clear next steps

## Priority Levels

| Level | Label | Criteria | SLA |
|-------|-------|----------|-----|
| P1 | URGENT | Security, multi-user outage, completely blocked | 1 hour |
| P2 | HIGH | Single user blocked, time-sensitive | 4 hours |
| P3 | NORMAL | Single user, workaround available | 24 hours |
| P4 | LOW | Feature request, nice-to-have | 72 hours |

## Auto-Capture (Never Asked)

- **Timestamp** - ISO 8601 with AEST timezone
- **User identity** - Display name and email from M365 SSO
- **Device user-agent** - Browser/device fingerprint
- **Location** - Only captured if user volunteers it naturally (e.g., "I'm working from home")

## Implementation

1. Configure Gemini with `gemini-task/system-prompt.md` as the system instruction
2. Apply settings from `gemini-task/conversation-config.json`
3. The AI references `schema/taxonomy.json` for classification
4. The AI uses `self-service/resolution-paths.json` for guided fixes
5. Every conversation produces a structured JSON ticket per `schema/ticket-schema.json`

## Example Self-Service Fixes

- **Outlook password loop** → Clear Windows Credential Manager
- **OneDrive sync stuck** → Pause/resume, then quit/reopen
- **Office not updating** → File > Account > Update Options > Update Now
- **Teams audio issues** → Check device settings, make test call
- **Laptop slow** → Full restart, check Task Manager
- **Forgotten password** → Guide to https://aka.ms/sspr

## Security & Escalation

**Always escalate immediately (P1):**
- Any security concern (phishing, suspicious link, data breach)
- Account lockouts (AC-03)
- MFA issues with no backup method (AC-02)
- Device won't boot / blue screen (DV-06)
- Multiple users affected (potential outage)

**Never attempt self-service for:**
- Security incidents
- Access requests
- Account administration tasks

## Outage Detection

If 3+ users report the same category within 15 minutes, the system flags a potential service outage and escalates to P1.

## Ticket Output

Every conversation produces a structured JSON ticket with:
- Classification (category, sub-category, confidence)
- Priority with rationale
- Environment details
- Verbatim user description
- Self-service steps attempted
- AI-recommended admin actions
- Plain-language summary for IT admin

## Notes

- Model: `gemini-2.0-flash` with temperature 0.3 for consistent triage
- Locale: Australian English
- Tone: Warm, helpful colleague (not formal helpdesk)
- Messages: 2-3 sentences max per message
- Steps: Presented one at a time, never dumped as a list
