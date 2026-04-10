/*
  SCI Reporting — MCP Server

  Exposes all 5 reporting verticals as MCP tools so Claude (or any MCP client)
  can query the B2B Operations Intelligence data in natural language.

  Tools:
    get_conversation_state  — P8: decisions, action items, blockers
    get_stalls              — P9: critical-path stall alerts
    get_workflow_map        — P10: task classifications (ASSEMBLY/JUDGMENT)
    get_integration_gaps    — P11: integration gaps + cost simulation
    get_roadmap             — P12: prioritized automation roadmap

  Data source RIGHT NOW: Express API at localhost:3001 (which reads mock JSON)
  Data source SATURDAY:  Replace BASE_URL with Databricks SQL warehouse endpoint
                         OR replace fetch() calls with databricks-sql-connector queries

  To swap to Databricks on Saturday:
    1. npm install @databricks/sql
    2. Replace fetchFromAPI() with a queryDatabricks() function
    3. Update each tool handler to run the appropriate SQL query
    4. Keep tool names + return shapes identical — MCP clients need no changes
*/

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

// --- Data source ---
// RIGHT NOW: Express API (which reads mock JSON)
// SATURDAY: swap this for Databricks SQL connector
const BASE_URL = "http://localhost:3001/api";

async function fetchFromAPI(path) {
  const { default: fetch } = await import("node-fetch");
  const res = await fetch(`${BASE_URL}${path}`);
  return res.json();
}

// --- MCP Server setup ---
const server = new McpServer({
  name: "sci-reporting",
  version: "1.0.0",
});

// P8 — Conversation to State
server.tool(
  "get_conversation_state",
  "Get the current project state extracted from communications: decisions made, open action items, and active blockers.",
  {
    filter_status: z.enum(["all", "open", "closed", "active"]).optional()
      .describe("Filter items by status. Defaults to 'all'."),
  },
  async ({ filter_status = "all" }) => {
    const data = await fetchFromAPI("/p8");

    let { decisions, action_items, blockers } = data;

    if (filter_status !== "all") {
      decisions    = decisions.filter(d => d.status === filter_status);
      action_items = action_items.filter(a => a.status === filter_status);
      blockers     = blockers.filter(b => b.status === filter_status);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ decisions, action_items, blockers }, null, 2),
      }],
    };
  }
);

// P9 — Critical-Path Stalls
server.tool(
  "get_stalls",
  "Get current critical-path stalls — tasks or decisions that are stuck and blocking downstream teams.",
  {
    severity: z.enum(["all", "high", "medium", "low"]).optional()
      .describe("Filter stalls by severity. Defaults to 'all'."),
  },
  async ({ severity = "all" }) => {
    const data = await fetchFromAPI("/p9");
    let { stalls } = data;

    if (severity !== "all") {
      stalls = stalls.filter(s => s.severity === severity);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ stalls, count: stalls.length }, null, 2),
      }],
    };
  }
);

// P10 — Workflow Decomposition
server.tool(
  "get_workflow_map",
  "Get the workflow task map showing which tasks are ASSEMBLY (automatable), ASSEMBLY_JUDGMENT (AI-assisted), or JUDGMENT (human-essential).",
  {
    classification: z.enum(["all", "ASSEMBLY", "ASSEMBLY_JUDGMENT", "JUDGMENT"]).optional()
      .describe("Filter tasks by classification type."),
    workflow: z.string().optional()
      .describe("Filter by workflow name (e.g. 'Invoice Reconciliation')."),
  },
  async ({ classification = "all", workflow }) => {
    const data = await fetchFromAPI("/p10");
    let { tasks } = data;

    if (classification !== "all") tasks = tasks.filter(t => t.classification === classification);
    if (workflow) tasks = tasks.filter(t => t.workflow.toLowerCase().includes(workflow.toLowerCase()));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ tasks, count: tasks.length }, null, 2),
      }],
    };
  }
);

// P11 — Integration Gaps & Tax
server.tool(
  "get_integration_gaps",
  "Get integration gaps between systems and their quantified cost: hours lost per month, error rates, delays, and throughput simulation.",
  {},
  async () => {
    const data = await fetchFromAPI("/p11");
    const total_hours = data.gaps.reduce((s, g) => s + g.staff_hours_lost_per_month, 0);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ ...data, total_hours_lost_per_month: total_hours }, null, 2),
      }],
    };
  }
);

// P12 — Automation Roadmap
server.tool(
  "get_roadmap",
  "Get the prioritized automation roadmap: what to automate, what integrations to fix, and what to preserve as human work.",
  {
    type: z.enum(["all", "automate", "integrate", "preserve"]).optional()
      .describe("Filter recommendations by type."),
  },
  async ({ type = "all" }) => {
    const data = await fetchFromAPI("/p12");
    let { recommendations } = data;

    if (type !== "all") recommendations = recommendations.filter(r => r.type === type);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ recommendations }, null, 2),
      }],
    };
  }
);

// --- Start ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("SCI Reporting MCP server running");
}

main().catch(console.error);
