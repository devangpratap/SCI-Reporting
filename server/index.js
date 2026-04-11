/*
  SCI Reporting — Express API Server

  Thin routing layer. All data logic lives in db.js.
  To switch to Databricks: set DATA_SOURCE=databricks in .env — nothing else changes.

  Endpoints:
    GET  /api/state     — decisions, action items, blockers
    GET  /api/stalls    — stall alerts
    GET  /api/graph     — dependency graph nodes + edges
    GET  /api/workflows — task classifications
    GET  /api/gaps      — integration gaps + simulation
    GET  /api/roadmap   — automation roadmap
    POST /api/chat         — bidirectional AI chat; response includes proposed_changes[] when AI detects a DB edit intent
    POST /api/chat/confirm — confirm or reject a pending DB change ({ change_id, approved, user_token })
*/

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { getState, getStalls, getGraph, getWorkflows, getGaps, getRoadmap, applyEdit } = require("./db");
const { chat, chatStream } = require("./chat");
const { getPending, removePending } = require("./edits");
const { refreshReports, startAutoRefresh } = require("./reports");

const app = express();
app.use(cors());
app.use(express.json());

// Request logger — shows every inbound call and LLM calls are logged in chat.js
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// All data routes accept ?org_id=... query param to scope to one org
// In mock mode org_id is ignored — single-org mock data returned regardless
app.get("/api/state",     async (req, res) => res.json(await getState(req.query.org_id)));
app.get("/api/stalls",    async (req, res) => res.json(await getStalls(req.query.org_id)));
app.get("/api/graph",     async (req, res) => res.json(await getGraph(req.query.org_id)));
app.get("/api/workflows", async (req, res) => res.json(await getWorkflows(req.query.org_id)));
app.get("/api/gaps",      async (req, res) => res.json(await getGaps(req.query.org_id)));
app.get("/api/roadmap",   async (req, res) => res.json(await getRoadmap(req.query.org_id)));

// Bidirectional AI chat — full response (non-streaming)
// Body:    { user_token, message, history: [{sender, message, timestamp}] }
// Returns: { response, history, proposed_changes }
app.post("/api/chat", async (req, res) => {
  const { user_token, message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "message required" });
  try {
    const result = await chat(message, history, user_token);
    res.json(result);
  } catch (err) {
    console.error("chat error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Streaming AI chat — SSE, tokens arrive in real-time
// Body:    same as /api/chat
// Stream:  text/event-stream
//   data: {"type":"token","content":"..."}          — partial token
//   data: {"type":"tool_call","name":"..."}         — tool being called (UX hint)
//   data: {"type":"done","response":"...","history":[...],"proposed_changes":[...]}
//   data: {"type":"error","error":"..."}
app.post("/api/chat/stream", async (req, res) => {
  const { user_token, message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "message required" });

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const result = await chatStream(message, history, user_token, send);
    send({ type: "done", ...result });
  } catch (err) {
    console.error("chat/stream error:", err.message);
    send({ type: "error", error: err.message });
  } finally {
    res.end();
  }
});

// ── Chat-driven DB edits ────────────────────────────────────────────────────
// Flow:
//   1. POST /api/chat  →  AI calls propose_db_edit  →  response includes proposed_changes[]
//   2. UI shows Yes/No per change
//   3. POST /api/chat/confirm { change_id, approved, user_token }
//      → approved=true  : executes the SQL, removes from pending, triggers report refresh
//      → approved=false : discards the pending change, no-op on DB
//
// Body:    { change_id: string, approved: boolean, user_token?: string }
// Returns: { change_id, status: "applied" | "rejected" }
app.post("/api/chat/confirm", async (req, res) => {
  const { change_id, approved, user_token } = req.body;
  if (!change_id) return res.status(400).json({ error: "change_id required" });

  const entry = getPending(change_id);
  if (!entry) return res.status(404).json({ error: "Change not found or expired (30-min TTL)" });

  // Org check — user_token is used as org_id throughout the reporting layer
  const orgId = user_token || null;
  if (entry.org_id && orgId && entry.org_id !== orgId)
    return res.status(403).json({ error: "org mismatch — change belongs to a different org" });

  if (!approved) {
    removePending(change_id);
    return res.json({ change_id, status: "rejected" });
  }

  try {
    await applyEdit(entry);
    removePending(change_id);

    // Non-blocking: refresh static reports so Uvicorn picks up the new state
    refreshReports(entry.org_id || null).catch(err =>
      console.error("post-edit report refresh failed:", err.message)
    );

    res.json({ change_id, status: "applied" });
  } catch (err) {
    console.error("applyEdit error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manual report refresh — call after Databricks data changes to force an immediate write
// Body: { org_id?: string } — omit to refresh all orgs
app.post("/api/reports/refresh", async (req, res) => {
  const result = await refreshReports(req.body?.org_id || null);
  res.json(result);
});

app.get("/health", (_, res) => res.json({
  status: "ok",
  data_source: process.env.DATA_SOURCE || "mock"
}));

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`SCI Reporting API on http://localhost:${PORT} [${process.env.DATA_SOURCE || "mock"}]`);
  startAutoRefresh(); // write reports to Postgres on startup, then every hour
});
