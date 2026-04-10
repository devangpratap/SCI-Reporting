# SCI Reporting — B2B Operations Intelligence Dashboard

Modular reporting layer for the **Space Coast Initiative Hackathon 2026**, Problems 8–12, sponsored by **MyelAI**.

Built with React + Vite (frontend), Express (API), Databricks SQL (data source), and an MCP server so Claude can query the data directly in natural language.

---

## What This Does

This repo is the **reporting layer only**. It does not do NLP, graph construction, ML classification, or data ingestion — those are other teams' jobs. This repo:

1. Reads structured output from Databricks tables (produced by other verticals)
2. Displays it as a live dashboard with 5 panels (one per problem)
3. Exposes all data as MCP tools so Claude can query it conversationally

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Databricks Lakehouse                  │
│  sci_p8_decisions    sci_p9_stalls    sci_p10_tasks      │
│  sci_p8_action_items sci_p9_nodes    sci_p11_gaps        │
│  sci_p8_blockers     sci_p9_edges    sci_p12_recommendations │
└───────────────────────────┬─────────────────────────────┘
                            │ SQL queries (@databricks/sql)
                ┌───────────▼────────────┐
                │   Express API Server   │  :3001
                │       server/          │
                │   db.js (data layer)   │
                └───────────┬────────────┘
                 ┌──────────┴──────────┐
                 │                     │
    ┌────────────▼──────┐   ┌──────────▼──────────┐
    │   React Frontend  │   │     MCP Server       │
    │   client/  :5173  │   │     mcp/             │
    │  5 panel tabs     │   │  5 tools for Claude  │
    └───────────────────┘   └─────────────────────┘
```

**During development (before Saturday):** `DATA_SOURCE=mock` in `.env` makes the server read local JSON files from `server/mock/` instead of Databricks. The frontend and MCP are identical in both modes.

---

## Tech Stack

| Layer | Tech | Why |
|---|---|---|
| Frontend | React 19 + Vite | Fast dev, modern JSX |
| Graph | @xyflow/react (React Flow) | React 19 compatible DAG rendering |
| Icons | lucide-react | Clean icon set |
| API server | Express + CORS | Thin routing, easy to swap data source |
| Database | @databricks/sql | Official Databricks SQL connector |
| Config | dotenv | Env-based data source switching |
| MCP server | @modelcontextprotocol/sdk | Exposes data as Claude-queryable tools |

---

## Project Structure

```
SCI-Reporting/
├── client/                   React + Vite frontend
│   └── src/
│       ├── App.jsx           Main dashboard shell + nav
│       ├── api.js            All fetch calls (single source of truth)
│       ├── index.css         All styles (dark theme, badges, cards)
│       └── panels/
│           ├── P8Panel.jsx   Conversation State (decisions, action items, blockers)
│           ├── P9Panel.jsx   Stalls + Dependency Graph
│           ├── P10Panel.jsx  Workflow Decomposition
│           ├── P11Panel.jsx  Integration Gaps & Tax
│           └── P12Panel.jsx  Automation Roadmap
│
├── server/
│   ├── index.js              Express routes (thin — just calls db.js)
│   ├── db.js                 Data layer: Databricks or mock, controlled by .env
│   ├── .env                  Credentials (gitignored)
│   ├── .env.example          Template for credentials
│   └── mock/                 Local JSON fallback data
│       ├── p8_conversations.json
│       ├── p9_stalls.json    (also contains nodes + edges for graph)
│       ├── p10_workflows.json
│       ├── p11_gaps.json
│       └── p12_roadmap.json
│
└── mcp/
    └── index.js              MCP server with 5 tools
```

---

## Setup

### 1. Install dependencies

```bash
# API server
cd server && npm install

# Frontend
cd client && npm install

# MCP server
cd mcp && npm install
```

### 2. Configure environment

```bash
cp server/.env.example server/.env
```

Edit `server/.env`:

```env
# Leave blank and set DATA_SOURCE=mock to use local JSON
DATABRICKS_HOST=your-workspace.azuredatabricks.net
DATABRICKS_TOKEN=your-personal-access-token
DATABRICKS_HTTP_PATH=/sql/1.0/warehouses/your-warehouse-id

# "mock" = local JSON files, "databricks" = real Databricks queries
DATA_SOURCE=mock
```

### 3. Run

In three separate terminals:

```bash
# Terminal 1 — API server
cd server && node index.js

# Terminal 2 — Frontend
cd client && npm run dev

# Terminal 3 — MCP (optional, for Claude Desktop integration)
cd mcp && node index.js
```

Dashboard: `http://localhost:5173`
API: `http://localhost:3001`

---

## Switching to Databricks (Saturday)

1. Fill in `.env` with credentials from the Databricks sponsor token
2. Change `DATA_SOURCE=mock` → `DATA_SOURCE=databricks`
3. Restart the server — nothing else changes

The frontend and MCP server are completely unaffected.

---

## Databricks Table Schema

Teammates writing to Databricks must create these tables. Column names matter — the SQL queries in `db.js` select `*` so any extra columns are fine, but these must exist:

### `sci_p8_decisions`
| Column | Type | Description |
|---|---|---|
| id | STRING | Unique decision ID |
| summary | STRING | One-line summary of what was decided |
| rationale | STRING | Why it was decided |
| participants | ARRAY<STRING> | Email list of people involved |
| status | STRING | `open` or `closed` |
| timestamp | TIMESTAMP | When the decision was made |

### `sci_p8_action_items`
| Column | Type | Description |
|---|---|---|
| id | STRING | Unique action item ID |
| description | STRING | What needs to be done |
| owner | STRING | Email of person responsible |
| deadline | TIMESTAMP | Due date (explicit or implied) |
| status | STRING | `open` or `closed` |

### `sci_p8_blockers`
| Column | Type | Description |
|---|---|---|
| id | STRING | Unique blocker ID |
| description | STRING | What is blocking progress |
| blocking | ARRAY<STRING> | List of action item IDs being blocked |
| raised_by | STRING | Email of person who raised it |
| status | STRING | `active` or `resolved` |
| timestamp | TIMESTAMP | When it was raised |

### `sci_p9_stalls`
| Column | Type | Description |
|---|---|---|
| id | STRING | Unique stall ID |
| task_id | STRING | ID of the stalled task/action item |
| description | STRING | What is stalled and why |
| stall_type | STRING | `undelivered_decision` or `unresponsive_owner` |
| severity | STRING | `high`, `medium`, or `low` |
| unresponsive_since | TIMESTAMP | When it stopped moving |
| affected_teams | ARRAY<STRING> | Teams blocked by this stall |

### `sci_p9_nodes` (dependency graph)
| Column | Type | Description |
|---|---|---|
| id | STRING | Node ID (e.g. `n1`) |
| label | STRING | Display name |
| team | STRING | Team responsible |
| status | STRING | `pending`, `in_progress`, or `completed` |

### `sci_p9_edges` (dependency graph)
| Column | Type | Description |
|---|---|---|
| id | STRING | Edge ID (e.g. `e1`) |
| source | STRING | Source node ID |
| target | STRING | Target node ID |

### `sci_p10_tasks`
| Column | Type | Description |
|---|---|---|
| id | STRING | Unique task ID |
| role | STRING | Job role performing this task |
| workflow | STRING | Workflow name (e.g. `Invoice Reconciliation`) |
| description | STRING | What the task involves |
| classification | STRING | `ASSEMBLY`, `ASSEMBLY_JUDGMENT`, or `JUDGMENT` |
| confidence | FLOAT | Model confidence 0–1 |
| decision_points | ARRAY<STRING> | Reasons why human judgment is needed |
| dependencies | ARRAY<STRING> | IDs of tasks this depends on |

**Classification enum:**
- `ASSEMBLY` — fully automatable, deterministic
- `ASSEMBLY_JUDGMENT` — AI-assisted, human reviews
- `JUDGMENT` — human-essential, requires empathy/negotiation

### `sci_p11_gaps`
| Column | Type | Description |
|---|---|---|
| id | STRING | Unique gap ID |
| source_system | STRING | System where data originates |
| target_system | STRING | System that needs the data |
| missing_data | STRING | What data is not flowing |
| downstream_task | STRING | Manual work this gap causes |
| staff_hours_lost_per_month | INT | Quantified cost in hours |
| error_rate | FLOAT | Error rate caused by manual handling (0–1) |
| avg_delay_days | FLOAT | Average delay introduced |

### `sci_p12_recommendations`
| Column | Type | Description |
|---|---|---|
| id | STRING | Unique recommendation ID |
| priority | INT | 1 = highest priority |
| type | STRING | `automate`, `integrate`, or `preserve` |
| title | STRING | What to do |
| linked_gap | STRING | Gap ID from sci_p11_gaps (nullable) |
| estimated_hours_saved_per_month | INT | Projected savings |
| estimated_roi | STRING | `high`, `medium`, `low`, or `none` |
| rationale | STRING | Why this is the right call |

---

## MCP Server

The MCP server lets Claude query any vertical in natural language. Registered in Claude Desktop automatically via `claude_desktop_config.json`.

**Available tools:**

| Tool | Description | Filters |
|---|---|---|
| `get_conversation_state` | P8: decisions, action items, blockers | `filter_status: all/open/closed/active` |
| `get_stalls` | P9: critical-path stall alerts | `severity: all/high/medium/low` |
| `get_workflow_map` | P10: task classifications | `classification`, `workflow` |
| `get_integration_gaps` | P11: gaps + cost simulation | none |
| `get_roadmap` | P12: automation roadmap | `type: all/automate/integrate/preserve` |

Example Claude queries once MCP is connected:
- *"What are the high severity stalls right now?"*
- *"Show me all JUDGMENT tasks in the Invoice Reconciliation workflow"*
- *"What integrations should we fix first?"*

The MCP server calls the Express API (`localhost:3001`), which means it uses the same data source (mock or Databricks) as the dashboard.

---

## Adding a New Vertical

1. Create the Databricks table
2. Add a mock JSON file in `server/mock/`
3. Add a query function in `server/db.js`
4. Add a route in `server/index.js`
5. Add a fetch function in `client/src/api.js`
6. Create a panel component in `client/src/panels/`
7. Add it to the nav in `client/src/App.jsx`
8. Add an MCP tool in `mcp/index.js`

Each step is isolated — nothing else in the codebase needs to change.

---

## Dashboard Panels

### P8 — Conversation State
Reads decisions, action items, and blockers extracted from raw communications (meetings, emails, Slack). Shows stat cards at the top (total decisions, open items, active blockers), then a 2-column grid of decisions vs blockers, then a full-width action items list.

### P9 — Stalls & Graph
Two sections: stall alert cards (severity-badged, with stall type and affected teams), and a React Flow dependency graph showing task nodes color-coded by status (orange = in progress, grey = pending, green = done) with directional edges.

### P10 — Workflow Map
Groups tasks by workflow. Each task shows its classification badge (green=ASSEMBLY, blue=ASSEMBLY_JUDGMENT, purple=JUDGMENT), role, confidence score, and a gradient progress bar for confidence. Stat cards show counts per classification type and overall automation coverage %.

### P11 — Integration Gaps
Lists each system-to-system gap with source/target systems, what data is missing, downstream manual work caused, hours lost per month, error rate, and avg delay. Below the gaps, a throughput simulation card shows current vs projected capacity when assembly work drops from ~65% to ~15%.

### P12 — Automation Roadmap
Priority-ordered recommendations with colored priority dots (red=1, orange=2, yellow=3, green=4), type badge (integrate/automate/preserve), hours saved per month, ROI estimate, and rationale.

---

## Notes for Future Devs Using Claude Code

This codebase is documented in natural language throughout so Claude Code can understand and modify it without needing to reverse-engineer anything.

**Key files to read first:**
- `server/db.js` — all data logic, one function per vertical
- `client/src/api.js` — all fetch calls in one place
- `client/src/App.jsx` — how panels are registered and rendered

**To change the data source:** only touch `server/db.js` and `.env`

**To change what's displayed:** only touch the relevant panel in `client/src/panels/`

**To add Claude querying capability:** only touch `mcp/index.js`

The three layers (data, API, frontend) are intentionally decoupled so a future dev can work on any one without touching the others.
