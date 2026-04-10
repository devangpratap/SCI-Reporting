/*
  P10 Panel — Workflow Decomposition

  Shows each task in each workflow classified as:
    - automatable: fully deterministic, no judgment needed
    - ai-assisted: AI can help but human reviews
    - human-essential: requires empathy, negotiation, or judgment

  Groups tasks by workflow for readability.
  Data comes from GET /api/p10 → { tasks[] }
*/

import { useEffect, useState } from "react";
import { fetchP10 } from "../api";

export default function P10Panel() {
  const [data, setData] = useState(null);

  useEffect(() => { fetchP10().then(setData); }, []);

  if (!data) return <div className="loading">Loading workflow data...</div>;

  const { tasks } = data;

  // Group by workflow
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

  return (
    <div className="panel">
      <div className="stat-row">
        <div className="stat">
          <div className="value">{counts.ASSEMBLY}</div>
          <div className="label">Assembly (Auto)</div>
        </div>
        <div className="stat">
          <div className="value">{counts.ASSEMBLY_JUDGMENT}</div>
          <div className="label">Assembly + Judgment</div>
        </div>
        <div className="stat">
          <div className="value">{counts.JUDGMENT}</div>
          <div className="label">Judgment Only</div>
        </div>
        <div className="stat">
          <div className="value">{Math.round((counts.ASSEMBLY / tasks.length) * 100)}%</div>
          <div className="label">Automation Coverage</div>
        </div>
      </div>

      {Object.entries(byWorkflow).map(([workflow, wTasks]) => (
        <div className="card" key={workflow}>
          <h2>{workflow}</h2>
          {wTasks.map(t => (
            <div className="item" key={t.id}>
              <p>
                {t.description}
                <span className={`badge badge-${t.classification}`}>{t.classification}</span>
              </p>
              <div className="meta">
                <span>Role: {t.role}</span>
                <span>Confidence: {Math.round(t.confidence * 100)}%</span>
                {t.decision_points.length > 0 && (
                  <span>Why human: {t.decision_points.join(", ")}</span>
                )}
              </div>
              <div className="progress-bar" style={{ marginTop: 10 }}>
                <div className="progress-fill" style={{ width: `${t.confidence * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
