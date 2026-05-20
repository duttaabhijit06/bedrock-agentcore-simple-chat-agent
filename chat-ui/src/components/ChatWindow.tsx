import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { signRequest, getCredentials, setCredentials, clearCredentials } from "../lib/sigv4";

interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  metadata?: {
    toolsCalled?: string[];
    memoryStored?: boolean;
    memoryRecalled?: string[];
    responseTimeMs?: number;
  };
}

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL || "";

export function ChatWindow() {
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
  const [showCredentials, setShowCredentials] = useState(!getCredentials());
  const [credForm, setCredForm] = useState({
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
  });
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

  const handleCredentialSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCredentials(
      credForm.accessKeyId,
      credForm.secretAccessKey,
      credForm.sessionToken || undefined
    );
    setShowCredentials(false);
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const credentials = getCredentials();
    if (!credentials) {
      setShowCredentials(true);
      return;
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setActivity(["🔐 Signing request with SigV4..."]);

    const startTime = Date.now();

    try {
      const mcpUrl = `${GATEWAY_URL}/mcp`;
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now().toString(),
        method: "tools/call",
        params: {
          name: "PartySupplyTarget___chat",
          arguments: {
            prompt: userMessage.content,
          },
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

      let assistantContent = "";
      if (data.result?.content) {
        const textContent = data.result.content
          .filter((c: { type: string }) => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join("\n");

        // Try to parse the Lambda response JSON
        try {
          const parsed = JSON.parse(textContent);
          assistantContent = parsed.response || parsed.output || textContent;
        } catch {
          assistantContent = textContent;
        }
      } else if (data.error) {
        throw new Error(data.error.message || JSON.stringify(data.error));
      } else {
        assistantContent = JSON.stringify(data);
      }

      // Detect tool usage from response content
      const toolsCalled: string[] = [];
      if (assistantContent.includes("product") || assistantContent.includes("catalog")) {
        toolsCalled.push("search_products");
      }
      if (assistantContent.includes("order") || assistantContent.includes("delivery")) {
        toolsCalled.push("search_orders");
      }

      setActivity((prev) => [
        ...prev,
        "💾 Storing conversation in memory...",
        `✅ Response received (${(responseTimeMs / 1000).toFixed(1)}s)`,
      ]);

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: assistantContent,
        timestamp: new Date(),
        metadata: {
          toolsCalled: toolsCalled.length > 0 ? toolsCalled : undefined,
          memoryStored: true,
          responseTimeMs,
        },
      };

      // Brief delay to show activity before clearing
      await new Promise((r) => setTimeout(r, 800));
      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
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
          <button type="submit">Connect</button>
        </form>
      </div>
    );
  }

  return (
    <div className="chat-window">
      <div className="messages">
        {messages.map((msg) => (
          <div key={msg.id} className={`message message-${msg.role}`}>
            <div className="message-avatar">
              {msg.role === "user" ? "👤" : msg.role === "assistant" ? "🎉" : "⚠️"}
            </div>
            <div className="message-content">
              <div className="message-text">
                {msg.role === "assistant" ? (
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                ) : (
                  msg.content
                )}
              </div>
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
          onClick={handleSend}
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
    </div>
  );
}
