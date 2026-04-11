/*
  reports.js — Static report writer

  Reads processed data from db.js, formats each panel as Markdown,
  and writes it to the static_reporting table.

  Uvicorn reads from this table to serve static reports to the UI.

  Table schema (auto-created on startup):
    id                TEXT PRIMARY KEY  — UUID
    org_id            TEXT NOT NULL
    contents          TEXT NOT NULL     — full Markdown report for this panel
    timestamp_created BIGINT NOT NULL   — Unix epoch seconds
    simple_overview   TEXT NOT NULL     — one-line human summary

  Requires DATABASE_URL in .env — skips gracefully if not set.
  Refreshes automatically every hour while the server is running.
*/

const { randomUUID } = require("crypto");
const db = require("./db");

// Reuse the same pg pool as db.js — one connection pool for the whole server
function getPool() { return db.getPool(); }

// ── Table bootstrap ────────────────────────────────────────────────────────

async function ensureTable() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS static_reporting (
      id                 TEXT   PRIMARY KEY,
      org_id             TEXT   NOT NULL,
      contents           TEXT   NOT NULL,
      timestamp_created  BIGINT NOT NULL,
      simple_overview    TEXT   NOT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_static_reporting_org_id ON static_reporting(org_id)
  `);
}

// ── Markdown formatters (one per panel) ───────────────────────────────────

function fmtP8({ decisions, action_items, blockers }) {
  const lines = ["# P8 — Conversation State\n"];

  lines.push("## Decisions");
  decisions.forEach(d =>
    lines.push(`- **${d.summary}** (${d.status})\n  > ${d.rationale}\n  Participants: ${d.participants?.join(", ")} · ${new Date(d.timestamp).toLocaleDateString()}`)
  );

  lines.push("\n## Action Items");
  const now = Date.now();
  action_items.forEach(a => {
    const overdue = a.status === "open" && new Date(a.deadline) < now;
    lines.push(`- [${a.status.toUpperCase()}${overdue ? " ⚠ OVERDUE" : ""}] ${a.description}\n  Owner: ${a.owner} · Due: ${new Date(a.deadline).toLocaleDateString()}`);
  });

  lines.push("\n## Active Blockers");
  blockers.filter(b => b.status === "active").forEach(b =>
    lines.push(`- **${b.description}**\n  Raised by: ${b.raised_by} · Blocking: ${b.blocking?.join(", ")}`)
  );

  return lines.join("\n");
}

function fmtP9({ stalls }) {
  const lines = ["# P9 — Critical-Path Stalls\n"];
  if (!stalls.length) { lines.push("No active stalls."); return lines.join("\n"); }
  stalls.forEach(s =>
    lines.push(`## [${s.severity.toUpperCase()}] ${s.description}\n- Type: ${s.stall_type}\n- Stale since: ${new Date(s.unresponsive_since).toLocaleDateString()}\n- Affects: ${s.affected_teams?.join(", ")}`)
  );
  return lines.join("\n");
}

function fmtP10({ tasks }) {
  const lines = ["# P10 — Workflow Map\n"];
  const byWorkflow = tasks.reduce((acc, t) => {
    (acc[t.workflow] = acc[t.workflow] || []).push(t);
    return acc;
  }, {});
  Object.entries(byWorkflow).forEach(([wf, wTasks]) => {
    lines.push(`## ${wf}`);
    wTasks.forEach(t =>
      lines.push(`- **[${t.classification}]** ${t.description}\n  Role: ${t.role} · Confidence: ${Math.round(t.confidence * 100)}%${t.decision_points?.length ? `\n  Why human: ${t.decision_points.join(", ")}` : ""}`)
    );
  });
  return lines.join("\n");
}

function fmtP11({ gaps, simulation }) {
  const total = gaps.reduce((s, g) => s + g.staff_hours_lost_per_month, 0);
  const lines = [`# P11 — Integration Gaps\n`, `**Total hours lost/month: ${total}h**\n`];
  gaps.forEach(g =>
    lines.push(`## ${g.source_system} → ${g.target_system}\n- Missing: ${g.missing_data}\n- Downstream task: ${g.downstream_task}\n- Cost: ${g.staff_hours_lost_per_month}h/mo · Error rate: ${Math.round(g.error_rate * 100)}% · Avg delay: ${g.avg_delay_days}d`)
  );
  const multiplier = (simulation.projected_throughput / simulation.current_throughput).toFixed(1);
  lines.push(`\n## Throughput Simulation — ${simulation.role}\n- Current: ${simulation.current_throughput} cases/mo\n- After automation: ${simulation.projected_throughput} cases/mo → **${multiplier}× capacity**`);
  return lines.join("\n");
}

function fmtP12({ recommendations }) {
  const lines = ["# P12 — Automation Roadmap\n"];
  recommendations.forEach(r => {
    const savings = r.estimated_hours_saved_per_month > 0
      ? ` · Saves ${r.estimated_hours_saved_per_month}h/mo` : "";
    lines.push(`## #${r.priority} [${r.type.toUpperCase()}] ${r.title}\n- ROI: ${r.estimated_roi}${savings}\n- ${r.rationale}${r.linked_gap_title ? `\n- Fixes: ${r.linked_gap_title}` : ""}`);
  });
  return lines.join("\n");
}

// ── One-line overview generators ──────────────────────────────────────────

function overviewP8({ decisions, action_items, blockers }) {
  const overdue = action_items.filter(a => a.status === "open" && new Date(a.deadline) < Date.now()).length;
  return `${decisions.length} decisions · ${action_items.filter(a => a.status === "open").length} open items${overdue ? ` · ${overdue} overdue` : ""} · ${blockers.filter(b => b.status === "active").length} active blockers`;
}
function overviewP9({ stalls }) {
  const high = stalls.filter(s => s.severity === "high").length;
  return `${stalls.length} stalls${high ? ` (${high} high severity)` : ""} · teams: ${[...new Set(stalls.flatMap(s => s.affected_teams ?? []))].join(", ") || "none"}`;
}
function overviewP10({ tasks }) {
  const auto = tasks.filter(t => t.classification === "ASSEMBLY").length;
  return `${tasks.length} tasks · ${Math.round((auto / tasks.length) * 100)}% fully automatable · ${tasks.filter(t => t.classification === "JUDGMENT").length} require human judgment`;
}
function overviewP11({ gaps, simulation }) {
  const total = gaps.reduce((s, g) => s + g.staff_hours_lost_per_month, 0);
  return `${gaps.length} integration gaps · ${total}h lost/month · ${(simulation.projected_throughput / simulation.current_throughput).toFixed(1)}× throughput potential`;
}
function overviewP12({ recommendations }) {
  const totalSaved = recommendations.reduce((s, r) => s + r.estimated_hours_saved_per_month, 0);
  return `${recommendations.length} recommendations · ${totalSaved}h/month savings potential · top: ${recommendations[0]?.title ?? "none"}`;
}

// ── Write all reports for one org ─────────────────────────────────────────

async function writeOrgReports(orgId) {
  const [p8, p9, p10, p11, p12] = await Promise.all([
    db.getP8(orgId), db.getP9(orgId), db.getP10(orgId), db.getP11(orgId), db.getP12(orgId),
  ]);

  const reports = [
    { contents: fmtP8(p8),   simple_overview: overviewP8(p8)   },
    { contents: fmtP9(p9),   simple_overview: overviewP9(p9)   },
    { contents: fmtP10(p10), simple_overview: overviewP10(p10) },
    { contents: fmtP11(p11), simple_overview: overviewP11(p11) },
    { contents: fmtP12(p12), simple_overview: overviewP12(p12) },
  ];

  const pool = getPool();
  const now  = Math.floor(Date.now() / 1000);

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
    const orgIds = targetOrgId ? [targetOrgId] : await db.getOrgIds();
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
  setInterval(refreshReports, 60 * 60 * 1000);
  console.log("[reports] auto-refresh started — every 1h");
}

module.exports = { refreshReports, startAutoRefresh };
