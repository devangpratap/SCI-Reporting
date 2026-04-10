/*
  P12 Panel — Automation Roadmap

  Shows a prioritized list of what to fix/automate/preserve.
  Each recommendation has:
    - priority (1 = most urgent)
    - type: integrate | automate | preserve
    - estimated hours saved/month
    - estimated ROI
    - rationale

  Data comes from GET /api/p12 → { recommendations[] }
*/

import { useEffect, useState } from "react";
import { fetchP12 } from "../api";

const PRIORITY_CLASS = ["", "p1", "p2", "p3", "p4"];

export default function P12Panel() {
  const [data, setData] = useState(null);

  useEffect(() => { fetchP12().then(setData); }, []);

  if (!data) return <div className="loading">Loading roadmap...</div>;

  const { recommendations } = data;
  const totalHours = recommendations.reduce((s, r) => s + r.estimated_hours_saved_per_month, 0);

  return (
    <div className="panel">
      <div className="stat-row">
        <div className="stat">
          <div className="value">{recommendations.length}</div>
          <div className="label">Recommendations</div>
        </div>
        <div className="stat">
          <div className="value">{totalHours}h</div>
          <div className="label">Total Hours Saved/Mo</div>
        </div>
        <div className="stat">
          <div className="value">{recommendations.filter(r => r.type === "preserve").length}</div>
          <div className="label">Preserve Human</div>
        </div>
      </div>

      <div className="card">
        <h2>Automation Roadmap — Prioritized</h2>
        {recommendations.map(r => (
          <div className="item" key={r.id}>
            <p style={{ display: "flex", alignItems: "center" }}>
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
              {r.linked_gap && <span>Fixes gap: {r.linked_gap}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
