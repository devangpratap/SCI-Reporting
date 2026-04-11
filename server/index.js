/*
  SCI Reporting — Express API Server

  Thin routing layer. All data logic lives in db.js.
  To switch to Databricks: set DATA_SOURCE=databricks in .env — nothing else changes.

  Endpoints:
    GET  /api/p8        — decisions, action items, blockers
    GET  /api/p9        — stall alerts
    GET  /api/p9/graph  — dependency graph nodes + edges (static, loaded once)
    GET  /api/p10       — task classifications
    GET  /api/p11       — integration gaps + simulation
    GET  /api/p12       — automation roadmap
    POST /api/chat      — bidirectional AI chat (agentic loop via Claude + tool use)
*/

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { getP8, getP9, getGraph, getP10, getP11, getP12 } = require("./db");
const { chat } = require("./chat");
const { refreshReports, startAutoRefresh } = require("./reports");

const app = express();
app.use(cors());
app.use(express.json());

// All data routes accept ?org_id=... query param to scope to one org
// In mock mode org_id is ignored — single-org mock data returned regardless
app.get("/api/p8",       async (req, res) => res.json(await getP8(req.query.org_id)));
app.get("/api/p9",       async (req, res) => res.json(await getP9(req.query.org_id)));
app.get("/api/p9/graph", async (req, res) => res.json(await getGraph(req.query.org_id)));
app.get("/api/p10",      async (req, res) => res.json(await getP10(req.query.org_id)));
app.get("/api/p11",      async (req, res) => res.json(await getP11(req.query.org_id)));
app.get("/api/p12",      async (req, res) => res.json(await getP12(req.query.org_id)));

// Bidirectional AI chat
// Body:    { user_token: string, message: string, history: [{sender, message, timestamp}] }
// Returns: { response: string, history: [{sender, message, timestamp}] }
// UI sends full history back on every request — server is stateless
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
