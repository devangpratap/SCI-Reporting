/*
  db.js — Data source abstraction

  Connects to Lakebase (Databricks-managed Postgres) via standard pg driver.
  No @databricks/sql needed — it's just PostgreSQL on the wire.

  DATA_SOURCE=mock   → use local JSON files (default, no credentials needed)
  DATA_SOURCE=postgres → query Lakebase using DATABASE_URL

  PostgreSQL table names expected (ingestion layer creates these):
    sci_p8_decisions        — decisions[]
    sci_p8_action_items     — action_items[]
    sci_p8_blockers         — blockers[]
    sci_p9_stalls           — stalls[]
    sci_p9_nodes            — graph nodes[]
    sci_p9_edges            — graph edges[]
    sci_p10_tasks           — tasks[] with classification
    sci_p11_gaps            — integration gaps[]
    sci_p12_recommendations — roadmap recommendations[]

  All tables must have an org_id TEXT column — every query is scoped to one org.
*/

require("dotenv").config();
const { Pool } = require("pg");
const fs   = require("fs");
const path = require("path");

const USE_POSTGRES = process.env.DATA_SOURCE === "postgres";

// ── Mock fallback ──────────────────────────────────────────────────────────
function readMock(filename) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "mock", filename), "utf-8"));
}

// ── Postgres pool (lazy-initialised) ──────────────────────────────────────
let _pool = null;

function getPool() {
  if (_pool) return _pool;
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL not set — check .env");
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Lakebase uses TLS; rejectUnauthorized:false accepts the managed cert
    ssl: { rejectUnauthorized: false },
  });
  return _pool;
}

// Base query helper — returns rows array
async function query(sql, params = []) {
  const result = await getPool().query(sql, params);
  return result.rows;
}

// Org-scoped query helper
// Returns { sql, params } with org_id appended as a $N parameter when provided
function scoped(baseSql, orgId, existingParams = []) {
  if (!orgId) return { sql: baseSql, params: existingParams };
  return {
    sql:    `${baseSql} WHERE org_id = $${existingParams.length + 1}`,
    params: [...existingParams, orgId],
  };
}

// ── Org helpers ────────────────────────────────────────────────────────────

async function getOrgIds() {
  if (!USE_POSTGRES) return ["mock-org"];
  return (await query("SELECT DISTINCT org_id FROM sci_p8_decisions")).map(r => r.org_id).filter(Boolean);
}

// ── Query functions (one per vertical) ────────────────────────────────────

async function getP8(orgId) {
  if (!USE_POSTGRES) return readMock("p8_conversations.json");
  const { sql, params } = scoped("SELECT * FROM", orgId); // placeholder — see below
  // Three tables, same org filter
  const where  = orgId ? "WHERE org_id = $1" : "";
  const p      = orgId ? [orgId] : [];
  const [decisions, action_items, blockers] = await Promise.all([
    query(`SELECT * FROM sci_p8_decisions ${where}`, p),
    query(`SELECT * FROM sci_p8_action_items ${where}`, p),
    query(`SELECT * FROM sci_p8_blockers ${where}`, p),
  ]);
  return { decisions, action_items, blockers };
}

async function getP9(orgId) {
  if (!USE_POSTGRES) {
    const data = readMock("p9_stalls.json");
    return { stalls: data.stalls };
  }
  const where = orgId ? "WHERE org_id = $1" : "";
  const p     = orgId ? [orgId] : [];
  const stalls = await query(`SELECT * FROM sci_p9_stalls ${where}`, p);
  return { stalls };
}

async function getGraph(orgId) {
  let nodes, edges, stalls;

  if (!USE_POSTGRES) {
    const data = readMock("p9_stalls.json");
    nodes  = data.nodes;
    edges  = data.edges;
    stalls = data.stalls;
  } else {
    const where = orgId ? "WHERE org_id = $1" : "";
    const p     = orgId ? [orgId] : [];
    ([nodes, edges, stalls] = await Promise.all([
      query(`SELECT * FROM sci_p9_nodes ${where}`, p),
      query(`SELECT * FROM sci_p9_edges ${where}`, p),
      query(`SELECT * FROM sci_p9_stalls ${where}`, p),
    ]));
  }

  // ── Server-side critical path (BFS/DFS longest path) ──────────────────
  const adj = {};
  nodes.forEach(n => { adj[n.id] = []; });
  edges.forEach(e => { if (adj[e.source]) adj[e.source].push(e.target); });

  const dist    = {};
  const visited = new Set();
  nodes.forEach(n => { dist[n.id] = 0; });

  function dfs(id) {
    if (visited.has(id)) return dist[id];
    visited.add(id);
    let max = 0;
    for (const nb of (adj[id] || [])) max = Math.max(max, 1 + dfs(nb));
    dist[id] = max;
    return max;
  }
  nodes.forEach(n => dfs(n.id));

  const distValues = Object.values(dist);
  const maxDist    = distValues.length > 0 ? Math.max(...distValues) : 0;

  const criticalNodes = new Set();
  function traceCritical(id, remaining) {
    criticalNodes.add(id);
    if (remaining === 0) return;
    for (const nb of (adj[id] || [])) {
      if (dist[nb] === remaining - 1) { traceCritical(nb, remaining - 1); break; }
    }
  }
  const roots = nodes.filter(n => !edges.some(e => e.target === n.id));
  roots.forEach(r => { if (dist[r.id] === maxDist) traceCritical(r.id, maxDist); });

  const stalledTaskIds = new Set((stalls || []).map(s => s.task_id));

  const annotatedNodes = nodes.map(n => ({
    id: n.id, label: n.label, team: n.team, status: n.status,
    on_critical_path: criticalNodes.has(n.id),
    is_stalled:       stalledTaskIds.has(n.id),
    depends_on:       adj[n.id] || [],
  }));

  const annotatedEdges = edges.map(e => ({
    ...e,
    on_critical_path: criticalNodes.has(e.source) && criticalNodes.has(e.target),
  }));

  return { nodes: annotatedNodes, edges: annotatedEdges };
}

async function getP10(orgId) {
  if (!USE_POSTGRES) return readMock("p10_workflows.json");
  const where = orgId ? "WHERE org_id = $1" : "";
  const p     = orgId ? [orgId] : [];
  const tasks = await query(`SELECT * FROM sci_p10_tasks ${where}`, p);
  return { tasks };
}

async function getP11(orgId) {
  if (!USE_POSTGRES) return readMock("p11_gaps.json");
  const where = orgId ? "WHERE org_id = $1" : "";
  const p     = orgId ? [orgId] : [];
  const gaps  = await query(`SELECT * FROM sci_p11_gaps ${where}`, p);
  const simulation = {
    role: "CSM",
    cases_per_month:        47,
    current_assembly_pct:   0.65,
    target_assembly_pct:    0.15,
    current_throughput:     47,
    projected_throughput:   Math.round(47 / 0.15 * 0.65),
  };
  return { gaps, simulation };
}

async function getP12(orgId) {
  if (!USE_POSTGRES) {
    const data = readMock("p12_roadmap.json");
    const gaps = readMock("p11_gaps.json").gaps;
    const gapMap = Object.fromEntries(gaps.map(g => [g.id, g.missing_data]));
    return {
      recommendations: data.recommendations.map(r => ({
        ...r,
        linked_gap_title: r.linked_gap ? gapMap[r.linked_gap] : null,
      })),
    };
  }
  const where = orgId ? "WHERE org_id = $1" : "";
  const p     = orgId ? [orgId] : [];
  const [recs, gaps] = await Promise.all([
    query(`SELECT * FROM sci_p12_recommendations ${where} ORDER BY priority ASC`, p),
    query(`SELECT id, missing_data FROM sci_p11_gaps ${where}`, p),
  ]);
  const gapMap = Object.fromEntries(gaps.map(g => [g.id, g.missing_data]));
  return {
    recommendations: recs.map(r => ({
      ...r,
      linked_gap_title: r.linked_gap ? gapMap[r.linked_gap] : null,
    })),
  };
}

// ── Edit execution ─────────────────────────────────────────────────────────
// Called by POST /api/chat/confirm after admin approves a proposed change.
// Uses fully parameterized queries — no string interpolation for values.

async function applyEdit({ org_id, table, operation, where_id, set_fields = {} }) {
  const safeTable = table.replace(/[^a-z0-9_]/g, ""); // identifier — can't parameterize table names

  if (!USE_POSTGRES) {
    console.log(`[mock] applyEdit: ${operation} on ${safeTable} id=${where_id}`);
    return { success: true, mode: "mock" };
  }

  if (operation === "delete") {
    await query(
      `DELETE FROM ${safeTable} WHERE id = $1 AND org_id = $2`,
      [where_id, org_id]
    );
  } else {
    const keys   = Object.keys(set_fields).map(k => k.replace(/[^a-z0-9_]/g, ""));
    const values = Object.values(set_fields);
    if (!keys.length) throw new Error("update requires at least one field in set_fields");
    const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
    await query(
      `UPDATE ${safeTable} SET ${setClause} WHERE id = $${keys.length + 1} AND org_id = $${keys.length + 2}`,
      [...values, where_id, org_id]
    );
  }

  return { success: true };
}

// Export pool getter so reports.js can share the same connection
module.exports = { getP8, getP9, getGraph, getP10, getP11, getP12, getOrgIds, applyEdit, getPool };
