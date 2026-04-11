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
  const { DBSQLClient } = require("@databricks/sql");
  const client = new DBSQLClient();
  await client.connect({
    host:     process.env.DATABRICKS_HOST,
    path:     process.env.DATABRICKS_HTTP_PATH,
    token:    process.env.DATABRICKS_TOKEN,
  });
  _client = client;
  return client;
}

async function queryDatabricks(sql) {
  const client = await getDatabricksClient();
  const session = await client.openSession();
  const op = await session.executeStatement(sql, { runAsync: false });
  const result = await op.fetchAll();
  await op.close();
  await session.close();
  return result;
}

// ── Query functions (one per vertical) ────────────────────────────────────

async function getP8() {
  if (!USE_DATABRICKS) return readMock("p8_conversations.json");
  const [decisions, action_items, blockers] = await Promise.all([
    queryDatabricks("SELECT * FROM sci_p8_decisions"),
    queryDatabricks("SELECT * FROM sci_p8_action_items"),
    queryDatabricks("SELECT * FROM sci_p8_blockers"),
  ]);
  return { decisions, action_items, blockers };
}

async function getP9() {
  if (!USE_DATABRICKS) {
    const data = readMock("p9_stalls.json");
    return { stalls: data.stalls };
  }
  const stalls = await queryDatabricks("SELECT * FROM sci_p9_stalls");
  return { stalls };
}

async function getGraph() {
  let nodes, edges, stalls;

  if (!USE_DATABRICKS) {
    const data = readMock("p9_stalls.json");
    nodes = data.nodes;
    edges = data.edges;
    stalls = data.stalls;
  } else {
    ([nodes, edges, stalls] = await Promise.all([
      queryDatabricks("SELECT * FROM sci_p9_nodes"),
      queryDatabricks("SELECT * FROM sci_p9_edges"),
      queryDatabricks("SELECT * FROM sci_p9_stalls"),
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
  const maxDist = Math.max(...Object.values(dist));

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

async function getP10() {
  if (!USE_DATABRICKS) return readMock("p10_workflows.json");
  const tasks = await queryDatabricks("SELECT * FROM sci_p10_tasks");
  return { tasks };
}

async function getP11() {
  if (!USE_DATABRICKS) return readMock("p11_gaps.json");
  const gaps = await queryDatabricks("SELECT * FROM sci_p11_gaps");
  // simulation is derived, not stored — calculate from gaps data
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

async function getP12() {
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
  const [recs, gaps] = await Promise.all([
    queryDatabricks("SELECT * FROM sci_p12_recommendations ORDER BY priority ASC"),
    queryDatabricks("SELECT id, missing_data FROM sci_p11_gaps"),
  ]);
  const gapMap = Object.fromEntries(gaps.map(g => [g.id, g.missing_data]));
  return {
    recommendations: recs.map(r => ({
      ...r,
      linked_gap_title: r.linked_gap ? gapMap[r.linked_gap] : null,
    })),
  };
}

module.exports = { getP8, getP9, getGraph, getP10, getP11, getP12 };
