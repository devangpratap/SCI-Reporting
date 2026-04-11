/*
  ChatPanel — Bidirectional AI chat

  Floating chat button (bottom-right). Click to expand into a conversation panel.
  Sends message + full conversation history to POST /api/chat.
  Server runs an agentic loop (Claude + tool use against Databricks) and returns
  a synthesized text response + updated history.
  UI sends history back on every request to maintain conversation context.
*/

import { useState, useRef, useEffect } from "react";
import { sendMessage } from "../api";

// Very simple markdown: bold, newlines, bullet lines
function renderMarkdown(text) {
  return text
    .split("\n")
    .map((line, i) => {
      const bullets = line.match(/^[-*]\s+(.+)/);
      if (bullets) {
        return (
          <li key={i} style={{ marginLeft: 16, marginBottom: 2 }}>
            {renderInline(bullets[1])}
          </li>
        );
      }
      if (line.trim() === "") return <br key={i} />;
      return <p key={i} style={{ margin: "2px 0" }}>{renderInline(line)}</p>;
    });
}

function renderInline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part
  );
}

const SUGGESTIONS = [
  "What are the high severity stalls?",
  "What's blocking the critical path?",
  "Which tasks can be fully automated?",
  "What should we fix first?",
  "How many hours are we losing to integration gaps?",
];

export default function ChatPanel() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState([]); // { role: "user"|"assistant", text: string }
  const [history, setHistory] = useState([]);   // raw Claude message history sent with each request
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  // Scroll to bottom on new message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Focus input when panel opens
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  async function submit(text) {
    const msg = text.trim();
    if (!msg || loading) return;
    setInput("");
    setMessages(prev => [...prev, { role: "user", text: msg }]);
    setLoading(true);

    try {
      const result = await sendMessage(msg, history);
      if (result.error) throw new Error(result.error);
      setMessages(prev => [...prev, { role: "assistant", text: result.response }]);
      setHistory(result.history); // carry full history forward for next turn
    } catch (err) {
      setMessages(prev => [...prev, {
        role: "assistant",
        text: `Error: ${err.message}`,
        error: true,
      }]);
    } finally {
      setLoading(false);
    }
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(input); }
  }

  function clearChat() {
    setMessages([]);
    setHistory([]);
  }

  return (
    <>
      {/* Floating trigger button */}
      <button className="chat-fab" onClick={() => setOpen(o => !o)} title="AI Chat">
        {open ? "✕" : "✦"}
      </button>

      {/* Chat panel */}
      {open && (
        <div className="chat-panel">
          {/* Header */}
          <div className="chat-header">
            <span>Ops Intelligence Chat</span>
            <button className="chat-clear" onClick={clearChat} title="Clear conversation">
              Clear
            </button>
          </div>

          {/* Messages */}
          <div className="chat-messages">
            {messages.length === 0 && (
              <div className="chat-empty">
                <p>Ask anything about the operational data.</p>
                <div className="chat-suggestions">
                  {SUGGESTIONS.map((s, i) => (
                    <button key={i} className="chat-suggestion" onClick={() => submit(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} className={`chat-msg chat-msg-${m.role}`}>
                <div className="chat-bubble" style={m.error ? { borderColor: "rgba(239,68,68,0.3)", color: "#f87171" } : {}}>
                  {m.role === "assistant"
                    ? <>{renderMarkdown(m.text)}</>
                    : m.text
                  }
                </div>
              </div>
            ))}

            {loading && (
              <div className="chat-msg chat-msg-assistant">
                <div className="chat-bubble chat-loading">
                  <span /><span /><span />
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div className="chat-input-row">
            <textarea
              ref={inputRef}
              className="chat-input"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask about stalls, workflows, gaps…"
              rows={1}
              disabled={loading}
            />
            <button
              className="chat-send"
              onClick={() => submit(input)}
              disabled={!input.trim() || loading}
            >
              ↑
            </button>
          </div>
        </div>
      )}
    </>
  );
}
