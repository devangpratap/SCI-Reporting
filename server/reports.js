/*
  reports.js — Static report writer

  Reads processed data from Databricks (via db.js), formats each panel
  as Markdown, and writes it to a PostgreSQL table.

  Uvicorn reads from this table to serve static reports to the UI.

  Table: sci_static_reports
    panel      VARCHAR(10) PRIMARY KEY  — "p8" | "p9" | "p10" | "p11" | "p12"
    content_md TEXT                     — full markdown report for this panel
    updated_at TIMESTAMP                — when this report was last written

  To connect: fill POSTGRES_* vars in .env — the feeding mechanism is ready.
  Refreshes automatically every hour while the server is running.
*/

const { Pool } = require("pg");
const db = require("./db");

const pool = new Pool({
  host:     process.env.POSTGRES_HOST,
  port:     parseInt(process.env.POSTGRES_PORT || "5432"),
  database: process.env.POSTGRES_DB,
  user:     process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  ssl:      process.env.POSTGRES_SSL === "true" ? { rejectUnauthorized: false } : false,
});

// ── Table bootstrap ────────────────────────────────────────────────────────

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sci_static_reports (
      panel      VARCHAR(10) PRIMARY KEY,
      content_md TEXT        NOT NULL,
      updated_at TIMESTAMP   NOT NULL DEFAULT NOW()
    )
  `);
}

// ── Markdown formatters (one per panel) ───────────────────────────────────

function fmtP8({ decisions, action_items, blockers }) {
  const lines = ["# P8 — Conversation State\n"];

  lines.push("## Decisions");
  decisions.forEach(d =>
    lines.push(`- **${d.summary}** (${d.status})\n  > ${d.rationale}\n  Participants: ${d.participants.join(", ")} · ${new Date(d.timestamp).toLocaleDateString()}`)
  );

  lines.push("\n## Action Items");
  const now = Date.now();
  action_items.forEach(a => {
    const overdue = a.status === "open" && new Date(a.deadline) < now;
    lines.push(`- [${a.status.toUpperCase()}${overdue ? " ⚠ OVERDUE" : ""}] ${a.description}\n  Owner: ${a.owner} · Due: ${new Date(a.deadline).toLocaleDateString()}`);
  });

  lines.push("\n## Active Blockers");
  blockers.filter(b => b.status === "active").forEach(b =>
    lines.push(`- **${b.description}**\n  Raised by: ${b.raised_by} · Blocking: ${b.blocking.join(", ")}`)
  );

  return lines.join("\n");
}

function fmtP9({ stalls }) {
  const lines = ["# P9 — Critical-Path Stalls\n"];
  if (!stalls.length) { lines.push("No active stalls."); return lines.join("\n"); }
  stalls.forEach(s =>
    lines.push(`## [${s.severity.toUpperCase()}] ${s.description}\n- Type: ${s.stall_type}\n- Stale since: ${new Date(s.unresponsive_since).toLocaleDateString()}\n- Affects: ${s.affected_teams.join(", ")}`)
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
    wTasks.forEach(t => {
      lines.push(`- **[${t.classification}]** ${t.description}\n  Role: ${t.role} · Confidence: ${Math.round(t.confidence * 100)}%${t.decision_points.length ? `\n  Why human: ${t.decision_points.join(", ")}` : ""}`);
    });
  });
  return lines.join("\n");
}

function fmtP11({ gaps, simulation }) {
  const total = gaps.reduce((s, g) => s + g.staff_hours_lost_per_month, 0);
  const lines = [
    `# P11 — Integration Gaps\n`,
    `**Total hours lost/month: ${total}h**\n`,
  ];
  gaps.forEach(g =>
    lines.push(`## ${g.source_system} → ${g.target_system}\n- Missing: ${g.missing_data}\n- Downstream task: ${g.downstream_task}\n- Cost: ${g.staff_hours_lost_per_month}h/mo · Error rate: ${Math.round(g.error_rate * 100)}% · Avg delay: ${g.avg_delay_days}d`)
  );
  const multiplier = (simulation.projected_throughput / simulation.current_throughput).toFixed(1);
  lines.push(`\n## Throughput Simulation — ${simulation.role}\n- Current: ${simulation.current_throughput} cases/mo (${simulation.current_assembly_pct * 100}% assembly)\n- After automation: ${simulation.projected_throughput} cases/mo → **${multiplier}× capacity**`);
  return lines.join("\n");
}

function fmtP12({ recommendations }) {
  const lines = ["# P12 — Automation Roadmap\n"];
  recommendations.forEach(r => {
    const savings = r.estimated_hours_saved_per_month > 0
      ? ` · Saves ${r.estimated_hours_saved_per_month}h/mo`
      : "";
    lines.push(`## #${r.priority} [${r.type.toUpperCase()}] ${r.title}\n- ROI: ${r.estimated_roi}${savings}\n- ${r.rationale}${r.linked_gap_title ? `\n- Fixes: ${r.linked_gap_title}` : ""}`);
  });
  return lines.join("\n");
}

// ── Write all reports to Postgres ─────────────────────────────────────────

async function refreshReports() {
  if (!process.env.POSTGRES_HOST) {
    console.log("[reports] POSTGRES_HOST not set — skipping write");
    return { skipped: true, reason: "no postgres credentials" };
  }

  try {
    await ensureTable();

    const [p8, p9, p10, p11, p12] = await Promise.all([
      db.getP8(), db.getP9(), db.getP10(), db.getP11(), db.getP12(),
    ]);

    const reports = [
      { panel: "p8",  content_md: fmtP8(p8)   },
      { panel: "p9",  content_md: fmtP9(p9)   },
      { panel: "p10", content_md: fmtP10(p10) },
      { panel: "p11", content_md: fmtP11(p11) },
      { panel: "p12", content_md: fmtP12(p12) },
    ];

    for (const r of reports) {
      await pool.query(
        `INSERT INTO sci_static_reports (panel, content_md, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (panel) DO UPDATE SET content_md = $2, updated_at = NOW()`,
        [r.panel, r.content_md]
      );
    }

    const at = new Date().toISOString();
    console.log(`[reports] wrote ${reports.length} panels to postgres at ${at}`);
    return { refreshed: reports.map(r => r.panel), at };
  } catch (err) {
    console.error("[reports] write failed:", err.message);
    return { error: err.message };
  }
}

// ── Hourly auto-refresh ────────────────────────────────────────────────────

const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

function startAutoRefresh() {
  // Run once immediately on startup, then every hour
  refreshReports();
  setInterval(refreshReports, INTERVAL_MS);
  console.log("[reports] auto-refresh started — every 1h");
}

module.exports = { refreshReports, startAutoRefresh };
