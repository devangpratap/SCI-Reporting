/*
  edits.js — Pending database edit store

  When the AI calls propose_db_edit it stores a structured change here with a UUID.
  Nothing is written to Databricks until the admin confirms via POST /api/chat/confirm.

  Pending changes expire after 30 minutes (TTL_MS).
  Only the tables in ALLOWED_TABLES can be targeted — everything else is rejected.
*/

const { randomUUID } = require("crypto");

const TTL_MS = 30 * 60 * 1000; // 30 minutes

// Allowlist — only SCI operational tables
// Only groundswell.tasks is writable — all other tables are ingestion-owned
const ALLOWED_TABLES = new Set([
  "groundswell.tasks",
]);

// change_id → entry
const _pending = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────

function esc(v) {
  return String(v ?? "").replace(/'/g, "''");
}

function safeTable(t) {
  return t.split(".").map(s => s.replace(/[^a-z0-9_]/g, "")).join(".");
}

function buildPreview({ table, operation, where_id, set_fields, org_id }) {
  table = safeTable(table);
  const id  = esc(where_id);
  const org = esc(org_id);
  if (operation === "delete") {
    return `DELETE FROM ${table} WHERE id = '${id}' AND org_id = '${org}'`;
  }
  const setParts = Object.entries(set_fields || {})
    .map(([k, v]) => `${k} = '${esc(v)}'`)
    .join(", ");
  return `UPDATE ${table} SET ${setParts} WHERE id = '${id}' AND org_id = '${org}'`;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Store a proposed change and return its public descriptor.
 * Throws if table not in allowlist or operation invalid.
 *
 * @param {{ org_id, table, operation, where_id, set_fields, description }} opts
 * @returns {{ change_id, description, table, operation, preview }}
 */
function storePending({ org_id, table, operation, where_id, set_fields = {}, description }) {
  if (!ALLOWED_TABLES.has(table))
    throw new Error(`Table '${table}' is not in the allowlist`);
  if (!["update", "delete"].includes(operation))
    throw new Error(`operation must be 'update' or 'delete', got '${operation}'`);
  if (!where_id)
    throw new Error("where_id (record ID) is required");

  const change_id = randomUUID();
  const entry = { change_id, org_id, table, operation, where_id, set_fields, description };
  _pending.set(change_id, entry);

  // Auto-expire
  setTimeout(() => _pending.delete(change_id), TTL_MS);

  return {
    change_id,
    description,
    table,
    operation,
    preview: buildPreview({ ...entry }),
  };
}

/**
 * Retrieve a pending change by ID. Returns null if not found / expired.
 */
function getPending(change_id) {
  return _pending.get(change_id) ?? null;
}

/**
 * Remove a pending change (after apply or rejection).
 */
function removePending(change_id) {
  _pending.delete(change_id);
}

module.exports = { storePending, getPending, removePending };
