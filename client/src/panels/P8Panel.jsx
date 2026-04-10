/*
  P8 Panel — Conversation to State

  Displays the structured output extracted from raw multi-party communications.
  Three sections:
    - Decisions: what was agreed, by whom, and why
    - Action Items: who owns what, by when, and what status
    - Blockers: what is currently preventing progress

  Data comes from GET /api/p8
  Shape: { decisions[], action_items[], blockers[] }
*/

import { useEffect, useState } from "react";
import { fetchP8 } from "../api";

function Badge({ value }) {
  return <span className={`badge badge-${value}`}>{value}</span>;
}

export default function P8Panel() {
  const [data, setData] = useState(null);

  useEffect(() => { fetchP8().then(setData); }, []);

  if (!data) return <div className="loading">Loading conversation state...</div>;

  const { decisions, action_items, blockers } = data;

  return (
    <div className="panel">
      {/* Stats */}
      <div className="stat-row">
        <div className="stat">
          <div className="value">{decisions.length}</div>
          <div className="label">Decisions</div>
        </div>
        <div className="stat">
          <div className="value">{action_items.length}</div>
          <div className="label">Action Items</div>
        </div>
        <div className="stat">
          <div className="value">{blockers.filter(b => b.status === "active").length}</div>
          <div className="label">Active Blockers</div>
        </div>
        <div className="stat">
          <div className="value">{action_items.filter(a => a.status === "open").length}</div>
          <div className="label">Open Items</div>
        </div>
      </div>

      <div className="grid-2">
        {/* Decisions */}
        <div className="card">
          <h2>Decisions</h2>
          {decisions.map(d => (
            <div className="item" key={d.id}>
              <p>{d.summary} <Badge value={d.status} /></p>
              <div className="meta">
                <span>{d.rationale}</span>
              </div>
              <div className="meta" style={{ marginTop: 6 }}>
                <span>{d.participants.join(", ")}</span>
                <span>{new Date(d.timestamp).toLocaleDateString()}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Blockers */}
        <div className="card">
          <h2>Active Blockers</h2>
          {blockers.map(b => (
            <div className="item" key={b.id}>
              <p>{b.description} <Badge value={b.status} /></p>
              <div className="meta">
                <span>Raised by {b.raised_by}</span>
                <span>Blocking: {b.blocking.join(", ")}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Action Items */}
      <div className="card">
        <h2>Action Items</h2>
        {action_items.map(a => (
          <div className="item" key={a.id}>
            <p>{a.description} <Badge value={a.status} /></p>
            <div className="meta">
              <span>Owner: {a.owner}</span>
              <span>Due: {new Date(a.deadline).toLocaleDateString()}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
