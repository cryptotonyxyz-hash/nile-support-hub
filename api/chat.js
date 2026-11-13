"use strict";
/*
 * Nile AI support agent, Vercel serverless function.
 *
 * POST /api/chat with JSON { message, history, tickets }.
 * Calls Google Gemini (model gemini-3.5-flash) with a system prompt built from
 * the Nile support guide below plus the tickets the visitor can see, and with
 * tools for lookup_ticket, create_ticket and escalate. Any tool calls are
 * executed here, then the model writes the final reply.
 *
 * Returns { reply, ticketUpdates, escalated }.
 * ticketUpdates holds full ticket objects the frontend merges into its inbox
 * and tracking views, so a ticket created in chat visibly flows into the hub.
 *
 * The Gemini API key comes from the GEMINI_API_KEY environment variable.
 * No key is stored in this file. The key is never logged.
 */

var MODEL = "gemini-3-flash-preview";
var API_URL = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent";
var CALL_TIMEOUT_MS = 30000;
var MAX_ROUNDS = 3;

var FR_MIN = { Critical: { Premium: 60, Standard: 240 }, Standard: { Premium: 360, Standard: 720 } };
var RES_MIN = { Critical: 1440, Standard: 4320 };
var CRITICAL_CATS = ["Storefront down", "Checkout or payments broken"];
var CATEGORIES = [
  "Storefront down",
  "Checkout or payments broken",
  "Payouts and refunds",
  "Shipping and delivery",
  "Inventory and products",
  "Account, billing and plans",
  "Domain and store settings",
  "Something else"
];

function trackFor(category) {
  return CRITICAL_CATS.indexOf(category) >= 0 ? "Critical" : "Standard";
}

function priorityFor(track, category) {
  if (track === "Critical") return "Critical";
  if (/payout|refund|charged twice|payment/i.test(category)) return "High";
  return "Normal";
}

function frDeadline(t) {
  var mins = (FR_MIN[t.track] && FR_MIN[t.track][t.plan]) || FR_MIN.Standard.Standard;
  return t.created + mins * 60000;
}

function fmtDT(ts) {
  var d = new Date(ts);
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function minsAgo(created, now) {
  var m = Math.max(0, Math.round((now - created) / 60000));
  if (m < 60) return m + " min ago";
  var h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m ago";
}

/* ---------- Knowledge base: hub content and Nile public facts only ---------- */
function buildSystemPrompt(tickets) {
  var now = Date.now();
  var lines = [];
  lines.push("You are the Nile AI support agent, a demo inside the Nile Merchant Support Hub.");
  lines.push("You help small merchants who sell on Nile (usenile.co), a commerce platform for small merchants.");
  lines.push("You are an AI demo agent, not a human. Never claim to be a human agent.");
  lines.push("Keep replies short, plain and friendly, usually two to four sentences. Give the ticket ID whenever you create or find a ticket.");
  lines.push("");
  lines.push("NILE SUPPORT GUIDE (only use these facts; never invent prices, fees, phone numbers, addresses or refund timelines):");
  lines.push("- Nile support today runs on email at business@nile.ng. This hub is a demo of the missing system: ticket portal, track-my-request, live chat and a support inbox.");
  lines.push("- Plans: Premium, and Standard (Starter / Growth). Plan prices are not published in this demo, so never state a price.");
  lines.push("- First response SLA, published by Nile: Critical track 1 hour on Premium, 4 hours on Standard. Standard track 6 hours on Premium, 12 hours on Standard.");
  lines.push("- Resolution targets are PROPOSED by this project, not published by Nile: 24 hours for Critical, 72 hours for Standard. Always call them proposed when you mention them.");
  lines.push("- Critical means a storefront is down or checkout is completely broken. Everything else is a Standard enquiry.");
  lines.push("- Issue categories: Storefront down, Checkout or payments broken, Payouts and refunds, Shipping and delivery, Inventory and products, Account billing and plans, Domain and store settings, Something else.");
  lines.push("- Checkout runs through Paystack. Payouts run through Flutterwave. Nile also has an AI feature that writes product descriptions.");
  lines.push("- Auto-triage: a ticket is flagged at risk within 30 minutes of its first response deadline, and breached past the deadline with no reply. Breached and at-risk tickets sit at the top of the inbox.");
  lines.push("- Ticket IDs look like NIL-1001. Seeded demo tickets run from NIL-1001 to NIL-1016.");
  lines.push("- When a merchant asks something the guide does not cover, say so honestly and offer to open a ticket so the support team can answer it.");
  lines.push("- Do not assume a merchant message is about a ticket in the list unless they give a ticket ID, email or store name that matches it. If it does not match, ask which store or ticket they mean.");
  lines.push("- Only say a human agent is taking over after you have called escalate, or if the ticket already shows as escalated. Never promise a human handoff you have not made.");
  lines.push("");
  lines.push("YOUR TOOLS:");
  lines.push("- lookup_ticket: use it when the merchant asks about the status of an existing request. Give the ticket ID, status, first response deadline and what happens next.");
  lines.push("- create_ticket: use it when the merchant has a problem that needs the support team. Only call it when you have the merchant name, store name, email, plan tier, issue category and a short description. If any detail is missing, ask for it first instead of guessing.");
  lines.push("- escalate: use it for Critical issues (storefront down or checkout fully broken) and whenever the merchant asks for a human. If there is no ticket yet, create one first, then escalate it. When you escalate, tell the merchant plainly that a human agent will take over.");
  lines.push("");
  lines.push("Tickets visible in this demo right now (newest first):");
  if (!tickets || !tickets.length) {
    lines.push("- None.");
  } else {
    tickets.slice(0, 20).forEach(function (t) {
      lines.push(
        "- " + t.id + ": " + t.issue + " | " + t.plan + " plan, " + t.track + " track, " +
        t.status + ", " + t.store + ", created " + minsAgo(t.created, now) +
        ", first response due " + fmtDT(frDeadline(t))
      );
    });
  }
  return lines.join("\n");
}

/* ---------- Tool declarations for Gemini ---------- */
var TOOLS = [
  {
    functionDeclarations: [
      {
        name: "lookup_ticket",
        description: "Look up a support ticket by ticket ID (like NIL-1001) or by the merchant email address. Use it when the merchant asks about the status of an existing request.",
        parameters: {
          type: "OBJECT",
          properties: {
            query: { type: "STRING", description: "Ticket ID or email address" }
          },
          required: ["query"]
        }
      },
      {
        name: "create_ticket",
        description: "Open a new support ticket in the Nile support inbox. Only call it when you have the merchant name, store name, email, plan tier, issue category and a short description of the issue. Ask the merchant for any missing detail first.",
        parameters: {
          type: "OBJECT",
          properties: {
            merchant: { type: "STRING", description: "Merchant full name" },
            store: { type: "STRING", description: "Store name on Nile" },
            email: { type: "STRING", description: "Merchant email address" },
            plan: { type: "STRING", description: "Premium or Standard" },
            category: { type: "STRING", description: "One of: " + CATEGORIES.join(", ") },
            issue: { type: "STRING", description: "Short one line summary of the issue" }
          },
          required: ["merchant", "store", "email", "plan", "category", "issue"]
        }
      },
      {
        name: "escalate",
        description: "Flag a ticket as escalated so a human support agent takes over. Use it for Critical issues (storefront down or checkout fully broken) and whenever the merchant asks for a human.",
        parameters: {
          type: "OBJECT",
          properties: {
            ticketId: { type: "STRING", description: "Ticket ID, like NIL-1001" },
            reason: { type: "STRING", description: "Why this needs a human" }
          },
          required: ["ticketId", "reason"]
        }
      }
    ]
  }
];

/* ---------- Tool execution (server side, same triage rules as the hub) ---------- */
function executeTool(name, args, tickets) {
  args = args || {};
  if (name === "lookup_ticket") {
    var q = String(args.query || "").trim().toLowerCase();
    if (!q) return { found: false, message: "No ticket ID or email was given." };
    var found = tickets.filter(function (t) { return String(t.id).toLowerCase() === q; });
    if (!found.length) {
      found = tickets.filter(function (t) { return String(t.email || "").toLowerCase() === q; });
    }
    if (!found.length) return { found: false, message: "No ticket matches " + args.query + "." };
    found.sort(function (a, b) { return b.created - a.created; });
    return {
      found: true,
      tickets: found.slice(0, 3).map(function (t) {
        return {
          id: t.id,
          issue: t.issue,
          status: t.status,
          track: t.track,
          plan: t.plan,
          store: t.store,
          firstResponseDue: fmtDT(frDeadline(t)),
          resolutionTargetProposed: fmtDT(t.created + (RES_MIN[t.track] || RES_MIN.Standard) * 60000),
          escalated: !!t.escalated
        };
      })
    };
  }

  if (name === "create_ticket") {
    var merchant = String(args.merchant || "").trim();
    var store = String(args.store || "").trim();
    var email = String(args.email || "").trim().toLowerCase();
    var plan = args.plan === "Premium" ? "Premium" : "Standard";
    var category = CATEGORIES.indexOf(args.category) >= 0 ? args.category : "Something else";
    var issue = String(args.issue || "").trim();
    if (!merchant || !store || !email || !issue) {
      return { created: false, message: "Missing detail: merchant name, store, email and issue are all needed." };
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { created: false, message: "The email address does not look complete." };
    }
    var max = 1016;
    tickets.forEach(function (t) {
      var n = parseInt(String(t.id).replace("NIL-", ""), 10);
      if (!isNaN(n) && n > max) max = n;
    });
    var track = trackFor(category);
    var t = {
      id: "NIL-" + (max + 1),
      merchant: merchant,
      store: store,
      email: email,
      plan: plan,
      category: category,
      issue: issue.length > 90 ? issue.slice(0, 90) + "..." : issue,
      description: issue,
      channel: "Live chat",
      created: Date.now(),
      respondedAfter: null,
      resolvedAfter: null,
      status: "Open",
      track: track,
      priority: priorityFor(track, category),
      escalated: false
    };
    tickets.push(t);
    return {
      created: true,
      ticket: t,
      firstResponseDue: fmtDT(frDeadline(t)),
      resolutionTargetProposed: fmtDT(t.created + RES_MIN[track] * 60000)
    };
  }

  if (name === "escalate") {
    var id = String(args.ticketId || "").trim();
    var target = null;
    tickets.forEach(function (t) { if (String(t.id).toLowerCase() === id.toLowerCase()) target = t; });
    if (!target) return { escalated: false, message: "No ticket with ID " + id + " was found." };
    target.escalated = true;
    return { escalated: true, ticketId: target.id, reason: String(args.reason || ""), ticket: target };
  }

  return { error: "Unknown tool: " + name };
}

/* ---------- Gemini call ---------- */
async function callGemini(apiKey, contents, systemText) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, CALL_TIMEOUT_MS);
  try {
    var res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents: contents,
        tools: TOOLS,
        generationConfig: { temperature: 0.6, maxOutputTokens: 1024 }
      }),
      signal: ctrl.signal
    });
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      var err = new Error("Gemini request failed with status " + res.status);
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Handler ---------- */
module.exports = async function (req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  var apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "GEMINI_API_KEY is not set on the server" });
    return;
  }
  var body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};
  var message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  if (message.length > 2000) message = message.slice(0, 2000);

  var history = [];
  if (Array.isArray(body.history)) {
    history = body.history
      .filter(function (h) { return h && typeof h.text === "string" && h.text.trim(); })
      .slice(-8)
      .map(function (h) {
        return { role: h.role === "model" ? "model" : "user", text: h.text.slice(0, 2000) };
      });
  }
  var tickets = Array.isArray(body.tickets) ? body.tickets : [];
  tickets = tickets
    .filter(function (t) { return t && t.id && t.created; })
    .map(function (t) {
      t.track = (t.track === "Critical" || t.track === "Standard") ? t.track : trackFor(t.category || "");
      t.plan = t.plan === "Premium" ? "Premium" : "Standard";
      return t;
    });
  tickets.sort(function (a, b) { return b.created - a.created; });

  var systemText = buildSystemPrompt(tickets);
  var contents = history.map(function (h) {
    return { role: h.role, parts: [{ text: h.text }] };
  });
  contents.push({ role: "user", parts: [{ text: message }] });

  var ticketUpdates = [];
  var escalated = null;
  var reply = "";

  try {
    for (var round = 0; round < MAX_ROUNDS; round++) {
      var data = await callGemini(apiKey, contents, systemText);
      var cand = data && data.candidates && data.candidates[0];
      var parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
      var calls = parts.filter(function (p) { return p.functionCall; }).map(function (p) { return p.functionCall; });
      var texts = parts
        .filter(function (p) { return typeof p.text === "string"; })
        .map(function (p) { return p.text; });
      if (!calls.length) {
        reply = texts.join("").trim();
        break;
      }
      contents.push({ role: "model", parts: parts });
      var fnResponses = [];
      for (var i = 0; i < calls.length; i++) {
        var result = executeTool(calls[i].name, calls[i].args || {}, tickets);
        if (result && result.ticket) {
          var dup = -1;
          ticketUpdates.forEach(function (u, idx) { if (u.id === result.ticket.id) dup = idx; });
          if (dup >= 0) ticketUpdates[dup] = result.ticket;
          else ticketUpdates.push(result.ticket);
        }
        if (calls[i].name === "escalate" && result && result.escalated) {
          escalated = { ticketId: result.ticketId, reason: String((calls[i].args && calls[i].args.reason) || "") };
        }
        fnResponses.push({ functionResponse: { name: calls[i].name, response: result } });
      }
      contents.push({ role: "function", parts: fnResponses });
      if (round === MAX_ROUNDS - 1) reply = texts.join("").trim();
    }
  } catch (e) {
    var status = e && (e.status === 429 || e.status === 503) ? 502 : 500;
    res.status(status).json({
      error: "The AI agent is busy right now. Please try again in a moment, or open a ticket in the portal."
    });
    return;
  }

  if (!reply) {
    if (ticketUpdates.length) {
      var newest = ticketUpdates[ticketUpdates.length - 1];
      reply = "Done. Your ticket " + newest.id + " is open in the support inbox" +
        (escalated ? ", and I have flagged it for a human agent." : ".") +
        " You can track it with that ID any time.";
    } else {
      reply = "Thanks for the details. I could not finish that just now, please try again or open a ticket in the portal on this page.";
    }
  }

  res.status(200).json({ reply: reply, ticketUpdates: ticketUpdates, escalated: escalated });
};

module.exports._internals = {
  buildSystemPrompt: buildSystemPrompt,
  executeTool: executeTool,
  trackFor: trackFor,
  priorityFor: priorityFor,
  TOOLS: TOOLS
};
