/*
  chat.js — Agentic chat loop

  Accepts a user message + conversation history.
  Calls Claude with tool use — Claude decides which data to fetch,
  server executes the tool against db.js, loop continues until
  Claude produces a final text response.

  Tools mirror the MCP tools exactly so behaviour is consistent
  whether the query comes from Claude Desktop or the UI chat.
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
    description: "Get decisions, action items, and active blockers (P8). Use for questions about what was decided, who owns what, what is blocking progress.",
    input_schema: {
      type: "object",
      properties: {
        filter_status: {
          type: "string",
          enum: ["all", "open", "closed", "active"],
          description: "Filter items by status. Default: all",
        },
      },
      required: [],
    },
  },
  {
    name: "get_stalls",
    description: "Get current stalls — tasks that are stuck and blocking downstream teams (P9). Use for questions about what is blocked, critical path issues, unresponsive owners.",
    input_schema: {
      type: "object",
      properties: {
        severity: {
          type: "string",
          enum: ["all", "high", "medium", "low"],
          description: "Filter by severity. Default: all",
        },
      },
      required: [],
    },
  },
  {
    name: "get_workflow_map",
    description: "Get task classifications across workflows (P10). Use for questions about what can be automated, which tasks need human judgment, automation coverage.",
    input_schema: {
      type: "object",
      properties: {
        classification: {
          type: "string",
          enum: ["all", "ASSEMBLY", "ASSEMBLY_JUDGMENT", "JUDGMENT"],
        },
        workflow: {
          type: "string",
          description: "Filter by workflow name e.g. 'Invoice Reconciliation'",
        },
      },
      required: [],
    },
  },
  {
    name: "get_integration_gaps",
    description: "Get integration gaps between systems and their quantified cost in hours lost per month (P11). Use for questions about missing data flows, error rates, manual work caused by broken integrations.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_roadmap",
    description: "Get the prioritised automation roadmap (P12). Use for questions about what to fix first, ROI, what should stay human-handled.",
    input_schema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["all", "automate", "integrate", "preserve"],
        },
      },
      required: [],
    },
  },
];

async function executeTool(name, input) {
  switch (name) {
    case "get_conversation_state": return db.getP8();
    case "get_stalls":             return db.getP9();
    case "get_workflow_map":       return db.getP10();
    case "get_integration_gaps":   return db.getP11();
    case "get_roadmap":            return db.getP12();
    default: return { error: `unknown tool: ${name}` };
  }
}

async function chat(message, history = []) {
  const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Build message array from history + new user message
  const messages = [
    ...history,
    { role: "user", content: message },
  ];

  // Agentic loop — keep going until Claude stops calling tools
  while (true) {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    // Add assistant turn to history
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      const text = response.content.find(b => b.type === "text")?.text ?? "";
      // Return response + updated history (so UI can send it back next turn)
      return { response: text, history: messages };
    }

    if (response.stop_reason === "tool_use") {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const result = await executeTool(block.name, block.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      // Feed results back as a user turn
      messages.push({ role: "user", content: toolResults });
    }
  }
}

module.exports = { chat };
