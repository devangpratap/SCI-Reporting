/*
  P9 Panel — Critical-Path Stalls + Dependency Graph

  Graph uses Cytoscape.js with dagre layout (directed acyclic graph, LR flow).
  Critical path + stall flags are pre-computed server-side — frontend just reads
  the flags and applies styles. No graph algorithms run in the browser.

  Space Coast theme:
    - Deep navy background
    - Cyan borders — launch glow
    - Orange critical path — rocket exhaust
    - Red dashed stalled nodes — abort signal
    - Star-trail bezier edges

  Data:
    Stalls: GET /api/p9  → { stalls[] }
    Graph:  GET /api/p9/graph → { nodes[], edges[] } — loaded once, direct fetch (no MCP)
      nodes: { id, label, team, status, on_critical_path, is_stalled, depends_on[] }
      edges: { id, source, target, on_critical_path }
*/

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import cytoscape from "cytoscape";
import dagre from "cytoscape-dagre";
import { fetchP9, fetchGraph } from "../api";

// Guard against HMR double-registration (cytoscape throws if you register twice)
try { cytoscape.use(dagre); } catch (_) { /* already registered */ }

// ── Cytoscape style — Space Coast theme ──────────────────────────────────
const CY_STYLE = [
  {
    selector: "node",
    style: {
      "label": "data(label)",
      "background-color": "#0a0f1e",
      "border-color": "#00d4ff",
      "border-width": 2,
      "color": "#e2e8f0",
      "font-family": "ui-monospace, monospace",
      "font-size": "12px",
      "text-valign": "center",
      "text-halign": "center",
      "text-wrap": "wrap",
      "text-max-width": "110px",
      "shape": "round-rectangle",
      "width": 130,
      "height": 48,
      "padding": "8px",
    },
  },
  {
    selector: "node[?on_critical_path]",
    style: {
      "border-color": "#f97316",
      "border-width": 3,
      "background-color": "#180a00",
      "overlay-color": "#f97316",
      "overlay-opacity": 0.06,
    },
  },
  {
    selector: "node[?is_stalled]",
    style: {
      "border-color": "#ef4444",
      "border-width": 3,
      "background-color": "#1a0000",
      "border-style": "dashed",
    },
  },
  {
    selector: "node[status='completed']",
    style: {
      "border-color": "#22c55e",
      "background-color": "#001a0a",
    },
  },
  {
    selector: "edge",
    style: {
      "line-color": "#1e3a5f",
      "target-arrow-color": "#00d4ff",
      "target-arrow-shape": "triangle",
      "curve-style": "bezier",
      "width": 1.5,
      "arrow-scale": 0.9,
    },
  },
  {
    selector: "edge[?on_critical_path]",
    style: {
      "line-color": "#f97316",
      "target-arrow-color": "#f97316",
      "width": 2.5,
    },
  },
];

// ── Legend items ───────────────────────────────────────────────────────────
const LEGEND = [
  { color: "#00d4ff", label: "Normal" },
  { color: "#f97316", label: "Critical Path" },
  { color: "#ef4444", label: "Stalled" },
  { color: "#22c55e", label: "Completed" },
];

export default function P9Panel() {
  const [stalls, setStalls] = useState(null);
  const [graph, setGraph] = useState(null);
  const cyRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    fetchP9().then(d => setStalls(d.stalls));
    fetchGraph().then(setGraph); // direct fetch, not MCP
  }, []);

  // Init Cytoscape after DOM paint using useLayoutEffect
  // This guarantees the container has real dimensions before cytoscape touches it
  useLayoutEffect(() => {
    if (!graph || !containerRef.current) return;

    // Destroy any previous instance
    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }

    const elements = [
      ...graph.nodes.map(n => ({
        data: {
          id: n.id,
          label: `${n.label}\n[${n.team}]`,
          on_critical_path: n.on_critical_path,
          is_stalled: n.is_stalled,
          status: n.status,
        },
      })),
      ...graph.edges.map(e => ({
        data: {
          id: e.id,
          source: e.source,
          target: e.target,
          on_critical_path: e.on_critical_path,
        },
      })),
    ];

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: CY_STYLE,
      layout: { name: "dagre", rankDir: "LR", nodeSep: 50, rankSep: 80, padding: 32 },
      userZoomingEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
    });

    cyRef.current = cy;
    console.log("cy nodes:", cy.nodes().length, "w:", containerRef.current?.offsetWidth, "h:", containerRef.current?.offsetHeight);

    // Use rAF to defer fit past React Strict Mode's synchronous cleanup window
    const rafId = requestAnimationFrame(() => {
      if (cyRef.current) cyRef.current.fit(undefined, 32);
    });

    return () => {
      cancelAnimationFrame(rafId);
      cy.destroy();
      cyRef.current = null;
    };
  }, [graph]);

  return (
    <div className="panel">
      {/* Stats */}
      {stalls && (
        <div className="stat-row">
          <div className="stat">
            <div className="value">{stalls.length}</div>
            <div className="label">Total Stalls</div>
          </div>
          <div className="stat">
            <div className="value">{stalls.filter(s => s.severity === "high").length}</div>
            <div className="label">High Severity</div>
          </div>
          <div className="stat">
            <div className="value">
              {[...new Set(stalls.flatMap(s => s.affected_teams))].length}
            </div>
            <div className="label">Teams Affected</div>
          </div>
          <div className="stat">
            <div className="value">
              {graph ? graph.nodes.filter(n => n.on_critical_path).length : "—"}
            </div>
            <div className="label">Critical Path Nodes</div>
          </div>
        </div>
      )}

      {/* Stall alerts */}
      <div className="card">
        <h2>⚠ Stall Alerts</h2>
        {!stalls
          ? <div className="loading">Loading...</div>
          : stalls.map(s => (
            <div className="item" key={s.id}>
              <p>
                {s.description}
                <span className={`badge badge-${s.severity}`}>{s.severity}</span>
              </p>
              <div className="meta">
                <span>Type: {s.stall_type.replace(/_/g, " ")}</span>
                <span>Since: {new Date(s.unresponsive_since).toLocaleDateString()}</span>
                <span>Affects: {s.affected_teams.join(", ")}</span>
              </div>
            </div>
          ))
        }
      </div>

      {/* Dependency graph */}
      <div className="card">
        <h2>Dependency Graph — Critical Path</h2>

        {/* Legend */}
        <div style={{ display: "flex", gap: 20, marginBottom: 14, flexWrap: "wrap" }}>
          {LEGEND.map(l => (
            <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <div style={{
                width: 10, height: 10, borderRadius: 2,
                border: `2px solid ${l.color}`,
                background: "#0a0f1e",
              }} />
              <span style={{ fontSize: 12, color: "#64748b" }}>{l.label}</span>
            </div>
          ))}
        </div>

        <div
          ref={containerRef}
          style={{
            height: 440,
            background: "#050810",
            border: "1px solid rgba(0,212,255,0.1)",
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          {!graph && <div className="loading">Loading graph...</div>}
        </div>
      </div>
    </div>
  );
}
