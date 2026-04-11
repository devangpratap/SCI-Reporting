/*
  P11 Panel — Integration Gaps & Tax

  Shows where data should flow between tools but doesn't,
  and quantifies the hidden cost of each gap.

  Also shows a throughput simulation: what happens when
  assembly work drops from ~65% to ~15% for a given role.

  Data comes from GET /api/p11 → { gaps[], simulation{} }
*/

import { useEffect, useState } from "react";
import { fetchP11 } from "../api";

export default function P11Panel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchP11().then(setData).catch(e => setError(e.message));
  }, []);

  if (error) return <div className="loading" style={{ color: "#f87171" }}>Failed to load: {error}</div>;
  if (!data) return <div className="loading">Loading gap data...</div>;

  const { gaps, simulation } = data;
  const totalHours = gaps.reduce((s, g) => s + g.staff_hours_lost_per_month, 0);
  const maxHours = Math.max(...gaps.map(g => g.staff_hours_lost_per_month));
  const throughputGain = ((simulation.projected_throughput - simulation.current_throughput) / simulation.current_throughput);
  const multiplier = (simulation.projected_throughput / simulation.current_throughput).toFixed(1);

  return (
    <div className="panel">
      <div className="stat-row">
        <div className="stat">
          <div className="value">{gaps.length}</div>
          <div className="label">Integration Gaps</div>
        </div>
        <div className="stat">
          <div className="value" style={{ color: "#f87171" }}>{totalHours}h</div>
          <div className="label">Hours Lost / Month</div>
        </div>
        <div className="stat">
          <div className="value">{Math.round(gaps.reduce((s, g) => s + g.error_rate, 0) / gaps.length * 100)}%</div>
          <div className="label">Avg Error Rate</div>
        </div>
        <div className="stat">
          <div className="value" style={{ color: "#4ade80" }}>{multiplier}×</div>
          <div className="label">Projected Throughput</div>
        </div>
      </div>

      {/* Gaps */}
      <div className="card">
        <h2>Integration Gaps — Cost Breakdown</h2>
        {gaps.map(g => (
          <div className="item" key={g.id}>
            <p>
              <strong style={{ color: "#f1f5f9" }}>{g.source_system}</strong>
              <span style={{ color: "#475569", margin: "0 8px" }}>→</span>
              <strong style={{ color: "#f1f5f9" }}>{g.target_system}</strong>
            </p>
            <p style={{ fontSize: 13, color: "#94a3b8", margin: "4px 0 8px" }}>{g.missing_data}</p>

            {/* Hours lost bar */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#475569", marginBottom: 4 }}>
                <span>{g.downstream_task}</span>
                <span style={{ color: "#f87171", fontWeight: 600 }}>{g.staff_hours_lost_per_month}h/mo</span>
              </div>
              <div className="hours-bar">
                <div className="hours-bar-fill" style={{ width: `${(g.staff_hours_lost_per_month / maxHours) * 100}%` }} />
              </div>
            </div>

            <div className="meta">
              <span>Error rate: {Math.round(g.error_rate * 100)}%</span>
              <span>Avg delay: {g.avg_delay_days}d</span>
            </div>
          </div>
        ))}
      </div>

      {/* Throughput simulation */}
      <div className="card">
        <h2>Throughput Simulation — {simulation.role}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 24, marginBottom: 20 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 42, fontWeight: 700, color: "#f87171", lineHeight: 1 }}>
              {simulation.current_throughput}
            </div>
            <div style={{ fontSize: 11, color: "#475569", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Current cases/mo
            </div>
          </div>
          <div style={{ fontSize: 28, color: "#475569" }}>→</div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 42, fontWeight: 700, color: "#4ade80", lineHeight: 1 }}>
              {simulation.projected_throughput}
            </div>
            <div style={{ fontSize: 11, color: "#475569", marginTop: 4, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              After automation
            </div>
          </div>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div style={{ fontSize: 36, fontWeight: 700, color: "#4ade80" }}>+{Math.round(throughputGain * 100)}%</div>
            <div style={{ fontSize: 12, color: "#475569" }}>capacity gain</div>
          </div>
        </div>
        <div className="grid-2">
          <div className="item">
            <p style={{ fontSize: 12, color: "#475569", textTransform: "uppercase", letterSpacing: "0.06em" }}>Current</p>
            <p style={{ marginTop: 6 }}>Assembly: <strong style={{ color: "#f87171" }}>{simulation.current_assembly_pct * 100}%</strong></p>
            <div className="progress-bar" style={{ marginTop: 8 }}>
              <div style={{ height: "100%", borderRadius: 3, background: "#f87171", width: `${simulation.current_assembly_pct * 100}%` }} />
            </div>
          </div>
          <div className="item">
            <p style={{ fontSize: 12, color: "#475569", textTransform: "uppercase", letterSpacing: "0.06em" }}>After Automation</p>
            <p style={{ marginTop: 6 }}>Assembly: <strong style={{ color: "#4ade80" }}>{simulation.target_assembly_pct * 100}%</strong></p>
            <div className="progress-bar" style={{ marginTop: 8 }}>
              <div style={{ height: "100%", borderRadius: 3, background: "#4ade80", width: `${simulation.target_assembly_pct * 100}%` }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
