import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import {
  signRequest,
  getCredentials,
  setCredentials,
  clearCredentials,
  areCredentialsExpired,
  isAuthError,
} from "../lib/sigv4";
import {
  ChatResponse,
  ChatResponseType,
  FollowupQuestion,
  ProductCard,
  parseEnvelope,
} from "../types/response-envelope";
import { CustomerSelector, Customer } from "./CustomerSelector";
import { SessionHistory, SessionMessage } from "./SessionHistory";

const SELECTED_CUSTOMER_KEY = "chat_selected_customer";

function loadSelectedCustomer(): Customer | null {
  try {
    const raw = sessionStorage.getItem(SELECTED_CUSTOMER_KEY);
    return raw ? (JSON.parse(raw) as Customer) : null;
  } catch {
    return null;
  }
}

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  /** Plain text / markdown shown in the bubble. */
  content: string;
  /** Discriminator for assistant messages. */
  responseType?: ChatResponseType;
  /** Product cards (only for type="answer" with tool results). */
  recommendations?: ProductCard[];
  /** Chip questions (only for type="followup"). */
  followups?: FollowupQuestion[];
  timestamp: Date;
  metadata?: {
    toolsCalled?: string[];
    memoryStored?: boolean;
    memoryRecalled?: string[];
    responseTimeMs?: number;
  };
}

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL || "";

// Generate a unique session ID for this chat session (persists across page reloads)
function getOrCreateSessionId(): string {
  const storageKey = "chat_session_id";
  let sessionId = sessionStorage.getItem(storageKey);
  if (!sessionId) {
    sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    sessionStorage.setItem(storageKey, sessionId);
  }
  return sessionId;
}

export function ChatWindow() {
  // sessionId is stateful (not just `useState(() => ...)` without a setter)
  // because the "Resume past conversation" sidebar swaps it when the user
  // clicks a previous session. Keeping it in sessionStorage means a page
  // reload still lands you in the same active thread.
  const [sessionId, setSessionId] = useState(() => getOrCreateSessionId());
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Hi there! 🎉 I'm your Party Supply Assistant. I can help you find products for any celebration, check order status, or suggest party themes. What can I help you with today?",
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [activity, setActivity] = useState<string[]>([]);
  const [showCredentials, setShowCredentials] = useState(
    !getCredentials() || areCredentialsExpired()
  );
  const [credForm, setCredForm] = useState({
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    expiresAt: "",
  });
  // Per-message chip selections: { messageId -> { questionId -> Set<value> } }
  const [chipSelections, setChipSelections] = useState<
    Record<string, Record<string, Set<string>>>
  >({});
  // Track which messages have had their followup chips submitted (hide after submit)
  const [submittedFollowups, setSubmittedFollowups] = useState<Set<string>>(new Set());
  // Bumped to trigger a one-shot SessionHistory reload (e.g. after the
  // user clicks "New chat" or sends a message). The sidebar listens on
  // this value via its `refreshKey` prop.
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  // Selected customer for personalization. The agent loads this user's
  // profile and last 10 interactions into the system prompt for every
  // chat call when set. Persisted in sessionStorage so the choice
  // survives page reloads within the tab.
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(loadSelectedCustomer);

  function handleCustomerChange(c: Customer | null) {
    setSelectedCustomer(c);
    if (c) {
      sessionStorage.setItem(SELECTED_CUSTOMER_KEY, JSON.stringify(c));
    } else {
      sessionStorage.removeItem(SELECTED_CUSTOMER_KEY);
    }
    // Switching customers starts a fresh thread end-to-end: new sessionId,
    // cleared messages, cleared chip/followup state. Otherwise the previous
    // customer's turns linger on screen and chat-history submitted with the
    // next send still carries the prior actor's conversation.
    const freshSessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    setSessionId(freshSessionId);
    sessionStorage.setItem("chat_session_id", freshSessionId);

    const welcome: Message = {
      id: "welcome",
      role: "assistant",
      content:
        "Hi there! 🎉 I'm your Party Supply Assistant. I can help you find products for any celebration, check order status, or suggest party themes. What can I help you with today?",
      timestamp: new Date(),
    };
    setMessages([welcome]);
    setChipSelections({});
    setSubmittedFollowups(new Set());
    setActivity([]);
    setInput("");
  }
  const [copied, setCopied] = useState(false);

  const handleCopyCommand = async () => {
    await navigator.clipboard.writeText("aws configure export-credentials");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activity]);

  // Poll every 60s for credential expiry. Temporary STS creds typically
  // last 1 hour, so a minute of granularity is plenty and avoids waiting
  // until the next chat send to surface the expiry.
  useEffect(() => {
    if (showCredentials) return;
    const id = setInterval(() => {
      if (areCredentialsExpired()) {
        clearCredentials();
        setShowCredentials(true);
      }
    }, 60_000);
    return () => clearInterval(id);
  }, [showCredentials]);

  function startNewChat() {
    const freshSessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    setSessionId(freshSessionId);
    sessionStorage.setItem("chat_session_id", freshSessionId);
    setMessages([
      {
        id: "welcome",
        role: "assistant",
        content:
          "Hi there! 🎉 I'm your Party Supply Assistant. I can help you find products for any celebration, check order status, or suggest party themes. What can I help you with today?",
        timestamp: new Date(),
      },
    ]);
    setChipSelections({});
    setSubmittedFollowups(new Set());
    setActivity([]);
    setInput("");
    // Bump the sidebar so it picks up any session that just got created
    // by the previous turn (and to make the previous "current" highlight
    // drop off now that we've switched threads).
    setHistoryRefreshKey((k) => k + 1);
  }

  const handleCredentialSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCredentials(
      credForm.accessKeyId,
      credForm.secretAccessKey,
      credForm.sessionToken || undefined,
      credForm.expiresAt || undefined
    );
    setShowCredentials(false);
  };

  /**
   * Re-hydrate the chat from a past session.
   *
   * Called when the user clicks an entry in the SessionHistory sidebar.
   * Replaces the current messages with the past timeline (rendered as
   * plain user/assistant bubbles - no product cards or chips because
   * those are envelope-specific and were thrown away by AgentCore Memory),
   * and switches the active sessionId so new turns continue that thread.
   */
  function handleResumeSession(newSessionId: string, history: SessionMessage[]) {
    setSessionId(newSessionId);
    sessionStorage.setItem("chat_session_id", newSessionId);

    // Convert AgentCore Memory events into Message objects. Cards and
    // chip state aren't recoverable - past sessions show prose only.
    const restored: Message[] = history.map((h, idx) => ({
      id: `restored-${newSessionId}-${idx}`,
      role: h.role,
      content: h.content,
      responseType: h.role === "assistant" ? "answer" : undefined,
      timestamp: new Date(h.timestamp || Date.now()),
    }));

    // Banner so the user can see they're back in a past thread.
    const banner: Message = {
      id: `resume-banner-${Date.now()}`,
      role: "system",
      content: `Resumed past conversation (${history.length} messages). New messages will continue this thread.`,
      timestamp: new Date(),
    };
    setMessages([banner, ...restored]);
    setChipSelections({});
    setSubmittedFollowups(new Set());
  }

  const handleSend = async (overrideMessage?: string) => {
    // overrideMessage is supplied when the user clicks Submit on a followup
    // chip group. Otherwise we use whatever's in the input box.
    const messageText = overrideMessage ?? input.trim();
    if (!messageText || isLoading) return;

    const credentials = getCredentials();
    if (!credentials || areCredentialsExpired()) {
      clearCredentials();
      setShowCredentials(true);
      return;
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: messageText,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    if (!overrideMessage) setInput("");
    setIsLoading(true);
    setActivity(["🔐 Signing request with SigV4..."]);

    const startTime = Date.now();

    try {
      // Build conversation history from previous messages (exclude welcome message and current)
      const conversationHistory = messages
        .filter((m) => m.id !== "welcome" && (m.role === "user" || m.role === "assistant"))
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      const mcpUrl = `${GATEWAY_URL}/mcp`;
      const chatArgs: Record<string, unknown> = {
        prompt: userMessage.content,
        sessionId: sessionId,
        conversationHistory: conversationHistory,
      };
      // When a customer is selected in the UI, pass their userId so the
      // agent loads their profile + last 10 interactions into the prompt.
      if (selectedCustomer?.userId) {
        chatArgs.userId = selectedCustomer.userId;
      }
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now().toString(),
        method: "tools/call",
        params: {
          name: "PartySupplyTarget___chat",
          arguments: chatArgs,
        },
      });

      setActivity((prev) => [...prev, "📡 Calling AgentCore Gateway..."]);

      const signedHeaders = await signRequest(mcpUrl, "POST", body, credentials);

      const response = await fetch(mcpUrl, {
        method: "POST",
        headers: {
          ...signedHeaders,
          "content-type": "application/json",
        },
        body,
      });

      setActivity((prev) => [...prev, "🤖 Agent processing (Claude Sonnet 4.5)..."]);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gateway error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      const responseTimeMs = Date.now() - startTime;

      // The Lambda forwards the agent's ChatResponse envelope. We expect
      // the JSON-RPC response.text to be a Lambda return like:
      //   { "envelope": { type, message, recommendations?, followups? }, response: "..." }
      // Older deployments may instead return { "response": "raw string" }.
      let envelope: ChatResponse | null = null;
      let rawText = "";

      if (data.result?.content) {
        const textContent = data.result.content
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join("\n");

        try {
          const parsed = JSON.parse(textContent);
          // Preferred path: Lambda gave us an envelope key
          if (parsed.envelope && typeof parsed.envelope === "object") {
            envelope = parsed.envelope as ChatResponse;
            rawText = parsed.response || envelope.message;
          } else {
            // Legacy path: Lambda returned plain text in `response`. The
            // agent might still have emitted JSON envelope inside that
            // string, so try parseEnvelope on it.
            rawText = parsed.response || parsed.output || textContent;
            envelope = parseEnvelope(rawText);
          }
        } catch {
          rawText = textContent;
          envelope = parseEnvelope(textContent);
        }
      } else if (data.error) {
        throw new Error(data.error.message || JSON.stringify(data.error));
      } else {
        rawText = JSON.stringify(data);
      }

      // If we couldn't parse an envelope at all, fall back to a plain answer.
      if (!envelope) {
        envelope = { type: "answer", message: rawText };
      }

      setActivity((prev) => [
        ...prev,
        "💾 Storing conversation in memory...",
        `✅ Response received (${(responseTimeMs / 1000).toFixed(1)}s)`,
      ]);

      // Card-inheritance fallback: when the model returns type=answer
      // without calling a recommendation tool (common on refinement /
      // chip-answer turns with Nova - it narrates products in prose
      // from conversation context instead of re-querying), we inherit
      // the most recent assistant message's cards so the UI still has
      // something clickable. Only fires when the current turn has zero
      // cards AND the model didn't call any tool - a real "no results"
      // reply from a tool that returned an empty list won't be masked.
      let inheritedRecommendations: ProductCard[] | undefined;
      const modelReturnedNoCards =
        !envelope.recommendations || envelope.recommendations.length === 0;
      const modelCalledNoTools =
        !envelope.meta?.toolsCalled || envelope.meta.toolsCalled.length === 0;
      if (envelope.type === "answer" && modelReturnedNoCards && modelCalledNoTools) {
        const lastAssistantWithCards = [...messages]
          .reverse()
          .find(
            (m) =>
              m.role === "assistant" &&
              m.recommendations &&
              m.recommendations.length > 0
          );
        if (lastAssistantWithCards?.recommendations?.length) {
          inheritedRecommendations = lastAssistantWithCards.recommendations;
          console.log(
            `[cards] Inheriting ${inheritedRecommendations.length} cards from previous turn (model didn't call any tool this turn).`
          );
        }
      }

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: envelope.message,
        responseType: envelope.type,
        recommendations: envelope.recommendations || inheritedRecommendations,
        followups: envelope.followups,
        timestamp: new Date(),
        metadata: {
          toolsCalled: envelope.meta?.toolsCalled,
          memoryStored: true,
          responseTimeMs,
        },
      };

      // Brief delay to show activity before clearing
      await new Promise((r) => setTimeout(r, 800));
      setMessages((prev) => [...prev, assistantMessage]);
      // First turn on a fresh sessionId just created an AgentCore Memory
      // session - nudge the sidebar so it appears without waiting for
      // the 30s background poll.
      setHistoryRefreshKey((k) => k + 1);
    } catch (error) {
      // SigV4 / STS auth failures route the user back to the credentials
      // screen rather than surfacing as a wall of "Gateway error (403)" -
      // most of the time the cause is just an expired session token.
      if (isAuthError(error)) {
        clearCredentials();
        setShowCredentials(true);
        return;
      }
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "system",
        content: `${error instanceof Error ? error.message : "Failed to send message"}`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
      setActivity([]);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Toggle a chip's selected state (multi-select within a question group)
  const toggleChip = (messageId: string, questionId: string, value: string) => {
    setChipSelections((prev) => {
      const forMessage = { ...(prev[messageId] || {}) };
      const forQuestion = new Set(forMessage[questionId] || []);
      if (forQuestion.has(value)) {
        forQuestion.delete(value);
      } else {
        forQuestion.add(value);
      }
      forMessage[questionId] = forQuestion;
      return { ...prev, [messageId]: forMessage };
    });
  };

  // Submit selected chips: build a natural-language message and call handleSend
  const submitFollowups = (message: Message) => {
    if (!message.followups || message.followups.length === 0) return;
    const sel = chipSelections[message.id] || {};

    // Compose a sentence from the selections, e.g.:
    //   "What's the occasion? birthday party. What's your budget? mid-range."
    const parts: string[] = [];
    for (const q of message.followups) {
      const values = Array.from(sel[q.id] || []);
      if (values.length > 0) {
        parts.push(`${q.label} ${values.join(", ")}`);
      }
    }
    if (parts.length === 0) return; // nothing selected, no-op

    const composed = parts.join(". ");
    setSubmittedFollowups((prev) => new Set(prev).add(message.id));
    handleSend(composed);
  };

  const isAnyChipSelected = (messageId: string): boolean => {
    const sel = chipSelections[messageId] || {};
    return Object.values(sel).some((set) => set.size > 0);
  };

  if (showCredentials) {
    return (
      <div className="credentials-form">
        <h2>🔐 AWS Credentials</h2>
        <p>
          Enter your AWS credentials to authenticate with the AgentCore Gateway
          (IAM SigV4). Get them by running:
        </p>
        <div className="cred-hint-container">
          <code className="cred-hint">aws configure export-credentials</code>
          <button
            type="button"
            className="copy-btn"
            onClick={handleCopyCommand}
            title="Copy to clipboard"
          >
            {copied ? "✓" : "📋"}
          </button>
        </div>
        <form onSubmit={handleCredentialSubmit}>
          <label>
            Access Key ID
            <input
              type="text"
              value={credForm.accessKeyId}
              onChange={(e) =>
                setCredForm({ ...credForm, accessKeyId: e.target.value })
              }
              placeholder="ASIA..."
              required
            />
          </label>
          <label>
            Secret Access Key
            <input
              type="password"
              value={credForm.secretAccessKey}
              onChange={(e) =>
                setCredForm({ ...credForm, secretAccessKey: e.target.value })
              }
              placeholder="Your secret key"
              required
            />
          </label>
          <label>
            Session Token
            <input
              type="password"
              value={credForm.sessionToken}
              onChange={(e) =>
                setCredForm({ ...credForm, sessionToken: e.target.value })
              }
              placeholder="Required for temporary credentials"
            />
          </label>
          <label>
            Expires At (optional)
            <input
              type="text"
              value={credForm.expiresAt}
              onChange={(e) =>
                setCredForm({ ...credForm, expiresAt: e.target.value })
              }
              placeholder="e.g. 2026-06-25T03:30:00Z"
            />
          </label>
          <button type="submit">Connect</button>
        </form>
      </div>
    );
  }

  return (
    <div className="chat-shell">
      <SessionHistory
        actorId={selectedCustomer?.userId || null}
        currentSessionId={sessionId}
        onResume={handleResumeSession}
        refreshKey={historyRefreshKey}
      />
      <div className="chat-window">
      <div className="chat-toolbar">
        {selectedCustomer && (
          <div className="chat-toolbar-context">
            Chatting as <strong>{selectedCustomer.userId}</strong>
            {selectedCustomer.customerSegment ? ` · ${selectedCustomer.customerSegment}` : ""}
            {selectedCustomer.region ? ` · ${selectedCustomer.region}` : ""}
          </div>
        )}
        <div className="chat-toolbar-spacer" />
        <CustomerSelector selected={selectedCustomer} onChange={handleCustomerChange} />
        <button
          type="button"
          className="new-chat-button"
          onClick={startNewChat}
          title="Start a new conversation"
          aria-label="Start a new conversation"
        >
          <span className="new-chat-icon">+</span>
          New chat
        </button>
      </div>
      <div className="messages">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`message message-${msg.role}${
              msg.responseType === "blocked" ? " message-blocked" : ""
            }`}
          >
            <div className="message-avatar">
              {msg.role === "user"
                ? "👤"
                : msg.role === "assistant"
                ? msg.responseType === "blocked"
                  ? "🚫"
                  : "🎉"
                : "⚠️"}
            </div>
            <div className="message-content">
              <div className="message-text">
                {msg.role === "assistant" ? (
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                ) : (
                  msg.content
                )}
              </div>
              {/* Product cards (only on type="answer" with tool results) */}
              {msg.recommendations && msg.recommendations.length > 0 && (
                <div className="product-cards">
                  {msg.recommendations.map((p) => (
                    <a
                      key={p.id}
                      href={p.link || "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="product-card"
                      onClick={(e) => {
                        if (!p.link) e.preventDefault();
                      }}
                    >
                      {p.image && (
                        <img
                          src={p.image}
                          alt={p.title}
                          className="product-card-image"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = "none";
                          }}
                        />
                      )}
                      <div className="product-card-body">
                        <div className="product-card-title">{p.title}</div>
                        <div className="product-card-meta">
                          {p.price && <span className="product-card-price">${p.price}</span>}
                          {p.theme && <span className="product-card-theme">{p.theme}</span>}
                          {p.category && (
                            <span className="product-card-category">{p.category}</span>
                          )}
                        </div>
                        {p.description && (
                          <div className="product-card-desc">{p.description}</div>
                        )}
                      </div>
                    </a>
                  ))}
                </div>
              )}
              {/* Followup chip groups - hidden after submit. When products are
                  also showing, this is optional refinement; otherwise it's the
                  primary action (bootstrap a search). */}
              {msg.followups && msg.followups.length > 0 && !submittedFollowups.has(msg.id) && (
                <div className="followups">
                  {msg.recommendations && msg.recommendations.length > 0 && (
                    <div className="followup-refine-hint">
                      Want to narrow it down?
                    </div>
                  )}
                  {msg.followups.map((q) => {
                    const selected = chipSelections[msg.id]?.[q.id] || new Set<string>();
                    return (
                      <div key={q.id} className="followup-group">
                        <div className="followup-label">{q.label}</div>
                        <div className="followup-chips">
                          {q.options.map((opt) => {
                            const isSelected = selected.has(opt.value);
                            return (
                              <button
                                key={opt.value}
                                type="button"
                                className={`chip ${isSelected ? "chip-selected" : ""}`}
                                onClick={() => toggleChip(msg.id, q.id, opt.value)}
                                disabled={isLoading}
                              >
                                {opt.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className="followup-submit"
                    onClick={() => submitFollowups(msg)}
                    disabled={!isAnyChipSelected(msg.id) || isLoading}
                  >
                    Submit selections
                  </button>
                </div>
              )}
              {msg.metadata && (
                <div className="message-meta">
                  {msg.metadata.toolsCalled && (
                    <span className="meta-badge meta-tool">
                      🔧 {msg.metadata.toolsCalled.join(", ")}
                    </span>
                  )}
                  {msg.metadata.memoryStored && (
                    <span className="meta-badge meta-memory">
                      💾 Stored in memory
                    </span>
                  )}
                  {msg.metadata.responseTimeMs && (
                    <span className="meta-badge meta-time">
                      ⏱ {(msg.metadata.responseTimeMs / 1000).toFixed(1)}s
                    </span>
                  )}
                </div>
              )}
              <div className="message-time">
                {msg.timestamp.toLocaleTimeString()}
              </div>
            </div>
          </div>
        ))}

        {/* Activity indicator */}
        {isLoading && activity.length > 0 && (
          <div className="message message-activity">
            <div className="message-avatar">⚡</div>
            <div className="message-content">
              <div className="activity-log">
                {activity.map((line, i) => (
                  <div key={i} className="activity-line">
                    {line}
                  </div>
                ))}
                <div className="activity-line activity-current">
                  <span className="dot-pulse"></span>
                </div>
              </div>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="input-area">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about party supplies, orders, or event planning..."
          rows={1}
          disabled={isLoading}
        />
        <button
          onClick={() => handleSend()}
          disabled={isLoading || !input.trim()}
          className="send-button"
          aria-label="Send message"
        >
          ➤
        </button>
      </div>

      <div className="chat-footer">
        <span className="footer-info">
          Powered by Bedrock AgentCore • Claude Sonnet 4.5 • S3 Vectors RAG
        </span>
        <button
          className="logout-button"
          onClick={() => {
            clearCredentials();
            setShowCredentials(true);
          }}
        >
          🔓 Change Credentials
        </button>
      </div>
      </div>{/* /chat-window */}
    </div>
  );
}
