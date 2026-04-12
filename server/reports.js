/*
  reports.js — Static report writer

  Reads scored, workflow-grouped data from db.js, formats each panel as
  Markdown, and writes it to the static_reporting table every 12h.

  Each formatter:
    - Groups items by their resolved workflow (provenance → comm title, or parent task)
    - Ranks items by relevance_score DESC (computed in db.js)
    - Caps at a per-report maximum (25 hard cap) and drops items below score threshold
    - Cites sources back to the originating table row (public.tasks.id = ...)

  When the ingestion layer is dumb (every action = isolated task), the workflow
  resolver still groups them by their source communication. When ingestion improves
  and starts setting parent_task_id properly, nothing here needs to change.
*/

const { randomUUID } = require("crypto");
const db = require("./db");

function getPool() { return db.getPool(); }

// ── Table bootstrap ────────────────────────────────────────────────────────
async function ensureTable() {
  const pool = getPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS static_reporting (
        id                 TEXT   PRIMARY KEY,
        org_id             TEXT   NOT NULL,
        contents           TEXT   NOT NULL,
        timestamp_created  BIGINT NOT NULL,
        simple_overview    TEXT   NOT NULL
      )
    `);
  } catch { /* already exists under another owner — fine */ }
  try {
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_static_reporting_org_id ON static_reporting(org_id)
    `);
  } catch {}
}

// ── Shared helpers ─────────────────────────────────────────────────────────

const SCORE_THRESHOLD = 2; // items at or below this score are noise — omit
const MAX_ITEMS       = 25;

/**
 * Filter out noise and cap at MAX_ITEMS.
 * Keeps items with score > SCORE_THRESHOLD, up to max items.
 * If everything is above threshold but there are more than max, truncates.
 * If nothing clears threshold (empty/bad data), returns top 10 anyway so
 * the report is never blank.
 */
function rankAndCap(items, max = MAX_ITEMS) {
  const filtered = items.filter(i => Number(i.relevance_score ?? 0) > SCORE_THRESHOLD);
  const result   = (filtered.length > 0 ? filtered : items).slice(0, max);
  const omitted  = items.length - result.length;
  return { items: result, omitted, total: items.length };
}

/**
 * Group an array by workflow label, preserving score-sorted order within groups.
 * Returns [{ workflow, items }] sorted by the max score in each group DESC.
 */
function groupByWorkflow(items) {
  const map = new Map();
  for (const item of items) {
    const wf = item.workflow || "Standalone";
    if (!map.has(wf)) map.set(wf, []);
    map.get(wf).push(item);
  }
  return [...map.entries()]
    .map(([workflow, wfItems]) => ({
      workflow,
      items: wfItems,
      maxScore: Math.max(...wfItems.map(i => Number(i.relevance_score ?? 0))),
    }))
    .sort((a, b) => b.maxScore - a.maxScore);
}

/** Format a source citation line. */
function cite(item) {
  const parts = [`\`${item.source_ref}\``];
  if (item.workflow_source_ref) parts.push(`\`${item.workflow_source_ref}\``);
  return `  *Source: ${parts.join(" · ")}*`;
}

/** Format a deadline as a readable date or "no deadline". */
function fmtDate(d) {
  if (!d) return "no deadline";
  const date = new Date(d);
  if (isNaN(date)) return "no deadline";
  const overdue = date < new Date();
  return `${date.toLocaleDateString()}${overdue ? " ⚠ OVERDUE" : ""}`;
}

// ── Formatters ─────────────────────────────────────────────────────────────

function fmtState({ decisions, action_items, blockers }) {
  const lines = ["# Operations State\n"];

  // ── Decisions ──
  const dRank = rankAndCap(decisions, 10);
  lines.push(`## Decisions  *(${dRank.items.length} shown of ${dRank.total}${dRank.omitted > 0 ? `, ${dRank.omitted} below relevance threshold` : ""})*\n`);

  if (!dRank.items.length) {
    lines.push("_No decisions recorded._\n");
  } else {
    for (const group of groupByWorkflow(dRank.items)) {
      lines.push(`### Workflow: ${group.workflow}`);
      for (const d of group.items) {
        const participants = d.participants?.filter(Boolean).join(", ") || "Unknown";
        lines.push(
          `- **${d.summary}** · Status: ${d.status} · Score: ${d.relevance_score}`,
          `  > ${d.rationale}`,
          `  Participants: ${participants} · ${fmtDate(d.timestamp)}`,
          cite(d),
          ""
        );
      }
    }
  }

  // ── Action Items ──
  const aRank = rankAndCap(action_items, 15);
  lines.push(`## Action Items  *(${aRank.items.length} shown of ${aRank.total}${aRank.omitted > 0 ? `, ${aRank.omitted} below relevance threshold` : ""})*\n`);

  if (!aRank.items.length) {
    lines.push("_No action items recorded._\n");
  } else {
    for (const group of groupByWorkflow(aRank.items)) {
      lines.push(`### Workflow: ${group.workflow}`);
      for (const a of group.items) {
        const blocking = a.blocking?.filter(Boolean).length > 0
          ? ` · Blocking ${a.blocking.filter(Boolean).length} task(s)` : "";
        lines.push(
          `- **[${a.status.toUpperCase()}]** ${a.description} · Score: ${a.relevance_score}`,
          `  Owner: ${a.owner} · Due: ${fmtDate(a.deadline)}${blocking}`,
          cite(a),
          ""
        );
      }
    }
  }

  // ── Blockers — always show all, they're all relevant ──
  lines.push(`## Active Blockers  *(${blockers.length} total)*\n`);
  if (!blockers.length) {
    lines.push("_No blockers recorded._\n");
  } else {
    for (const group of groupByWorkflow(blockers)) {
      lines.push(`### Workflow: ${group.workflow}`);
      for (const b of group.items) {
        const blocking = b.blocking?.filter(Boolean).length > 0
          ? ` · Blocking: ${b.blocking.filter(Boolean).length} downstream task(s)` : "";
        lines.push(
          `- **${b.description}** · Status: ${b.status} · Score: ${b.relevance_score}`,
          `  Raised by: ${b.raised_by} · Since: ${fmtDate(b.timestamp)}${blocking}`,
          cite(b),
          ""
        );
      }
    }
  }

  return lines.join("\n");
}

function fmtStalls({ stalls }) {
  const { items, omitted, total } = rankAndCap(stalls);
  const lines = ["# Critical-Path Stalls\n"];

  if (!items.length) {
    lines.push("_No active stalls._");
    return lines.join("\n");
  }

  const high = items.filter(s => s.severity === "high").length;
  lines.push(`**${total} stalls total · ${high} high severity · showing top ${items.length}${omitted > 0 ? ` · ${omitted} omitted (low signal)` : ""}**\n`);

  for (const group of groupByWorkflow(items)) {
    lines.push(`## Workflow: ${group.workflow}`);
    for (const s of group.items) {
      const teams = s.affected_teams?.filter(Boolean).join(", ") || "Unknown";
      const downstream = s.downstream_blocked_count > 0
        ? ` · Blocking ${s.downstream_blocked_count} downstream task(s)` : "";
      lines.push(
        `### [${s.severity.toUpperCase()}] ${s.description}`,
        `- Type: ${s.stall_type} · Score: ${s.relevance_score}${downstream}`,
        `- Stale since: ${fmtDate(s.unresponsive_since)}`,
        `- Affected teams: ${teams}`,
        `- Context: ${s.context}`,
        cite(s),
        ""
      );
    }
  }

  return lines.join("\n");
}

function fmtGraph({ nodes, edges }) {
  const critical = nodes.filter(n => n.on_critical_path);
  const stalled  = nodes.filter(n => n.is_stalled);
  const lines    = ["# Dependency Graph\n"];

  lines.push(`**${nodes.length} nodes · ${edges.length} edges · ${critical.length} on critical path · ${stalled.length} stalled**\n`);

  lines.push("## Critical Path");
  if (!critical.length) {
    lines.push("_No critical path nodes detected._");
  } else {
    for (const n of critical) {
      lines.push(
        `- **${n.label}** · Status: ${n.status} · Team: ${n.team ?? "Unknown"}${n.is_stalled ? " ⚠ STALLED" : ""}`,
        `  Workflow: ${n.workflow || "Standalone"} · \`${n.source_ref}\``,
        ""
      );
    }
  }

  if (stalled.length) {
    lines.push("\n## Stalled Nodes");
    for (const n of stalled) {
      lines.push(
        `- **${n.label}** · ${n.on_critical_path ? "**ON critical path**" : "off critical path"} · Team: ${n.team ?? "Unknown"}`,
        `  \`${n.source_ref}\``,
        ""
      );
    }
  }

  lines.push("\n## All Nodes *(summary)*");
  // Group by workflow for summary
  const byWf = groupByWorkflow(nodes);
  for (const group of byWf) {
    const stalledInGroup = group.items.filter(n => n.is_stalled).length;
    const criticalInGroup = group.items.filter(n => n.on_critical_path).length;
    lines.push(
      `### ${group.workflow} — ${group.items.length} task(s)${criticalInGroup ? ` · ${criticalInGroup} critical` : ""}${stalledInGroup ? ` · ${stalledInGroup} stalled` : ""}`
    );
    for (const n of group.items) {
      lines.push(`- ${n.label} (${n.status})${n.on_critical_path ? " [CRITICAL]" : ""}${n.is_stalled ? " [STALLED]" : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function fmtWorkflows({ tasks }) {
  const { items, omitted, total } = rankAndCap(tasks);
  const lines = ["# Workflow Map\n"];

  const assembly   = items.filter(t => t.classification === "ASSEMBLY").length;
  const ajudgement = items.filter(t => t.classification === "ASSEMBLY_JUDGMENT").length;
  const judgment   = items.filter(t => t.classification === "JUDGMENT").length;

  lines.push(
    `**${total} tasks total · showing ${items.length}${omitted > 0 ? ` (${omitted} low-signal omitted)` : ""}**`,
    `ASSEMBLY: ${assembly} · ASSEMBLY_JUDGMENT: ${ajudgement} · JUDGMENT: ${judgment}\n`
  );

  for (const group of groupByWorkflow(items)) {
    lines.push(`## Workflow: ${group.workflow}`);
    for (const t of group.items) {
      lines.push(
        `- **[${t.classification}]** ${t.description} · Score: ${t.relevance_score}`,
        `  Role: ${t.role} · Confidence: ${Math.round(t.confidence * 100)}%${t.decision_points?.length ? ` · Human factors: ${t.decision_points.join(", ")}` : ""}`,
        cite(t),
        ""
      );
    }
  }

  return lines.join("\n");
}

function fmtGaps({ gaps, simulation }) {
  const { items, omitted, total } = rankAndCap(gaps);
  const totalHours = items.reduce((s, g) => s + Number(g.staff_hours_lost_per_month), 0);
  const allHours   = gaps.reduce((s, g) => s + Number(g.staff_hours_lost_per_month), 0);
  const lines = ["# Integration Gaps\n"];

  lines.push(
    `**${total} gaps identified · ${allHours}h lost/month total**`,
    `*Showing top ${items.length} by impact score${omitted > 0 ? ` · ${omitted} low-signal gaps omitted` : ""}. ${totalHours}h/month in shown gaps.*\n`
  );

  for (const group of groupByWorkflow(items)) {
    lines.push(`## Workflow: ${group.workflow}`);
    for (const g of group.items) {
      lines.push(
        `### ${g.source_system} → ${g.target_system} · Score: ${g.relevance_score}`,
        `- **Missing:** ${g.missing_data}`,
        `- **Downstream task:** ${g.downstream_task}`,
        `- **Cost:** ${g.staff_hours_lost_per_month}h/month · Error rate: ${Math.round(g.error_rate * 100)}% · Avg delay: ${g.avg_delay_days}d`,
        `- **Downstream blocked:** ${g.downstream_blocked_count} task(s)`,
        cite(g),
        ""
      );
    }
  }

  const mult = (simulation.projected_throughput / simulation.current_throughput).toFixed(1);
  lines.push(
    `## Throughput Simulation — ${simulation.role}`,
    `- Current: **${simulation.current_throughput} cases/month** at ${Math.round(simulation.current_assembly_pct * 100)}% assembly work`,
    `- If assembly drops to ${Math.round(simulation.target_assembly_pct * 100)}%: **${simulation.projected_throughput} cases/month → ${mult}× capacity**`
  );

  return lines.join("\n");
}

function fmtRoadmap({ recommendations }) {
  const { items, omitted, total } = rankAndCap(recommendations);
  const totalSaved = items.reduce((s, r) => s + Number(r.estimated_hours_saved_per_month), 0);
  const lines = ["# Automation Roadmap\n"];

  lines.push(
    `**${total} opportunities identified · ${totalSaved}h/month savings potential in top ${items.length}**`,
    `*${omitted > 0 ? `${omitted} low-priority items omitted. ` : ""}Ordered by economic impact — highest first.*\n`
  );

  const byType = { integrate: [], preserve: [], automate: [] };
  for (const r of items) byType[r.type]?.push(r);

  for (const [type, label] of [["integrate", "Integrate (Fix Gaps)"], ["preserve", "Preserve (Human Judgment)"], ["automate", "Automate (Assembly Work)"]]) {
    if (!byType[type].length) continue;
    lines.push(`## ${label}`);
    for (const group of groupByWorkflow(byType[type])) {
      lines.push(`### Workflow: ${group.workflow}`);
      for (const r of group.items) {
        const savings = r.estimated_hours_saved_per_month > 0
          ? ` · Saves ~${r.estimated_hours_saved_per_month}h/month` : "";
        lines.push(
          `- **#${r.priority} ${r.title}** · Score: ${r.relevance_score}${savings}`,
          `  ROI: ${r.estimated_roi} · ${r.rationale}`,
          cite(r),
          ""
        );
      }
    }
  }

  return lines.join("\n");
}

// ── Overview generators ────────────────────────────────────────────────────

function overviewState({ decisions, action_items, blockers }) {
  const overdue = action_items.filter(a => a.deadline && new Date(a.deadline) < new Date()).length;
  const highScoreBlockers = blockers.filter(b => Number(b.relevance_score ?? 0) > 5).length;
  return `${decisions.length} decisions · ${action_items.length} action items${overdue ? ` (${overdue} overdue)` : ""} · ${blockers.length} blockers${highScoreBlockers ? ` (${highScoreBlockers} critical)` : ""}`;
}

function overviewStalls({ stalls }) {
  const high = stalls.filter(s => s.severity === "high").length;
  const totalDownstream = stalls.reduce((s, st) => s + Number(st.downstream_blocked_count ?? 0), 0);
  return `${stalls.length} stalls · ${high} high severity · ${totalDownstream} downstream tasks blocked`;
}

function overviewGraph({ nodes, edges }) {
  const critical = nodes.filter(n => n.on_critical_path).length;
  const stalled  = nodes.filter(n => n.is_stalled).length;
  return `${nodes.length} nodes · ${edges.length} edges · ${critical} on critical path · ${stalled} stalled`;
}

function overviewWorkflows({ tasks }) {
  const assembly = tasks.filter(t => t.classification === "ASSEMBLY").length;
  const judgment = tasks.filter(t => t.classification === "JUDGMENT").length;
  const pct = tasks.length > 0 ? Math.round((assembly / tasks.length) * 100) : 0;
  return `${tasks.length} tasks · ${pct}% fully automatable · ${judgment} require human judgment`;
}

function overviewGaps({ gaps, simulation }) {
  const total   = gaps.reduce((s, g) => s + Number(g.staff_hours_lost_per_month), 0);
  const mult    = (simulation.projected_throughput / simulation.current_throughput).toFixed(1);
  return `${gaps.length} integration gaps · ${total}h lost/month · ${mult}× throughput potential`;
}

function overviewRoadmap({ recommendations }) {
  const totalSaved = recommendations.reduce((s, r) => s + Number(r.estimated_hours_saved_per_month), 0);
  const top = recommendations[0]?.title ?? "none";
  return `${recommendations.length} recommendations · ${totalSaved}h/month savings potential · top priority: ${top}`;
}

// ── Write all reports for one org ─────────────────────────────────────────

async function writeOrgReports(orgId) {
  const [state, stalls, graph, workflows, gaps, roadmap] = await Promise.all([
    db.getState(orgId), db.getStalls(orgId), db.getGraph(orgId),
    db.getWorkflows(orgId), db.getGaps(orgId), db.getRoadmap(orgId),
  ]);

  const reports = [
    { contents: fmtState(state),         simple_overview: overviewState(state)         },
    { contents: fmtStalls(stalls),       simple_overview: overviewStalls(stalls)       },
    { contents: fmtGraph(graph),         simple_overview: overviewGraph(graph)         },
    { contents: fmtWorkflows(workflows), simple_overview: overviewWorkflows(workflows) },
    { contents: fmtGaps(gaps),           simple_overview: overviewGaps(gaps)           },
    { contents: fmtRoadmap(roadmap),     simple_overview: overviewRoadmap(roadmap)     },
  ];

  const pool = getPool();
  const now  = new Date().toISOString();

  for (const r of reports) {
    await pool.query(
      `INSERT INTO static_reporting (id, org_id, contents, timestamp_created, simple_overview)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), orgId, r.contents, now, r.simple_overview]
    );
  }

  return reports.length;
}

// ── Public API ────────────────────────────────────────────────────────────

async function refreshReports(targetOrgId = null) {
  if (!process.env.DATABASE_URL) {
    console.log("[reports] DATABASE_URL not set — skipping write");
    return { skipped: true, reason: "no DATABASE_URL" };
  }

  try {
    await ensureTable();
    const orgIds  = targetOrgId ? [targetOrgId] : await db.getOrgIds();
    const results = [];

    for (const orgId of orgIds) {
      const count = await writeOrgReports(orgId);
      results.push({ orgId, panels: count });
    }

    const at = new Date().toISOString();
    console.log(`[reports] wrote ${results.length} org(s) at ${at}`);
    return { refreshed: results, at };
  } catch (err) {
    console.error("[reports] write failed:", err.message);
    return { error: err.message };
  }
}

function startAutoRefresh() {
  refreshReports();
  setInterval(refreshReports, 12 * 60 * 60 * 1000);
  console.log("[reports] auto-refresh started — every 12h");
}

module.exports = { refreshReports, startAutoRefresh };
