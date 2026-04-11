/*
  chat.js — Agentic chat loop (Databricks Foundation Model API)

  Uses the OpenAI-compatible Databricks endpoint so no new credentials needed —
  reuses DATABRICKS_HOST and DATABRICKS_TOKEN already in .env.

  Model: set DATABRICKS_LLM_MODEL in .env (default: databricks-meta-llama-3-3-70b-instruct)

  External contract (what Uvicorn/UI sends and receives):
    Request:  { user_token, message, history: [{sender, message, timestamp}] }
    Response: { response, history: [{sender, message, timestamp}] }

  Internally uses OpenAI message format. Tool calls, tool results, and
  intermediate turns are stripped before returning — UI only sees clean turns.
*/

const { OpenAI } = require("openai");
const db = require("./db");
const { storePending } = require("./edits");

const SYSTEM_PROMPT = `You are an operations intelligence assistant for a B2B company.
You also act as a database editor — when an admin describes a real-world change
(e.g. "I spoke to the team, gap X is resolved" or "action item Y is done"), call
propose_db_edit to queue the change for confirmation. Never edit the database
directly — always use propose_db_edit so the admin can approve first.
When proposing edits, tell the admin exactly what will change and ask them to confirm.

You have access to live data across 5 operational verticals:
- P8: Conversation state — decisions made, action items, blockers
- P9: Stalls — tasks that have stopped moving and why
- P10: Workflow map — tasks classified by automation potential (ASSEMBLY / ASSEMBLY_JUDGMENT / JUDGMENT)
- P11: Integration gaps — where data isn't flowing between systems and the cost in hours
- P12: Automation roadmap — prioritised recommendations on what to fix or automate

Use the tools to fetch current data before answering. Be concise and specific.
When referencing data always include IDs, owners, severity, or team names — not vague summaries.
If something is stalled or overdue say so directly.`;

// ── propose_db_edit tool definition ───────────────────────────────────────
const PROPOSE_EDIT_TOOL = {
  type: "function",
  function: {
    name: "propose_db_edit",
    description:
      "Queue a database change for admin approval. Use when the admin describes a real-world update " +
      "(resolved gap, completed action item, closed blocker, etc.). " +
      "The change is NOT applied until the admin confirms it in the UI.",
    parameters: {
      type: "object",
      required: ["table", "operation", "where_id", "description"],
      properties: {
        table: {
          type: "string",
          enum: [
            "sci_p8_decisions",
            "sci_p8_action_items",
            "sci_p8_blockers",
            "sci_p9_stalls",
            "sci_p10_tasks",
            "sci_p11_gaps",
            "sci_p12_recommendations",
          ],
          description: "The table that contains the record to edit.",
        },
        operation: {
          type: "string",
          enum: ["update", "delete"],
          description: "'update' to modify fields; 'delete' to remove the record.",
        },
        where_id: {
          type: "string",
          description: "The ID of the record to modify (the `id` column value).",
        },
        set_fields: {
          type: "object",
          description:
            "For 'update': key-value pairs of columns to change, e.g. { \"status\": \"resolved\" }. " +
            "Omit or leave empty for 'delete'.",
        },
        description: {
          type: "string",
          description: "One-sentence human-readable summary of the change shown to the admin.",
        },
      },
    },
  },
};

// OpenAI tool format (different from Anthropic — parameters not input_schema)
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_conversation_state",
      description: "Get decisions, action items, and active blockers (P8).",
      parameters: {
        type: "object",
        properties: {
          filter_status: { type: "string", enum: ["all", "open", "closed", "active"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_stalls",
      description: "Get current stalls blocking downstream teams (P9).",
      parameters: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["all", "high", "medium", "low"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_workflow_map",
      description: "Get task classifications across workflows (P10).",
      parameters: {
        type: "object",
        properties: {
          classification: { type: "string", enum: ["all", "ASSEMBLY", "ASSEMBLY_JUDGMENT", "JUDGMENT"] },
          workflow: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_integration_gaps",
      description: "Get integration gaps and their cost in hours lost per month (P11).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_roadmap",
      description: "Get the prioritised automation roadmap (P12).",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["all", "automate", "integrate", "preserve"] },
        },
      },
    },
  },
  PROPOSE_EDIT_TOOL,
];

// ── Tool execution ─────────────────────────────────────────────────────────

async function executeTool(name, orgId, input = {}) {
  switch (name) {
    case "get_conversation_state": {
      const data = await db.getP8(orgId);
      const s = input.filter_status;
      if (!s || s === "all") return data;
      return {
        decisions:    data.decisions.filter(d => d.status === s),
        action_items: data.action_items.filter(a => a.status === s),
        blockers:     data.blockers.filter(b => b.status === s),
      };
    }
    case "get_stalls": {
      const data = await db.getP9(orgId);
      if (!input.severity || input.severity === "all") return data;
      return { stalls: data.stalls.filter(s => s.severity === input.severity) };
    }
    case "get_workflow_map": {
      const data = await db.getP10(orgId);
      let tasks = data.tasks;
      if (input.classification && input.classification !== "all")
        tasks = tasks.filter(t => t.classification === input.classification);
      if (input.workflow)
        tasks = tasks.filter(t => t.workflow === input.workflow);
      return { tasks };
    }
    case "get_integration_gaps": return db.getP11(orgId);
    case "get_roadmap": {
      const data = await db.getP12(orgId);
      if (!input.type || input.type === "all") return data;
      return { recommendations: data.recommendations.filter(r => r.type === input.type) };
    }
    default: return { error: `unknown tool: ${name}` };
  }
}

// ── History converters ─────────────────────────────────────────────────────

// UI {sender, message, timestamp} → OpenAI {role, content}
function uiToOpenAIHistory(uiHistory) {
  return uiHistory.map(m => ({
    role: m.sender === "user" ? "user" : "assistant",
    content: m.message,
  }));
}

function appendUiTurns(existingUiHistory, userMessage, assistantText) {
  const now = new Date().toISOString();
  return [
    ...existingUiHistory,
    { sender: "user",      message: userMessage,   timestamp: now },
    { sender: "assistant", message: assistantText, timestamp: now },
  ];
}

// ── Main export ────────────────────────────────────────────────────────────

async function chat(message, uiHistory = [], userToken = null) {
  if (!process.env.DATABRICKS_HOST || !process.env.DATABRICKS_TOKEN)
    throw new Error("DATABRICKS_HOST and DATABRICKS_TOKEN required for chat");

  const orgId = userToken || null;

  const client = new OpenAI({
    apiKey:  process.env.DATABRICKS_TOKEN,
    baseURL: `https://${process.env.DATABRICKS_HOST}/serving-endpoints`,
  });

  const model = process.env.DATABRICKS_LLM_MODEL || "databricks-meta-llama-3-3-70b-instruct";

  // Build message array: system + history + new user message
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...uiToOpenAIHistory(uiHistory),
    { role: "user", content: message },
  ];

  let finalText = "";
  // Accumulates any propose_db_edit calls made during this turn
  const proposedChanges = [];

  // Agentic loop — OpenAI finish_reason format
  while (true) {
    const response = await client.chat.completions.create({
      model,
      tools: TOOLS,
      tool_choice: "auto",
      messages,
    });

    const choice = response.choices[0];
    messages.push(choice.message); // add assistant turn to history

    if (choice.finish_reason === "stop") {
      finalText = choice.message.content ?? "";
      break;
    }

    if (choice.finish_reason === "tool_calls") {
      const toolResults = [];
      for (const toolCall of (choice.message.tool_calls || [])) {
        const input = JSON.parse(toolCall.function.arguments || "{}");
        let result;

        if (toolCall.function.name === "propose_db_edit") {
          // Store pending change and return a descriptor to the model
          try {
            const patch = storePending({ org_id: orgId, ...input });
            proposedChanges.push(patch);
            result = {
              status:      "proposed",
              change_id:   patch.change_id,
              description: patch.description,
              preview:     patch.preview,
              message:     "Change queued. Admin must confirm before it is applied.",
            };
          } catch (err) {
            result = { error: err.message };
          }
        } else {
          result = await executeTool(toolCall.function.name, orgId, input);
        }

        toolResults.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          content:      JSON.stringify(result),
        });
      }
      messages.push(...toolResults);
    }
  }

  const updatedHistory = appendUiTurns(uiHistory, message, finalText);
  return {
    response:         finalText,
    history:          updatedHistory,
    // Empty array when no edits proposed — additive, never breaks existing callers
    proposed_changes: proposedChanges,
  };
}

module.exports = { chat };
