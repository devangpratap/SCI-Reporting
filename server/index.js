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
// Body: { message: string, history: [{role, content}][] }
// Returns: { response: string, history: [...updated] }
// UI sends history back on next request to maintain conversation context
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "message required" });
  try {
    const result = await chat(message, history);
    res.json(result);
  } catch (err) {
    console.error("chat error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({
  status: "ok",
  data_source: process.env.DATA_SOURCE || "mock"
}));

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`SCI Reporting API on http://localhost:${PORT} [${process.env.DATA_SOURCE || "mock"}]`);
});
