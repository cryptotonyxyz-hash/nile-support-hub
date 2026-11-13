# Nile Merchant Support Hub

A merchant support triage and SLA monitor for [Nile](https://www.usenile.co) (usenile.co), a commerce platform for small merchants. Built as a job application demo for a Support Operations internship at Nile.

**Live demo:** https://nile-support-hub.vercel.app/

## The gap

Nile's merchant support is email-only. A contact form and an email address, no live chat, no phone, no ticket portal, and no way for a merchant to track a request. Their own SLA allows up to 4 hours for a down storefront and 12 hours for a standard enquiry on a non-Premium account.

## What this demo does

Merchant-facing:
- **Ticket portal**: a merchant submits a request (issue, plan tier, description) and gets a tracking ID.
- **Track my request**: a merchant enters a ticket ID or email and sees the status, timeline, and SLA deadline.
- **Live chat**: Nile AI support agent, powered by Google Gemini (model gemini-3-flash-preview). It answers from the Nile support guide, looks up tickets by ID or email, creates tickets into the inbox with auto-triage, and escalates Critical issues (storefront down, checkout broken) to a human. Labelled as an AI demo agent in the chat panel.

Support team-facing:
- **Support inbox**: all tickets with merchant, store, plan tier, channel, category, priority, deadlines, live countdowns, and breach/at-risk flags.
- **Auto-triage**: priority and deadlines computed from issue type and plan tier at intake.
- **Dashboard**: first-response compliance, resolution compliance, open vs resolved, and a Premium vs Standard split.

## Nile's SLA (enforced exactly)

First response, as published on usenile.co/sla:

| Track | Premium / Enterprise | Standard (Starter / Growth) |
|---|---|---|
| Critical (storefront down / checkout broken) | 1 hour | 4 hours |
| Standard (all other enquiries) | 6 hours | 12 hours |

Resolution targets (24h critical, 72h standard) are proposed by this demo, not published by Nile, and are labelled as proposed everywhere they appear.

## Seed data

16 realistic merchant tickets using real store names from Nile's Live Store Samples page (Zluva Fashion, Excess Hair, Miyuki Bakery, Goblin & Coal). Two breached, one at risk, three resolved, the rest open and within SLA. The dashboard shows 80% first-response compliance, Premium 100% vs Standard 60%.

## Run it

Open `index.html` in a browser, or serve the folder with any static server. Everything is client-side except the chat agent; seeded tickets are embedded, and anything a visitor submits during their visit is held in the page so it shows up in the inbox and can be tracked.

## AI agent (`api/chat.js`)

The chat is backed by a Vercel serverless function, `api/chat.js` (plain Node, no dependencies). It calls Gemini `generateContent` with a system prompt built from the Nile support guide above plus the tickets on the page, and with tools for `lookup_ticket`, `create_ticket` and `escalate`. It reads `GEMINI_API_KEY` from the environment; no key is stored in the repo.

To deploy: push to GitHub, then in Vercel add an environment variable named `GEMINI_API_KEY` with a Google AI Studio key, and redeploy. Without the key, the chat shows a "not reachable" message and points visitors to the ticket portal instead. Locally, `node --check api/chat.js` validates the function syntax.

Redeploy note: adding `GEMINI_API_KEY` in Vercel requires a fresh deployment before the chat agent can answer. Git reconnected Nov 13, 2026; Vercel auto-deploy restored after the link dropped.
