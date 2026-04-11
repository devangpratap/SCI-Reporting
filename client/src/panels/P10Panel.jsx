/*
  P10 Panel — Workflow Decomposition

  Shows each task in each workflow classified as:
    - ASSEMBLY: fully deterministic, no judgment needed
    - ASSEMBLY_JUDGMENT: AI-assisted, human reviews output
    - JUDGMENT: human-essential, requires empathy/negotiation/context

  Groups tasks by workflow for readability.
  Data comes from GET /api/p10 → { tasks[] }
*/

import { useEffect, useState } from "react";
import { fetchP10 } from "../api";

export default function P10Panel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchP10().then(setData).catch(e => setError(e.message));
  }, []);

  if (error) return <div className="loading" style={{ color: "#f87171" }}>Failed to load: {error}</div>;
  if (!data) return <div className="loading">Loading workflow data...</div>;

  const { tasks } = data;

  const byWorkflow = tasks.reduce((acc, t) => {
    if (!acc[t.workflow]) acc[t.workflow] = [];
    acc[t.workflow].push(t);
    return acc;
  }, {});

  const counts = {
    ASSEMBLY: tasks.filter(t => t.classification === "ASSEMBLY").length,
    ASSEMBLY_JUDGMENT: tasks.filter(t => t.classification === "ASSEMBLY_JUDGMENT").length,
    JUDGMENT: tasks.filter(t => t.classification === "JUDGMENT").length,
  };

  // Weighted coverage: ASSEMBLY = 1.0, ASSEMBLY_JUDGMENT = 0.5, JUDGMENT = 0
  const coverage = Math.round(
    ((counts.ASSEMBLY + counts.ASSEMBLY_JUDGMENT * 0.5) / tasks.length) * 100
  );

  return (
    <div className="panel">
      <div className="stat-row">
        <div className="stat">
          <div className="value" style={{ color: "#4ade80" }}>{counts.ASSEMBLY}</div>
          <div className="label">Assembly (Auto)</div>
        </div>
        <div className="stat">
          <div className="value" style={{ color: "#60a5fa" }}>{counts.ASSEMBLY_JUDGMENT}</div>
          <div className="label">Assembly + Judgment</div>
        </div>
        <div className="stat">
          <div className="value" style={{ color: "#c084fc" }}>{counts.JUDGMENT}</div>
          <div className="label">Judgment Only</div>
        </div>
        <div className="stat">
          <div className="value">{coverage}%</div>
          <div className="label">Automation Coverage</div>
        </div>
      </div>

      {Object.entries(byWorkflow).map(([workflow, wTasks]) => {
        const wAuto = wTasks.filter(t => t.classification === "ASSEMBLY").length;
        const wPartial = wTasks.filter(t => t.classification === "ASSEMBLY_JUDGMENT").length;
        const wPct = Math.round(((wAuto + wPartial * 0.5) / wTasks.length) * 100);
        return (
          <div className="card" key={workflow}>
            <h2>
              {workflow}
              <span style={{ marginLeft: "auto", fontSize: 12, color: "#475569", fontWeight: 400 }}>
                {wPct}% automatable
              </span>
              <div className="workflow-bar">
                <div className="workflow-bar-fill" style={{ width: `${wPct}%` }} />
              </div>
            </h2>
            {wTasks.map(t => (
              <div className="item" key={t.id}>
                <p>
                  {t.description}
                  <span className={`badge badge-${t.classification}`}>{t.classification}</span>
                </p>
                <div className="meta">
                  <span>Role: {t.role}</span>
                  <span>Confidence: {Math.round(t.confidence * 100)}%</span>
                </div>
                {t.decision_points.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {t.decision_points.map((dp, i) => (
                      <span key={i} className="pill pill-judgment">{dp}</span>
                    ))}
                  </div>
                )}
                <div className="progress-bar" style={{ marginTop: 10 }}>
                  <div className="progress-fill" style={{ width: `${t.confidence * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
