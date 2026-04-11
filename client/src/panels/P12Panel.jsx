/*
  P12 Panel — Automation Roadmap

  Shows a prioritized list of what to fix/automate/preserve.
  Each recommendation has:
    - priority (1 = most urgent)
    - type: integrate | automate | preserve
    - estimated hours saved/month
    - estimated ROI
    - rationale
    - linked_gap_title: resolved gap name (joined server-side from sci_p11_gaps)

  Data comes from GET /api/p12 → { recommendations[] }
*/

import { useEffect, useState } from "react";
import { fetchP12 } from "../api";

const PRIORITY_CLASS = ["", "p1", "p2", "p3", "p4"];
const FILTERS = ["all", "integrate", "automate", "preserve"];

export default function P12Panel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    fetchP12().then(setData).catch(e => setError(e.message));
  }, []);

  if (error) return <div className="loading" style={{ color: "#f87171" }}>Failed to load: {error}</div>;
  if (!data) return <div className="loading">Loading roadmap...</div>;

  const { recommendations } = data;
  const visible = filter === "all" ? recommendations : recommendations.filter(r => r.type === filter);
  const totalHours = recommendations.reduce((s, r) => s + r.estimated_hours_saved_per_month, 0);

  return (
    <div className="panel">
      <div className="stat-row">
        <div className="stat">
          <div className="value">{recommendations.length}</div>
          <div className="label">Recommendations</div>
        </div>
        <div className="stat">
          <div className="value" style={{ color: "#4ade80" }}>{totalHours}h</div>
          <div className="label">Total Hours Saved/Mo</div>
        </div>
        <div className="stat">
          <div className="value">{recommendations.filter(r => r.type === "integrate").length}</div>
          <div className="label">Integrations</div>
        </div>
        <div className="stat">
          <div className="value" style={{ color: "#c084fc" }}>{recommendations.filter(r => r.type === "preserve").length}</div>
          <div className="label">Preserve Human</div>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 14 }}>Automation Roadmap — Prioritized</h2>

        {/* Filter tabs */}
        <div className="filter-tabs">
          {FILTERS.map(f => (
            <button
              key={f}
              className={`filter-tab ${filter === f ? "active" : ""} ${f !== "all" ? `filter-tab-${f}` : ""}`}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
              <span className="filter-tab-count">
                {f === "all" ? recommendations.length : recommendations.filter(r => r.type === f).length}
              </span>
            </button>
          ))}
        </div>

        {visible.map(r => (
          <div className="item" key={r.id}>
            <p style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className={`priority-dot ${PRIORITY_CLASS[r.priority]}`} />
              {r.title}
              <span className={`badge badge-${r.type}`}>{r.type}</span>
            </p>
            <p style={{ fontSize: 13, color: "#94a3b8", margin: "6px 0" }}>{r.rationale}</p>
            <div className="meta">
              <span>Priority #{r.priority}</span>
              {r.estimated_hours_saved_per_month > 0 && (
                <span style={{ color: "#4ade80" }}>
                  Saves {r.estimated_hours_saved_per_month}h/mo
                </span>
              )}
              <span>ROI: {r.estimated_roi}</span>
              {r.linked_gap_title && (
                <span style={{ color: "#60a5fa" }}>Fixes: {r.linked_gap_title}</span>
              )}
            </div>
          </div>
        ))}

        {visible.length === 0 && (
          <p style={{ color: "#475569", fontSize: 13, padding: "12px 0" }}>
            No {filter} recommendations.
          </p>
        )}
      </div>
    </div>
  );
}
