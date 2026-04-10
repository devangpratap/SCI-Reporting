/*
  P9 Panel — Critical-Path Stalls + Dependency Graph

  Two sections:
    1. Stall Alerts — items that are stuck/unresponsive, with severity
    2. Dependency Graph — static DAG of tasks/teams loaded once via direct fetch

  Stall data: GET /api/p9  → { stalls[] }
  Graph data: GET /api/p9/graph → { nodes[], edges[] }
    — loaded once on mount (static, doesn't need live MCP)
    — nodes: { id, label, team, status }
    — edges: { id, source, target }
*/

import { useEffect, useState } from "react";
import { fetchP9, fetchGraph } from "../api";
import { ReactFlow, Background, Controls, MiniMap } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const STATUS_COLOR = {
  in_progress: "#fb923c",
  pending: "#475569",
  completed: "#4ade80",
};

function buildFlowNodes(nodes) {
  // Auto-layout: spread nodes in rows of 3
  return nodes.map((n, i) => ({
    id: n.id,
    data: { label: `${n.label}\n[${n.team}]` },
    position: { x: (i % 3) * 220 + 40, y: Math.floor(i / 3) * 120 + 40 },
    style: {
      background: "rgba(21,26,38,0.95)",
      border: `1px solid ${STATUS_COLOR[n.status] || "#1e2435"}`,
      borderRadius: 10,
      color: "#e2e8f0",
      fontSize: 12,
      padding: "10px 14px",
      boxShadow: `0 0 12px ${STATUS_COLOR[n.status]}33`,
    },
  }));
}

function buildFlowEdges(edges) {
  return edges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    style: { stroke: "#334155", strokeWidth: 1.5 },
    animated: false,
  }));
}

export default function P9Panel() {
  const [stalls, setStalls] = useState(null);
  const [graph, setGraph] = useState(null);

  useEffect(() => {
    fetchP9().then(d => setStalls(d.stalls));
    fetchGraph().then(d => setGraph(d)); // loaded once, not via MCP
  }, []);

  const flowNodes = graph ? buildFlowNodes(graph.nodes) : [];
  const flowEdges = graph ? buildFlowEdges(graph.edges) : [];

  return (
    <div className="panel">
      {/* Stall stats */}
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
            <div className="value">{[...new Set(stalls.flatMap(s => s.affected_teams))].length}</div>
            <div className="label">Teams Affected</div>
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
                <span>Stalled since: {new Date(s.unresponsive_since).toLocaleDateString()}</span>
                <span>Affects: {s.affected_teams.join(", ")}</span>
              </div>
            </div>
          ))
        }
      </div>

      {/* Dependency graph */}
      <div className="card">
        <h2>Dependency Graph</h2>
        <div className="graph-container">
          {graph
            ? <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                fitView
                proOptions={{ hideAttribution: true }}
              >
                <Background color="#1e2435" gap={20} />
                <Controls />
                <MiniMap
                  nodeColor={n => n.style?.border?.includes("fb923c") ? "#fb923c" : "#334155"}
                  style={{ background: "#0f1117", border: "1px solid #1e2435" }}
                />
              </ReactFlow>
            : <div className="loading">Loading graph...</div>
          }
        </div>
      </div>
    </div>
  );
}
