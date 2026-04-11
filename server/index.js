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

app.get("/api/p8",       async (_, res) => res.json(await getP8()));
app.get("/api/p9",       async (_, res) => res.json(await getP9()));
app.get("/api/p9/graph", async (_, res) => res.json(await getGraph()));
app.get("/api/p10",      async (_, res) => res.json(await getP10()));
app.get("/api/p11",      async (_, res) => res.json(await getP11()));
app.get("/api/p12",      async (_, res) => res.json(await getP12()));

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

// Manual report refresh — call this after Databricks data changes to force an immediate write
app.post("/api/reports/refresh", async (_, res) => {
  const result = await refreshReports();
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
