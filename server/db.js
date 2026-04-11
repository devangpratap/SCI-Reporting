/*
  db.js — Data source abstraction

  Controls whether data comes from Databricks SQL or local mock files.
  Flip DATA_SOURCE=databricks in .env on Saturday when credentials arrive.

  Databricks table names expected (teammates must create these):
    sci_p8_decisions        — decisions[]
    sci_p8_action_items     — action_items[]
    sci_p8_blockers         — blockers[]
    sci_p9_stalls           — stalls[]
    sci_p9_nodes            — graph nodes[]
    sci_p9_edges            — graph edges[]
    sci_p10_tasks           — tasks[] with classification
    sci_p11_gaps            — integration gaps[]
    sci_p12_recommendations — roadmap recommendations[]

  To add a new vertical: add a query function below, import it in index.js.
*/

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const USE_DATABRICKS = process.env.DATA_SOURCE === "databricks";

// ── Mock fallback ──────────────────────────────────────────────────────────
function readMock(filename) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "mock", filename), "utf-8"));
}

// ── Databricks connection ──────────────────────────────────────────────────
let _client = null;

async function getDatabricksClient() {
  if (_client) return _client;
  if (!process.env.DATABRICKS_HOST || !process.env.DATABRICKS_TOKEN)
    throw new Error("Databricks credentials not set — check DATABRICKS_HOST and DATABRICKS_TOKEN in .env");
  const { DBSQLClient } = require("@databricks/sql");
  const client = new DBSQLClient();
  await client.connect({
    host:  process.env.DATABRICKS_HOST,
    path:  process.env.DATABRICKS_HTTP_PATH,
    token: process.env.DATABRICKS_TOKEN,
  });
  _client = client;
  return client;
}

async function queryDatabricks(sql) {
  try {
    const client = await getDatabricksClient();
    const session = await client.openSession();
    const op = await session.executeStatement(sql, { runAsync: false });
    const result = await op.fetchAll();
    await op.close();
    await session.close();
    return result;
  } catch (err) {
    // Reset client so next call retries the connection
    _client = null;
    throw new Error(`Databricks query failed: ${err.message}`);
  }
}

// ── Org helpers ────────────────────────────────────────────────────────────

// Returns all distinct org_ids present in Databricks
async function getOrgIds() {
  if (!USE_DATABRICKS) return ["mock-org"];
  const rows = await queryDatabricks("SELECT DISTINCT org_id FROM sci_p8_decisions");
  return rows.map(r => r.org_id).filter(Boolean);
}

// Build a WHERE clause fragment — safe literal (org_id is an opaque string, not user SQL)
function orgFilter(orgId) {
  return orgId ? `WHERE org_id = '${orgId.replace(/'/g, "''")}'` : "";
}

// ── Query functions (one per vertical) ────────────────────────────────────
// All accept an optional orgId — filters every query to that org's rows only.
// Mock mode ignores orgId (single-org mock data).

async function getP8(orgId) {
  if (!USE_DATABRICKS) return readMock("p8_conversations.json");
  const f = orgFilter(orgId);
  const [decisions, action_items, blockers] = await Promise.all([
    queryDatabricks(`SELECT * FROM sci_p8_decisions ${f}`),
    queryDatabricks(`SELECT * FROM sci_p8_action_items ${f}`),
    queryDatabricks(`SELECT * FROM sci_p8_blockers ${f}`),
  ]);
  return { decisions, action_items, blockers };
}

async function getP9(orgId) {
  if (!USE_DATABRICKS) {
    const data = readMock("p9_stalls.json");
    return { stalls: data.stalls };
  }
  const stalls = await queryDatabricks(`SELECT * FROM sci_p9_stalls ${orgFilter(orgId)}`);
  return { stalls };
}

async function getGraph(orgId) {
  let nodes, edges, stalls;

  if (!USE_DATABRICKS) {
    const data = readMock("p9_stalls.json");
    nodes = data.nodes;
    edges = data.edges;
    stalls = data.stalls;
  } else {
    const f = orgFilter(orgId);
    ([nodes, edges, stalls] = await Promise.all([
      queryDatabricks(`SELECT * FROM sci_p9_nodes ${f}`),
      queryDatabricks(`SELECT * FROM sci_p9_edges ${f}`),
      queryDatabricks(`SELECT * FROM sci_p9_stalls ${f}`),
    ]));
  }

  // Pre-compute critical path (longest path) via BFS on adjacency list
  // Done server-side so frontend + MCP never need to compute it
  const adj = {};
  nodes.forEach(n => { adj[n.id] = []; });
  edges.forEach(e => { if (adj[e.source]) adj[e.source].push(e.target); });

  // Topological sort + longest path
  const dist = {};
  nodes.forEach(n => { dist[n.id] = 0; });
  const visited = new Set();

  function dfs(id) {
    if (visited.has(id)) return dist[id];
    visited.add(id);
    let max = 0;
    for (const neighbor of (adj[id] || [])) {
      max = Math.max(max, 1 + dfs(neighbor));
    }
    dist[id] = max;
    return max;
  }
  nodes.forEach(n => dfs(n.id));
  const distValues = Object.values(dist);
  const maxDist = distValues.length > 0 ? Math.max(...distValues) : 0;

  // Trace critical path nodes
  const criticalNodes = new Set();
  function traceCritical(id, remaining) {
    criticalNodes.add(id);
    if (remaining === 0) return;
    for (const neighbor of (adj[id] || [])) {
      if (dist[neighbor] === remaining - 1) {
        traceCritical(neighbor, remaining - 1);
        break;
      }
    }
  }
  const roots = nodes.filter(n => !edges.some(e => e.target === n.id));
  roots.forEach(r => { if (dist[r.id] === maxDist) traceCritical(r.id, maxDist); });

  // Stalled node IDs
  const stalledTaskIds = new Set((stalls || []).map(s => s.task_id));

  // Annotate nodes with flags — this is all the frontend/MCP needs
  const annotatedNodes = nodes.map(n => ({
    id: n.id,
    label: n.label,
    team: n.team,
    status: n.status,
    on_critical_path: criticalNodes.has(n.id),
    is_stalled: stalledTaskIds.has(n.id),
    depends_on: adj[n.id] || [],
  }));

  // Annotate edges with critical path flag
  const annotatedEdges = edges.map(e => ({
    ...e,
    on_critical_path: criticalNodes.has(e.source) && criticalNodes.has(e.target),
  }));

  return { nodes: annotatedNodes, edges: annotatedEdges };
}

async function getP10(orgId) {
  if (!USE_DATABRICKS) return readMock("p10_workflows.json");
  const tasks = await queryDatabricks(`SELECT * FROM sci_p10_tasks ${orgFilter(orgId)}`);
  return { tasks };
}

async function getP11(orgId) {
  if (!USE_DATABRICKS) return readMock("p11_gaps.json");
  const f = orgFilter(orgId);
  const gaps = await queryDatabricks(`SELECT * FROM sci_p11_gaps ${f}`);
  const simulation = {
    role: "CSM",
    cases_per_month: 47,
    current_assembly_pct: 0.65,
    target_assembly_pct: 0.15,
    current_throughput: 47,
    projected_throughput: Math.round(47 / 0.15 * 0.65),
  };
  return { gaps, simulation };
}

async function getP12(orgId) {
  if (!USE_DATABRICKS) {
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
  const f = orgFilter(orgId);
  const [recs, gaps] = await Promise.all([
    queryDatabricks(`SELECT * FROM sci_p12_recommendations ${f} ORDER BY priority ASC`),
    queryDatabricks(`SELECT id, missing_data FROM sci_p11_gaps ${f}`),
  ]);
  const gapMap = Object.fromEntries(gaps.map(g => [g.id, g.missing_data]));
  return {
    recommendations: recs.map(r => ({
      ...r,
      linked_gap_title: r.linked_gap ? gapMap[r.linked_gap] : null,
    })),
  };
}

module.exports = { getP8, getP9, getGraph, getP10, getP11, getP12, getOrgIds };
