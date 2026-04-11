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

function staleSince(ts) {
  const hrs = Math.round((Date.now() - new Date(ts)) / 3_600_000);
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

function isOverdue(deadline) {
  return new Date(deadline) < new Date();
}

export default function P8Panel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchP8().then(setData).catch(e => setError(e.message));
  }, []);

  if (error) return <div className="loading" style={{ color: "#f87171" }}>Failed to load: {error}</div>;
  if (!data) return <div className="loading">Loading conversation state...</div>;

  const { decisions, action_items, blockers } = data;
  // Build a map so blockers can resolve action item descriptions
  const actionMap = Object.fromEntries(action_items.map(a => [a.id, a.description]));

  return (
    <div className="panel">
      {/* Stats */}
      <div className="stat-row">
        <div className="stat">
          <div className="value">{decisions.length}</div>
          <div className="label">Decisions</div>
        </div>
        <div className="stat">
          <div className="value">{action_items.filter(a => a.status === "open").length}</div>
          <div className="label">Open Items</div>
        </div>
        <div className="stat">
          <div className="value" style={{ color: "#f87171" }}>
            {action_items.filter(a => a.status === "open" && isOverdue(a.deadline)).length}
          </div>
          <div className="label">Overdue</div>
        </div>
        <div className="stat">
          <div className="value">{blockers.filter(b => b.status === "active").length}</div>
          <div className="label">Active Blockers</div>
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
            <div className="item" key={b.id} style={{ borderColor: b.status === "active" ? "rgba(239,68,68,0.25)" : undefined }}>
              <p>{b.description} <Badge value={b.status} /></p>
              <div className="meta" style={{ marginTop: 4 }}>
                <span>Raised by {b.raised_by}</span>
                <span style={{ color: "#f87171" }}>Stale {staleSince(b.timestamp)}</span>
              </div>
              {b.blocking.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  {b.blocking.map(id => (
                    <span key={id} className="pill pill-blocked">
                      {actionMap[id] || id}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Action Items */}
      <div className="card">
        <h2>Action Items</h2>
        {action_items.map(a => {
          const overdue = a.status === "open" && isOverdue(a.deadline);
          return (
            <div className="item" key={a.id} style={overdue ? { borderColor: "rgba(249,115,22,0.35)" } : {}}>
              <p>
                {a.description}
                <Badge value={a.status} />
                {overdue && <span className="badge badge-overdue">overdue</span>}
              </p>
              <div className="meta">
                <span>Owner: {a.owner}</span>
                <span style={overdue ? { color: "#fb923c" } : {}}>
                  Due: {new Date(a.deadline).toLocaleDateString()}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
