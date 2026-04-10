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

  useEffect(() => { fetchP11().then(setData); }, []);

  if (!data) return <div className="loading">Loading gap data...</div>;

  const { gaps, simulation } = data;
  const totalHours = gaps.reduce((s, g) => s + g.staff_hours_lost_per_month, 0);

  return (
    <div className="panel">
      <div className="stat-row">
        <div className="stat">
          <div className="value">{gaps.length}</div>
          <div className="label">Integration Gaps</div>
        </div>
        <div className="stat">
          <div className="value">{totalHours}h</div>
          <div className="label">Hours Lost / Month</div>
        </div>
        <div className="stat">
          <div className="value">{Math.round(gaps.reduce((s, g) => s + g.error_rate, 0) / gaps.length * 100)}%</div>
          <div className="label">Avg Error Rate</div>
        </div>
      </div>

      {/* Gaps */}
      <div className="card">
        <h2>Integration Gaps</h2>
        {gaps.map(g => (
          <div className="item" key={g.id}>
            <p>
              <strong style={{ color: "#f1f5f9" }}>{g.source_system}</strong>
              <span style={{ color: "#475569", margin: "0 8px" }}>→</span>
              <strong style={{ color: "#f1f5f9" }}>{g.target_system}</strong>
            </p>
            <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 8 }}>{g.missing_data}</p>
            <div className="meta">
              <span>Downstream: {g.downstream_task}</span>
            </div>
            <div className="meta" style={{ marginTop: 6 }}>
              <span style={{ color: "#f87171" }}>{g.staff_hours_lost_per_month}h lost/mo</span>
              <span>Error rate: {Math.round(g.error_rate * 100)}%</span>
              <span>Avg delay: {g.avg_delay_days}d</span>
            </div>
          </div>
        ))}
      </div>

      {/* Throughput simulation */}
      <div className="card">
        <h2>Throughput Simulation — {simulation.role}</h2>
        <div className="grid-2">
          <div>
            <h3>Current State</h3>
            <div className="item">
              <p>Assembly work: <strong style={{ color: "#f87171" }}>{simulation.current_assembly_pct * 100}%</strong></p>
              <p>Throughput: <strong>{simulation.current_throughput} cases/mo</strong></p>
            </div>
          </div>
          <div>
            <h3>After Automation</h3>
            <div className="item">
              <p>Assembly work: <strong style={{ color: "#4ade80" }}>{simulation.target_assembly_pct * 100}%</strong></p>
              <p>Throughput: <strong style={{ color: "#4ade80" }}>{simulation.projected_throughput} cases/mo</strong></p>
              <p style={{ fontSize: 12, color: "#475569", marginTop: 6 }}>
                +{Math.round(((simulation.projected_throughput - simulation.current_throughput) / simulation.current_throughput) * 100)}% capacity gain
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
