# LAIT — Lotus Assist IT Triage Design

Design specification for the Gemini AI-powered IT support triage system, tailored to an M365 Business Premium environment with 20-30 users.

## Architecture

```
LAIT/
├── gemini-task/
│   ├── system-prompt.md           — Core AI instruction set
│   └── conversation-config.json   — Model config, rules, SLAs
├── schema/
│   ├── taxonomy.json              — 9 categories, 50+ sub-categories, keyword maps
│   └── ticket-schema.json         — Structured ticket output JSON Schema
├── self-service/
│   └── resolution-paths.json      — 25+ step-by-step troubleshooting scripts
└── README.md                      — This file
```

## Key Design Decisions

### No Location/Time Questions
User location, availability, and phone number are auto-captured from the M365 session context. The AI never asks for this information.

### Self-Service First
The AI attempts one guided fix before escalating. If the fix works, the conversation closes. If it fails, a ticket is immediately logged with full diagnostic context.

### Security Always Escalates
Any mention of phishing, compromised accounts, malware, or data breaches triggers an immediate P1 escalation. No self-service is attempted for security incidents.

### Outage Detection
If 3+ users report the same issue type, the system flags it as a potential outage and escalates to P1.

### Conversational Tone
The AI speaks like a helpful colleague, not a form. One question at a time. Australian English. No jargon.

## Priority Levels

| Priority | Criteria | SLA |
|---|---|---|
| P1 - Critical | Security, outages, complete work stoppage | 15 min |
| P2 - High | Single user blocked, key app down | 1 hour |
| P3 - Medium | Degraded function, workaround exists | 4 hours |
| P4 - Low | Feature requests, cosmetic, non-urgent | Next business day |

## Issue Categories

1. **Microsoft 365** — Outlook, Teams, SharePoint, OneDrive, Office Apps
2. **Identity & Access** — Password, MFA, SSO, Account Lockout, Conditional Access
3. **Xero** — Login, Bank Feeds, Invoicing, Reports, Integrations
4. **Careview** — Login, Records, Reporting, Performance, Database
5. **enableHR** — Login, Leave, Payroll, Documents
6. **Hardware** — Laptops, Displays, Keyboards, Battery, Docking, Printers, Peripherals
7. **Network & Connectivity** — Wi-Fi, VPN, Internet, DNS
8. **Security** — Phishing, Account Compromise, Malware, Data Breach (always P1)
9. **General** — Software Requests, New User, Offboarding, General Questions

## Integration Points

| Component | File | Integration |
|---|---|---|
| System Prompt | `constants.tsx` | `SYSTEM_INSTRUCTION` constant |
| Taxonomy | `geminiService.ts` | `log_incident` function declaration enums |
| Ticket Schema | `main.py` + `types.ts` | SharePoint field mapping |
| Resolution Paths | `geminiService.ts` | Embedded in system prompt context |
| Conversation Config | `geminiService.ts` | Model and thinking budget settings |
