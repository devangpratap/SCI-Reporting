/*
  chat.js — AI chat with direct database access

  Two tools:
    1. query_database — AI writes raw SQL, gets back rows. One query = full picture.
    2. propose_db_edit — queues a write for admin confirmation.

  Static reports (reports.js) are completely separate. Nothing shared.
*/

const { OpenAI } = require("openai");
const db = require("./db");
const { storePending } = require("./edits");

// ── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an operations intelligence analyst embedded in a B2B company's ops dashboard. You have direct read access to the company's live database.

Tone: match the question. Someone says hi, say hi. Someone asks something casual, keep it short. Someone asks a technical operational question, give a precise, data-backed answer with specifics — task titles, owner names, deadlines, IDs. Never narrate what you're doing. Never say "I'll query the database" or "let me check" or "I'm going to look that up". Just answer.

DATABASE SCHEMA (schema: public):

tasks          — id, org_id, parent_task_id, title, description, status (pending | in_progress | completed), deadline (timestamptz), created_at
edges          — id, org_id, source_task_id, target_task_id  [source must complete before target can start]
identities     — id, org_id, display_name, role
task_owners    — id, task_id, identity_id  [who owns which task]
communications — id, org_id, title, source_type, raw_data, origin_date  [emails/docs tasks were extracted from]
provenance     — id, org_id, type, source_comm_id, item_id  [links each task back to its source communication]
orgs           — id, name

KEY PATTERNS:
- Workflow context: JOIN provenance ON item_id = tasks.id → JOIN communications ON source_comm_id = communications.id. Tasks from the same communication belong to the same workflow.
- Task owners: JOIN task_owners ON task_id = tasks.id → JOIN identities ON identity_id = identities.id
- Blocking work: tasks with outgoing edges (source_task_id) that aren't completed are blocking downstream tasks
- Priority order: in_progress > pending overdue > pending with deadline > pending no deadline > completed

ANSWERING:
- Always query before answering anything operational. Write SQL that gets exactly what the question needs — JOINs, CTEs, aggregations, subqueries, whatever it takes.
- One well-written query beats multiple narrow ones. Join the tables you need.
- Rank and surface what matters. Don't dump everything — lead with highest urgency and impact.
- Be specific. If a task is overdue or blocking others, say so directly with the details.

WRITES:
If the user says something changed in the real world, use propose_db_edit to queue the update. State exactly what will change, ask them to confirm once. Never apply without confirmation.`;

// ── Tools ──────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    type: "function",
    function: {
      name: "query_database",
      description: "Execute a SELECT query against the operational database. Use JOINs, CTEs, aggregations — write whatever SQL fully answers the question in one shot. Returns rows as JSON.",
      parameters: {
        type: "object",
        required: ["sql"],
        properties: {
          sql: {
            type: "string",
            description: "A PostgreSQL SELECT statement against the public.* schema.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_db_edit",
      description: "Queue a database change for admin confirmation. Use when the user says something changed in the real world. The change is NOT applied until they confirm.",
      parameters: {
        type: "object",
        required: ["table", "operation", "where_id", "description"],
        properties: {
          table: {
            type: "string",
            enum: ["public.tasks"],
            description: "Only public.tasks is writable.",
          },
          operation: {
            type: "string",
            enum: ["update", "delete"],
          },
          where_id: {
            type: "string",
            description: "The id of the record to modify.",
          },
          set_fields: {
            type: "object",
            description: "For update: columns to change e.g. { \"status\": \"completed\" }.",
          },
          description: {
            type: "string",
            description: "One sentence shown to the admin describing what will change.",
          },
        },
      },
    },
  },
];

// ── Tool execution ─────────────────────────────────────────────────────────

async function runQuery(sql) {
  const clean = sql.trim().toLowerCase();
  if (!clean.startsWith("select") && !clean.startsWith("with"))
    return { error: "Only SELECT statements are permitted." };
  const blocked = ["insert ", "update ", "delete ", "drop ", "truncate ", "alter ", "create "];
  if (blocked.some(kw => clean.includes(kw)))
    return { error: "Write operations not allowed here. Use propose_db_edit." };
  try {
    const result = await db.getPool().query(sql);
    return { rows: result.rows, count: result.rowCount };
  } catch (err) {
    return { error: err.message };
  }
}

// ── History helpers ────────────────────────────────────────────────────────

function toOpenAI(uiHistory) {
  return uiHistory.map(m => ({
    role: m.sender === "user" ? "user" : "assistant",
    content: m.message,
  }));
}

function appendTurns(history, userMessage, assistantText) {
  const now = new Date().toISOString();
  return [
    ...history,
    { sender: "user",      message: userMessage,   timestamp: now },
    { sender: "assistant", message: assistantText, timestamp: now },
  ];
}

// ── Shared agentic loop ────────────────────────────────────────────────────

function makeClient() {
  if (!process.env.LLM_API_KEY) throw new Error("LLM_API_KEY not set");
  return new OpenAI({
    apiKey:  process.env.LLM_API_KEY,
    baseURL: process.env.LLM_BASE_URL,
  });
}

const MODEL = () => process.env.LLM_MODEL || "databricks-meta-llama-3-3-70b-instruct";

async function handleToolCall(toolCall, orgId, proposedChanges) {
  const input = JSON.parse(toolCall.function.arguments || "{}");
  if (toolCall.function.name === "propose_db_edit") {
    try {
      const patch = storePending({ org_id: orgId, ...input });
      proposedChanges.push(patch);
      return { status: "proposed", change_id: patch.change_id, description: patch.description, preview: patch.preview };
    } catch (err) {
      return { error: err.message };
    }
  }
  if (toolCall.function.name === "query_database") return runQuery(input.sql);
  return { error: `unknown tool: ${toolCall.function.name}` };
}

// ── Non-streaming chat ─────────────────────────────────────────────────────

async function chat(message, uiHistory = [], userToken = null) {
  const orgId    = userToken || null;
  const client   = makeClient();
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...toOpenAI(uiHistory),
    { role: "user", content: message },
  ];
  const proposedChanges = [];
  let finalText = "";
  let loopCount = 0;

  while (true) {
    loopCount++;
    console.log(`[${new Date().toISOString()}] LLM #${loopCount} — ${messages.length} msgs, org: ${orgId}`);
    const res    = await client.chat.completions.create({ model: MODEL(), tools: TOOLS, tool_choice: "auto", messages });
    const choice = res.choices[0];
    console.log(`[${new Date().toISOString()}] LLM #${loopCount} done — ${choice.finish_reason}${choice.message.tool_calls ? ` [${choice.message.tool_calls.map(t => t.function.name).join(", ")}]` : ""}`);
    messages.push(choice.message);

    if (choice.finish_reason === "stop") { finalText = choice.message.content ?? ""; break; }

    if (choice.finish_reason === "tool_calls") {
      const results = await Promise.all(
        (choice.message.tool_calls || []).map(async tc => ({
          role: "tool", tool_call_id: tc.id,
          content: JSON.stringify(await handleToolCall(tc, orgId, proposedChanges)),
        }))
      );
      messages.push(...results);
    }
  }

  return { response: finalText, history: appendTurns(uiHistory, message, finalText), proposed_changes: proposedChanges };
}

// ── Streaming chat ─────────────────────────────────────────────────────────

async function chatStream(message, uiHistory = [], userToken = null, sendEvent) {
  const orgId    = userToken || null;
  const client   = makeClient();
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...toOpenAI(uiHistory),
    { role: "user", content: message },
  ];
  const proposedChanges = [];
  let finalText = "";
  let loopCount = 0;

  while (true) {
    loopCount++;
    console.log(`[${new Date().toISOString()}] LLM #${loopCount} — ${messages.length} msgs, org: ${orgId}`);
    const peek   = await client.chat.completions.create({ model: MODEL(), tools: TOOLS, tool_choice: "auto", messages });
    const choice = peek.choices[0];
    console.log(`[${new Date().toISOString()}] LLM #${loopCount} done — ${choice.finish_reason}${choice.message.tool_calls ? ` [${choice.message.tool_calls.map(t => t.function.name).join(", ")}]` : ""}`);

    if (choice.finish_reason === "tool_calls") {
      messages.push(choice.message);
      // Silent tool execution — no tool_call events sent to UI
      const results = await Promise.all(
        (choice.message.tool_calls || []).map(async tc => ({
          role: "tool", tool_call_id: tc.id,
          content: JSON.stringify(await handleToolCall(tc, orgId, proposedChanges)),
        }))
      );
      messages.push(...results);
      continue;
    }

    // Stream final response
    const stream = await client.chat.completions.create({ model: MODEL(), messages, stream: true });
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) { sendEvent({ type: "token", content: delta }); finalText += delta; }
    }
    messages.push({ role: "assistant", content: finalText });
    break;
  }

  return { response: finalText, history: appendTurns(uiHistory, message, finalText), proposed_changes: proposedChanges };
}

module.exports = { chat, chatStream };
