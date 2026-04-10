# Architecture & Problem Breakdown

## System Layers

```
┌─────────────────────────────────────────────────────┐
│  RAW DATA (MyelAI Dataset)                          │
│  meeting transcripts · emails · slack · activity    │
│  logs · workflow JSONs · integration_map.json       │
└────────────────────┬────────────────────────────────┘
                     │
        ┌────────────▼────────────┐
        │  NLP / ML PIPELINE      │  ← teammates build this
        │  P8: extract decisions  │
        │  P9: detect stalls      │
        │  P10: classify tasks    │
        │  P11: find gaps         │
        │  P12: build roadmap     │
        └────────────┬────────────┘
                     │ writes structured rows
        ┌────────────▼────────────┐
        │  DATABRICKS LAKEHOUSE   │  ← shared storage
        │  sci_p8_decisions       │
        │  sci_p9_stalls          │
        │  sci_p10_tasks  etc.    │
        └──────┬──────────┬───────┘
               │          │
   ┌───────────▼──┐  ┌────▼──────────────┐
   │  Dashboard   │  │  MCP Server        │
   │  (you built) │  │  (you built)       │
   │  React :5173 │  │  Claude queries it │
   └──────────────┘  └────────────────────┘
```

---

## P8 — Conversation to State

**What:** Parse raw multi-party comms → structured project state

**Input:** `meeting_transcripts/`, `emails/`, `slack_threads/`, `status_updates.json`

**Pipeline:**
```
Raw text → LLM extraction → 3 output tables

decisions      → what was agreed, by whom, why
action_items   → who owns what, by when
blockers       → what is preventing progress
```

**Output tables:** `sci_p8_decisions` · `sci_p8_action_items` · `sci_p8_blockers`

**Key fields:** `summary, rationale, participants, status (open/closed), deadline, owner`

---

## P9 — Critical-Path Stalls

**What:** From P8's structured state, detect tasks/decisions that are stuck

**Input:** Output of P8 + dependency relationships between tasks

**Pipeline:**
```
P8 action items + decisions
        ↓
Model task dependencies (who waits on who)
        ↓
Flag stalls: unresponsive owner > threshold OR
             decision never reached downstream team
        ↓
Build nodes + edges for dependency graph
```

**Output tables:** `sci_p9_stalls` · `sci_p9_nodes` · `sci_p9_edges`

**Key fields:** `severity (high/medium/low), stall_type, affected_teams, unresponsive_since`

**Note:** nodes + edges are read directly (no MCP) since the graph is static structure

---

## P10 — Workflow Decomposition

**What:** Break each operational workflow into tasks, classify each one

**Input:** `workflow_service_escalation.json`, `workflow_qbr_preparation.json`, `activity_log.csv`, `role_definition.json`

**Pipeline:**
```
Workflow JSON + activity log
        ↓
Decompose into discrete tasks
        ↓
Classify each task:
  ASSEMBLY          → deterministic, fully automatable
  ASSEMBLY_JUDGMENT → AI can help, human reviews
  JUDGMENT          → requires empathy/negotiation, keep human
```

**Output table:** `sci_p10_tasks`

**Key fields:** `role, workflow, classification, confidence (0-1), decision_points, judgment_required`

---

## P11 — Integration Gaps & Tax

**What:** Find where data should flow between tools but doesn't, quantify the cost

**Input:** `integration_map.json`, `systems/` (Salesforce, Zendesk, DocuSign schemas), `activity_log.csv`

**Pipeline:**
```
integration_map.json → find missing data flows between systems
activity_log.csv     → measure how much time manual workarounds take
        ↓
Per gap: staff_hours_lost, error_rate, avg_delay
        ↓
Simulation: if assembly drops 65% → 15%, throughput goes from 47 → ~143 cases/mo
```

**Output table:** `sci_p11_gaps`

**Key fields:** `source_system, target_system, missing_data, staff_hours_lost_per_month, error_rate`

---

## P12 — Automation Roadmap

**What:** Combine P10 + P11 into a prioritized action plan

**Input:** Output of P10 (task classifications) + P11 (gap costs)

**Pipeline:**
```
P10 classifications + P11 gap costs
        ↓
Score each opportunity by: hours saved × confidence × feasibility
        ↓
Type each recommendation:
  integrate → fix a data flow gap
  automate  → replace an ASSEMBLY task
  preserve  → keep JUDGMENT tasks human
        ↓
Sort by priority, estimate ROI
```

**Output table:** `sci_p12_recommendations`

**Key fields:** `priority, type (automate/integrate/preserve), estimated_hours_saved_per_month, estimated_roi`

---

## What's Done vs What's Needed

| | Done | Needed Saturday |
|---|---|---|
| **Reporting dashboard** | ✅ All 5 panels built | Fill `.env` with Databricks creds |
| **MCP server** | ✅ 5 tools registered | Restart Claude Desktop |
| **Databricks connection** | ✅ Wired up, flip one env var | `DATA_SOURCE=databricks` |
| **P8 extraction** | ❌ | Teammate builds NLP pipeline |
| **P9 stall detection** | ❌ | Teammate builds from P8 output |
| **P10 classification** | ❌ | Teammate runs classifier on workflows |
| **P11 gap analysis** | ❌ | Teammate analyzes integration_map |
| **P12 roadmap** | ❌ | Teammate combines P10 + P11 |
| **Databricks tables** | ❌ | Each teammate writes their output rows |

---

## Where to Start Saturday

1. Everyone gets Databricks credentials at 10 AM
2. Each teammate creates their output table (schema in `README.md`)
3. Run their pipeline → write rows to Databricks
4. Set `DATA_SOURCE=databricks` in `server/.env`
5. Dashboard auto-reflects real data immediately
