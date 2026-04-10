/*
  SCI Reporting — Main Dashboard

  Modular reporting layer for the B2B Operations Intelligence track (P8–P12).
  Each vertical is an independent panel — plug in as teammates finish their work.

  Navigation:
    P8  — Conversation to State (decisions, action items, blockers)
    P9  — Critical-Path Stalls + Dependency Graph
    P10 — Workflow Decomposition (automatable vs human-essential tasks)
    P11 — Integration Gaps & Tax (hidden costs of broken data flows)
    P12 — Automation Roadmap (prioritized fix list)

  To add a new vertical: create a panel in /panels, add a fetch fn in api.js,
  add a nav button + tab entry here. Nothing else changes.
*/

import { useState } from "react";
import P8Panel from "./panels/P8Panel";
import P9Panel from "./panels/P9Panel";
import P10Panel from "./panels/P10Panel";
import P11Panel from "./panels/P11Panel";
import P12Panel from "./panels/P12Panel";

const TABS = [
  { id: "p8",  label: "P8 · Conversation State" },
  { id: "p9",  label: "P9 · Stalls & Graph" },
  { id: "p10", label: "P10 · Workflow Map" },
  { id: "p11", label: "P11 · Integration Gaps" },
  { id: "p12", label: "P12 · Roadmap" },
];

const PANELS = { p8: P8Panel, p9: P9Panel, p10: P10Panel, p11: P11Panel, p12: P12Panel };

export default function App() {
  const [active, setActive] = useState("p8");
  const Panel = PANELS[active];

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>SCI Reporting — B2B Operations Intelligence</h1>
        <span className="subtitle">MyelAI · Problems 8–12 · SCI Hackathon 2026</span>
      </div>

      <nav className="nav">
        {TABS.map(t => (
          <button
            key={t.id}
            className={active === t.id ? "active" : ""}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <Panel />
    </div>
  );
}
