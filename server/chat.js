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

const SYSTEM_PROMPT = `You are an operations intelligence assistant for a B2B organisation.
You have access to six live data tools that together cover the full operational picture:
- Conversation state: decisions that have been made, action items in flight, and active blockers
- Stalls: tasks that have stopped moving entirely, ranked by urgency and deadline risk
- Workflow map: every task classified by automation potential (ASSEMBLY / ASSEMBLY_JUDGMENT / JUDGMENT)
- Integration gaps: every place where data is failing to flow between systems and the quantified cost in hours lost, errors introduced, and delays incurred
- Automation roadmap: prioritised recommendations on what to automate, what integrations to fix, and what to preserve as human work

Always fetch live data before answering. Be specific — include IDs, owners, deadlines, team names, and severity when referencing any item. Never give vague summaries. If something is overdue or stalled, say so directly.

You also act as a database editor. When an admin describes a real-world change — a gap has been resolved, an action item is complete, a blocker has been cleared — use propose_db_edit to queue the change for admin confirmation. Never apply edits directly. Always tell the admin exactly what will change before asking them to confirm.`;

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
          enum: ["public.tasks"],
          description: "The table that contains the record to edit. All tasks (decisions, action_items, blockers, milestones) live in public.tasks.",
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
      description:
        "Returns a structured live snapshot of the organisation's current operational state — refreshed every reporting cycle. " +
        "Contains three categories: decisions (choices formally made, with participants, rationale, and status), action items (tasks assigned to owners with deadlines and blocking relationships), and blockers (issues actively preventing downstream progress). " +
        "Supports filtering by status (open, closed, active). " +
        "Use this to answer questions about what has been decided, what work is currently in flight, who owns what, what is overdue, or what is actively blocked — across any team or function within the organisation.",
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
      description:
        "Returns all tasks that have stopped moving — tasks with a blocked status — ranked by severity based on deadline proximity. " +
        "High severity means the deadline has already passed; medium means a deadline is approaching; low means no deadline is set. " +
        "Each stall includes affected teams, context, and how long the task has been unresponsive. " +
        "This is distinct from integration gaps (structural data-flow failures) and from blockers in conversation state (task-level flags) — stalls are specifically tasks that were in progress and have now seized up, creating downstream risk. " +
        "Supports filtering by severity. Use this to identify where operations have stalled and which items carry the most urgency, regardless of industry.",
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
      description:
        "Returns every task in the organisation classified by its automation potential — refreshed every reporting cycle. " +
        "Each task is labelled as ASSEMBLY (fully automatable — routine, repeatable, rule-based work a machine can handle end-to-end), ASSEMBLY_JUDGMENT (AI-assisted — structured work that benefits from automation but requires human review at key decision points), or JUDGMENT (human-essential — strategic, ambiguous, or relationship-dependent work that must not be automated). " +
        "Classifications are derived from task type and status. Results can be filtered by classification tier or by workflow group, making it possible to scope analysis to a specific process or function. " +
        "Use this to understand the composition of work across the organisation, identify where automation would have the highest impact, and surface where human expertise is genuinely irreplaceable — applicable to any industry.",
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
      description:
        "Returns a live snapshot of every integration gap — places where data should flow automatically between systems but does not, forcing humans into assembly work (copying, reconciling, re-entering data) instead of judgment work. " +
        "Each gap includes: source and target system, what data is missing, which downstream task is blocked or degraded, staff hours lost per month to manual workaround, error rate introduced by the manual step, and average delay in days. " +
        "Also returns a throughput simulation: a role handling ~50 cases/month at 65% assembly time is projected forward to 15% assembly — quantifying the capacity multiplier from fixing each integration. " +
        "This data is refreshed on every reporting cycle and reflects the current state of system connectivity costs across the organisation, regardless of industry.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_roadmap",
      description:
        "Returns a live, prioritized automation roadmap derived from task classifications and integration gap costs — refreshed every reporting cycle. " +
        "Each recommendation has a type: 'automate' (ASSEMBLY tasks a machine can fully handle), 'integrate' (P11 gaps generating the highest hidden costs in hours and error rates), or 'preserve' (JUDGMENT tasks requiring human expertise that must not be automated). " +
        "Recommendations are ordered by economic impact: blockers with the most downstream tasks affected come first, followed by high-volume pending assembly work, followed by strategic judgment-preservation decisions. " +
        "Each item includes estimated hours saved per month and an ROI signal, giving operations leaders a concrete, economically grounded view of where to invest to unlock scalable growth — applicable across any industry where throughput is constrained by manual assembly work.",
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
      const data = await db.getState(orgId);
      const s = input.filter_status;
      if (!s || s === "all") return data;
      return {
        decisions:    data.decisions.filter(d => d.status === s),
        action_items: data.action_items.filter(a => a.status === s),
        blockers:     data.blockers.filter(b => b.status === s),
      };
    }
    case "get_stalls": {
      const data = await db.getStalls(orgId);
      if (!input.severity || input.severity === "all") return data;
      return { stalls: data.stalls.filter(s => s.severity === input.severity) };
    }
    case "get_workflow_map": {
      const data = await db.getWorkflows(orgId);
      let tasks = data.tasks;
      if (input.classification && input.classification !== "all")
        tasks = tasks.filter(t => t.classification === input.classification);
      if (input.workflow)
        tasks = tasks.filter(t => t.workflow === input.workflow);
      return { tasks };
    }
    case "get_integration_gaps": return db.getGaps(orgId);
    case "get_roadmap": {
      const data = await db.getRoadmap(orgId);
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
  if (!process.env.LLM_API_KEY)
    throw new Error("LLM_API_KEY not set — add it to .env");

  const orgId = userToken || null;

  const client = new OpenAI({
    apiKey:  process.env.LLM_API_KEY,
    baseURL: process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1",
  });

  const model = process.env.LLM_MODEL || "llama-3.3-70b-versatile";

  // Build message array: system + history + new user message
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...uiToOpenAIHistory(uiHistory),
    { role: "user", content: message },
  ];

  let finalText = "";
  // Accumulates any propose_db_edit calls made during this turn
  const proposedChanges = [];

  let loopCount = 0;

  // Agentic loop — OpenAI finish_reason format
  while (true) {
    loopCount++;
    console.log(`[${new Date().toISOString()}] LLM call #${loopCount} — messages: ${messages.length}, org: ${orgId}`);
    const response = await client.chat.completions.create({
      model,
      tools: TOOLS,
      tool_choice: "auto",
      messages,
    });

    const choice = response.choices[0];
    console.log(`[${new Date().toISOString()}] LLM call #${loopCount} done — finish_reason: ${choice.finish_reason}${choice.message.tool_calls ? `, tools: ${choice.message.tool_calls.map(t => t.function.name).join(", ")}` : ""}`);
    messages.push(choice.message);

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

// ── Streaming version ──────────────────────────────────────────────────────
// Same agentic loop as chat() but streams final response tokens via SSE.
// sendEvent(obj) — called by the route handler to write each SSE frame.
// Returns { response, history, proposed_changes } for the terminal "done" event.

async function chatStream(message, uiHistory = [], userToken = null, sendEvent) {
  if (!process.env.LLM_API_KEY)
    throw new Error("LLM_API_KEY not set — add it to .env");

  const orgId = userToken || null;

  const client = new OpenAI({
    apiKey:  process.env.LLM_API_KEY,
    baseURL: process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1",
  });

  const model = process.env.LLM_MODEL || "llama-3.3-70b-versatile";

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...uiToOpenAIHistory(uiHistory),
    { role: "user", content: message },
  ];

  let finalText      = "";
  const proposedChanges = [];
  let loopCount      = 0;

  while (true) {
    loopCount++;
    const isLastRound = false; // determined by finish_reason below

    // Non-streaming call first to handle tool calls
    console.log(`[${new Date().toISOString()}] LLM stream call #${loopCount} — messages: ${messages.length}, org: ${orgId}`);

    // Peek with non-streaming to check finish_reason
    const peek = await client.chat.completions.create({
      model,
      tools: TOOLS,
      tool_choice: "auto",
      messages,
    });

    const choice = peek.choices[0];
    console.log(`[${new Date().toISOString()}] LLM stream call #${loopCount} done — finish_reason: ${choice.finish_reason}${choice.message.tool_calls ? `, tools: ${choice.message.tool_calls.map(t=>t.function.name).join(", ")}` : ""}`);

    if (choice.finish_reason === "tool_calls") {
      // Handle tool calls normally, notify UI which tools are firing
      messages.push(choice.message);
      const toolResults = [];
      for (const toolCall of (choice.message.tool_calls || [])) {
        const input = JSON.parse(toolCall.function.arguments || "{}");
        sendEvent({ type: "tool_call", name: toolCall.function.name });
        let result;
        if (toolCall.function.name === "propose_db_edit") {
          try {
            const patch = storePending({ org_id: orgId, ...input });
            proposedChanges.push(patch);
            result = { status: "proposed", change_id: patch.change_id, description: patch.description, preview: patch.preview, message: "Change queued. Admin must confirm before it is applied." };
          } catch (err) {
            result = { error: err.message };
          }
        } else {
          result = await executeTool(toolCall.function.name, orgId, input);
        }
        toolResults.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(result) });
      }
      messages.push(...toolResults);
      continue;
    }

    // finish_reason === "stop" — re-run with stream:true to get real token streaming
    const stream = await client.chat.completions.create({
      model,
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        sendEvent({ type: "token", content: delta });
        finalText += delta;
      }
    }

    // Add completed assistant message to history
    messages.push({ role: "assistant", content: finalText });
    break;
  }

  const updatedHistory = appendUiTurns(uiHistory, message, finalText);
  return { response: finalText, history: updatedHistory, proposed_changes: proposedChanges };
}

module.exports = { chat, chatStream };
