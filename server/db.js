/*
  db.js — Data source abstraction

  All real data lives in the `public` schema of Lakebase (Postgres).
  Connects via DATABASE_URL with the pg driver — no Databricks SDK.

  DATA_SOURCE=mock     → local JSON mock files (default)
  DATA_SOURCE=postgres → public.* tables via DATABASE_URL

  Schema (public):
    tasks        — decisions / action_items / blockers / milestones (type column)
    edges        — source_task_id → target_task_id dependencies
    communications — source emails/docs
    identities   — people and their roles
    task_owners  — task_id ↔ identity_id join
    provenance   — item_id → source_comm_id (links tasks back to comms)
    orgs         — org_id, name
    analysis_runs — pipeline run metadata
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

// ── Postgres pool (lazy) ───────────────────────────────────────────────────
let _pool = null;
function getPool() {
  if (_pool) return _pool;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set — check .env");
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  return _pool;
}

async function query(sql, params = []) {
  const result = await getPool().query(sql, params);
  return result.rows;
}

// ── Org helpers ────────────────────────────────────────────────────────────

async function getOrgIds() {
  if (!USE_POSTGRES) return ["mock-org"];
  const rows = await query("SELECT id FROM public.orgs ORDER BY id");
  return rows.map(r => r.id);
}

// ── P8 — Conversation State ────────────────────────────────────────────────
// decisions / action_items / blockers from public.tasks

async function getP8(orgId) {
  if (!USE_POSTGRES) return readMock("p8_conversations.json");

  const w = orgId ? "AND t.org_id = $1" : "";
  const p = orgId ? [orgId] : [];

  const [decisions, action_items, blockers] = await Promise.all([
    // decisions — participants derived from task_owners
    query(`
      SELECT t.id, t.org_id,
             t.title                                                           AS summary,
             COALESCE(t.description, t.title)                                 AS rationale,
             t.status,
             t.deadline                                                        AS timestamp,
             COALESCE(array_agg(DISTINCT i.display_name)
               FILTER (WHERE i.display_name IS NOT NULL), ARRAY[]::text[])    AS participants
      FROM public.tasks t
      LEFT JOIN public.task_owners o  ON t.id = o.task_id
      LEFT JOIN public.identities  i  ON o.identity_id = i.id
      WHERE t.type = 'decision' ${w}
      GROUP BY t.id, t.org_id, t.title, t.description, t.status, t.deadline
      ORDER BY t.deadline NULLS LAST
    `, p),

    // action_items — first owner as "owner", blocking from edges
    query(`
      SELECT t.id, t.org_id,
             t.title                                                           AS description,
             t.status,
             t.deadline,
             COALESCE(MIN(i.display_name), 'Unassigned')                      AS owner,
             COALESCE(array_agg(DISTINCT e.target_task_id)
               FILTER (WHERE e.target_task_id IS NOT NULL), ARRAY[]::text[])  AS blocking
      FROM public.tasks t
      LEFT JOIN public.task_owners o  ON t.id = o.task_id
      LEFT JOIN public.identities  i  ON o.identity_id = i.id
      LEFT JOIN public.edges       e  ON e.source_task_id = t.id
      WHERE t.type = 'action_item' ${w}
      GROUP BY t.id, t.org_id, t.title, t.status, t.deadline
      ORDER BY
        CASE t.status WHEN 'blocked' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
        t.deadline NULLS LAST
    `, p),

    // blockers — raised_by from first owner, blocking = downstream task ids
    query(`
      SELECT t.id, t.org_id,
             t.title                                                           AS description,
             t.status,
             t.deadline                                                        AS timestamp,
             COALESCE(MIN(i.display_name), 'Unassigned')                      AS raised_by,
             COALESCE(array_agg(DISTINCT e.target_task_id)
               FILTER (WHERE e.target_task_id IS NOT NULL), ARRAY[]::text[])  AS blocking
      FROM public.tasks t
      LEFT JOIN public.task_owners o  ON t.id = o.task_id
      LEFT JOIN public.identities  i  ON o.identity_id = i.id
      LEFT JOIN public.edges       e  ON e.source_task_id = t.id
      WHERE t.type = 'blocker' ${w}
      GROUP BY t.id, t.org_id, t.title, t.status, t.deadline
      ORDER BY t.status DESC
    `, p),
  ]);

  return { decisions, action_items, blockers };
}

// ── P9 — Critical-Path Stalls ──────────────────────────────────────────────
// Stalls = tasks with status='blocked'; graph = all tasks + edges

async function getP9(orgId) {
  if (!USE_POSTGRES) {
    const data = readMock("p9_stalls.json");
    return { stalls: data.stalls };
  }

  const w = orgId ? "AND t.org_id = $1" : "";
  const p = orgId ? [orgId] : [];

  const stalls = await query(`
    SELECT t.id, t.org_id,
           t.title                                                             AS description,
           t.type                                                              AS stall_type,
           t.deadline                                                          AS unresponsive_since,
           CASE
             WHEN t.deadline IS NOT NULL AND t.deadline::date < CURRENT_DATE  THEN 'high'
             WHEN t.deadline IS NOT NULL                                       THEN 'medium'
             ELSE 'low'
           END                                                                 AS severity,
           COALESCE(array_agg(DISTINCT i.role)
             FILTER (WHERE i.role IS NOT NULL), ARRAY['Unknown'])              AS affected_teams,
           COALESCE(t.description, t.title)                                   AS context
    FROM public.tasks t
    LEFT JOIN public.task_owners o  ON t.id = o.task_id
    LEFT JOIN public.identities  i  ON o.identity_id = i.id
    WHERE t.status = 'blocked' ${w}
    GROUP BY t.id, t.org_id, t.title, t.type, t.deadline, t.description
    ORDER BY
      CASE WHEN t.deadline IS NOT NULL AND t.deadline::date < CURRENT_DATE THEN 0
           WHEN t.deadline IS NOT NULL THEN 1 ELSE 2 END,
      t.deadline NULLS LAST
  `, p);

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
    const w = orgId ? "WHERE t.org_id = $1" : "";
    const ew = orgId ? "WHERE e.org_id = $1" : "";
    const p  = orgId ? [orgId] : [];

    ([nodes, edges, stalls] = await Promise.all([
      // Nodes — one row per task, first owner's role as team
      query(`
        SELECT DISTINCT ON (t.id)
               t.id, t.title AS label,
               COALESCE(i.role, 'Unknown') AS team,
               t.status, t.type
        FROM public.tasks t
        LEFT JOIN public.task_owners o  ON t.id = o.task_id
        LEFT JOIN public.identities  i  ON o.identity_id = i.id
        ${w}
        ORDER BY t.id, i.display_name NULLS LAST
      `, p),
      // Edges — rename to source/target for Cytoscape
      query(`
        SELECT e.id, e.source_task_id AS source, e.target_task_id AS target
        FROM public.edges e
        ${ew}
      `, p),
      // Stalls for annotation
      query(`
        SELECT id, org_id FROM public.tasks
        WHERE status = 'blocked'
        ${orgId ? "AND org_id = $1" : ""}
      `, p),
    ]));
  }

  // ── Server-side critical path (longest path via DFS) ──────────────────
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

  const stalledIds = new Set(stalls.map(s => s.id));

  const annotatedNodes = nodes.map(n => ({
    id: n.id, label: n.label, team: n.team, status: n.status,
    on_critical_path: criticalNodes.has(n.id),
    is_stalled:       stalledIds.has(n.id),
    depends_on:       adj[n.id] || [],
  }));

  const annotatedEdges = edges.map(e => ({
    ...e,
    on_critical_path: criticalNodes.has(e.source) && criticalNodes.has(e.target),
  }));

  return { nodes: annotatedNodes, edges: annotatedEdges };
}

// ── P10 — Workflow Map ─────────────────────────────────────────────────────
// Classification derived from task type (no explicit column in schema)

async function getP10(orgId) {
  if (!USE_POSTGRES) return readMock("p10_workflows.json");

  const w = orgId ? "AND t.org_id = $1" : "";
  const p = orgId ? [orgId] : [];

  const tasks = await query(`
    SELECT DISTINCT ON (t.id)
           t.id, t.org_id,
           t.title                                                             AS description,
           t.type,
           t.status,
           COALESCE(i.role, 'Operations')                                      AS role,
           -- Group by source communication title as "workflow"
           COALESCE(c.title, 'General Operations')                             AS workflow,
           -- Derive classification from task type + status
           CASE t.type
             WHEN 'decision'    THEN 'JUDGMENT'
             WHEN 'blocker'     THEN 'JUDGMENT'
             WHEN 'action_item' THEN
               CASE WHEN t.status = 'completed' THEN 'ASSEMBLY'
                    ELSE 'ASSEMBLY_JUDGMENT' END
             WHEN 'milestone'   THEN 'ASSEMBLY_JUDGMENT'
             ELSE 'ASSEMBLY_JUDGMENT'
           END                                                                 AS classification,
           CASE t.type
             WHEN 'decision'    THEN 0.95
             WHEN 'blocker'     THEN 0.90
             WHEN 'action_item' THEN
               CASE WHEN t.status = 'completed' THEN 0.85 ELSE 0.75 END
             WHEN 'milestone'   THEN 0.70
             ELSE 0.65
           END                                                                 AS confidence,
           CASE t.type
             WHEN 'decision' THEN ARRAY['Strategic judgment required']::text[]
             WHEN 'blocker'  THEN ARRAY['External dependency', 'Risk assessment']::text[]
             ELSE ARRAY[]::text[]
           END                                                                 AS decision_points
    FROM public.tasks t
    LEFT JOIN public.task_owners o  ON t.id = o.task_id
    LEFT JOIN public.identities  i  ON o.identity_id = i.id
    LEFT JOIN public.provenance  pv ON pv.item_id = t.id
    LEFT JOIN public.communications c ON pv.source_comm_id = c.id
    WHERE 1=1 ${w}
    ORDER BY t.id, c.origin_date DESC NULLS LAST
  `, p);

  return { tasks };
}

// ── P11 — Integration Gaps ─────────────────────────────────────────────────
// Derived from blocked tasks — each blocker = a gap blocking downstream work

async function getP11(orgId) {
  if (!USE_POSTGRES) return readMock("p11_gaps.json");

  const w = orgId ? "AND b.org_id = $1" : "";
  const p = orgId ? [orgId] : [];

  const gaps = await query(`
    SELECT b.id, b.org_id,
           COALESCE(src_i.role, 'Internal')                                   AS source_system,
           COALESCE(tgt_i.role, 'Downstream Team')                            AS target_system,
           b.title                                                             AS missing_data,
           COALESCE(b.description, b.title)                                   AS downstream_task,
           -- hours estimate: pending blocked children × 3h each
           GREATEST(1, (
             SELECT COUNT(*) * 3
             FROM public.edges     e2
             JOIN public.tasks     bt ON e2.target_task_id = bt.id
             WHERE e2.source_task_id = b.id
               AND bt.status != 'completed'
           ))::integer                                                         AS staff_hours_lost_per_month,
           0.15                                                                AS error_rate,
           CASE
             WHEN b.deadline IS NOT NULL
               THEN GREATEST(1, (CURRENT_DATE - b.deadline::date))
             ELSE 3
           END                                                                 AS avg_delay_days
    FROM public.tasks b
    LEFT JOIN public.task_owners  o     ON b.id = o.task_id
    LEFT JOIN public.identities   src_i ON o.identity_id = src_i.id
    LEFT JOIN public.edges        e     ON e.source_task_id = b.id
    LEFT JOIN public.tasks        bt    ON e.target_task_id = bt.id
    LEFT JOIN public.task_owners  tgt_o ON bt.id = tgt_o.task_id
    LEFT JOIN public.identities   tgt_i ON tgt_o.identity_id = tgt_i.id
    WHERE b.type = 'blocker' AND b.status = 'blocked' ${w}
    GROUP BY b.id, b.org_id, b.title, b.description, b.deadline, src_i.role, tgt_i.role
    ORDER BY staff_hours_lost_per_month DESC
  `, p);

  const totalHours  = gaps.reduce((s, g) => s + Number(g.staff_hours_lost_per_month), 0);
  const simulation  = {
    role: "Operations Team",
    cases_per_month:       47,
    current_assembly_pct:  0.65,
    target_assembly_pct:   0.15,
    current_throughput:    47,
    projected_throughput:  Math.round(47 / 0.15 * 0.65),
  };

  return { gaps, simulation };
}

// ── P12 — Automation Roadmap ───────────────────────────────────────────────
// Pending / blocked tasks ranked into a prioritised recommendation list

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

  const w = orgId ? "AND t.org_id = $1" : "";
  const p = orgId ? [orgId] : [];

  const rows = await query(`
    SELECT t.id, t.org_id, t.title, t.type, t.status, t.deadline,
           COALESCE(t.description, 'Requires attention') AS rationale,
           -- recommendation type mapped from task type
           CASE t.type
             WHEN 'blocker'     THEN 'integrate'
             WHEN 'decision'    THEN 'preserve'
             ELSE 'automate'
           END                                                      AS type,
           -- priority within org: blocked blockers first, then pending, by deadline
           ROW_NUMBER() OVER (
             PARTITION BY t.org_id
             ORDER BY
               CASE t.status  WHEN 'blocked' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
               CASE t.type    WHEN 'blocker' THEN 0 WHEN 'action_item' THEN 1 ELSE 2 END,
               t.deadline NULLS LAST
           )                                                        AS priority,
           -- rough savings estimate: 3h/mo per blocked downstream task
           GREATEST(1, (
             SELECT COUNT(*) * 3
             FROM public.edges     e
             JOIN public.tasks     bt ON e.target_task_id = bt.id
             WHERE e.source_task_id = t.id AND bt.status != 'completed'
           ))::integer                                              AS estimated_hours_saved_per_month,
           'High'                                                   AS estimated_roi,
           NULL::text                                               AS linked_gap
    FROM public.tasks t
    WHERE t.status IN ('pending', 'blocked') ${w}
    ORDER BY priority
    LIMIT 20
  `, p);

  return {
    recommendations: rows.map(r => ({
      ...r,
      linked_gap_title: null,
    })),
  };
}

// ── Edit execution ─────────────────────────────────────────────────────────
// Executes an admin-confirmed change from POST /api/chat/confirm.
// Only public.tasks is writable — everything else is ingestion-owned.

async function applyEdit({ org_id, table, operation, where_id, set_fields = {} }) {
  // table arrives as e.g. "public.tasks"
  // Validate: only allow public.tasks
  const parts     = table.split(".");
  const schema    = (parts[0] || "").replace(/[^a-z0-9_]/g, "");
  const tableName = (parts[1] || parts[0]).replace(/[^a-z0-9_]/g, "");
  const safeTable = parts.length === 2 ? `${schema}.${tableName}` : tableName;

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

module.exports = { getP8, getP9, getGraph, getP10, getP11, getP12, getOrgIds, applyEdit, getPool };
