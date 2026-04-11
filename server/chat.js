/*
  chat.js — Agentic chat loop

  External contract (what Uvicorn/UI sends and receives):
    Request:  { user_token, message, history: [{sender, message, timestamp}] }
    Response: { response, history: [{sender, message, timestamp}] }

  Internally converts to/from Claude's {role, content} format.
  Tool calls, tool results, and intermediate turns are stripped before
  returning — UI only ever sees clean human-readable turns.
*/

const Anthropic = require("@anthropic-ai/sdk");
const db = require("./db");

const SYSTEM_PROMPT = `You are an operations intelligence assistant for a B2B company.
You have access to live data across 5 operational verticals:
- P8: Conversation state — decisions made, action items, blockers
- P9: Stalls — tasks that have stopped moving and why
- P10: Workflow map — tasks classified by automation potential (ASSEMBLY / ASSEMBLY_JUDGMENT / JUDGMENT)
- P11: Integration gaps — where data isn't flowing between systems and the cost in hours
- P12: Automation roadmap — prioritised recommendations on what to fix or automate

Use the tools to fetch current data before answering. Be concise and specific.
When referencing data always include IDs, owners, severity, or team names — not vague summaries.
If something is stalled or overdue say so directly.`;

const TOOLS = [
  {
    name: "get_conversation_state",
    description: "Get decisions, action items, and active blockers (P8).",
    input_schema: {
      type: "object",
      properties: {
        filter_status: { type: "string", enum: ["all", "open", "closed", "active"] },
      },
      required: [],
    },
  },
  {
    name: "get_stalls",
    description: "Get current stalls blocking downstream teams (P9).",
    input_schema: {
      type: "object",
      properties: {
        severity: { type: "string", enum: ["all", "high", "medium", "low"] },
      },
      required: [],
    },
  },
  {
    name: "get_workflow_map",
    description: "Get task classifications across workflows (P10).",
    input_schema: {
      type: "object",
      properties: {
        classification: { type: "string", enum: ["all", "ASSEMBLY", "ASSEMBLY_JUDGMENT", "JUDGMENT"] },
        workflow: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "get_integration_gaps",
    description: "Get integration gaps and their cost in hours lost per month (P11).",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_roadmap",
    description: "Get the prioritised automation roadmap (P12).",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["all", "automate", "integrate", "preserve"] },
      },
      required: [],
    },
  },
];

// orgId scopes every tool call to that org's rows only
async function executeTool(name, orgId) {
  switch (name) {
    case "get_conversation_state": return db.getP8(orgId);
    case "get_stalls":             return db.getP9(orgId);
    case "get_workflow_map":       return db.getP10(orgId);
    case "get_integration_gaps":   return db.getP11(orgId);
    case "get_roadmap":            return db.getP12(orgId);
    default: return { error: `unknown tool: ${name}` };
  }
}

// ── History converters ─────────────────────────────────────────────────────

// UI {sender, message, timestamp} → Claude {role, content}
// Strip any tool turns that may have leaked in — Claude history is internal only
function uiToClaudeHistory(uiHistory) {
  return uiHistory.map(m => ({
    role: m.sender === "user" ? "user" : "assistant",
    content: m.message,
  }));
}

// Append the new user + assistant turn to the UI history and return
function appendUiTurns(existingUiHistory, userMessage, assistantText) {
  const now = new Date().toISOString();
  return [
    ...existingUiHistory,
    { sender: "user",      message: userMessage,    timestamp: now },
    { sender: "assistant", message: assistantText,  timestamp: now },
  ];
}

// ── Main export ────────────────────────────────────────────────────────────

// user_token carries org_id — all tool calls are scoped to that org's data only
// Resolution: for now user_token IS the org_id directly.
// When auth is added Saturday, swap this for a token→org_id lookup.
async function chat(message, uiHistory = [], userToken = null) {
  const orgId = userToken || null; // userToken = org_id until auth layer is added
  const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Convert UI history to Claude format, append new user message
  const messages = [
    ...uiToClaudeHistory(uiHistory),
    { role: "user", content: message },
  ];

  let finalText = "";

  // Agentic loop — keep going until Claude stops calling tools
  while (true) {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      finalText = response.content.find(b => b.type === "text")?.text ?? "";
      break;
    }

    if (response.stop_reason === "tool_use") {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const result = await executeTool(block.name, orgId);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }
  }

  // Return clean UI-format history — no tool internals exposed
  const updatedHistory = appendUiTurns(uiHistory, message, finalText);
  return { response: finalText, history: updatedHistory };
}

module.exports = { chat };
