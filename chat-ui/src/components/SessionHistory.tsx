import { useEffect, useState } from "react";
import { signRequest, getCredentials } from "../lib/sigv4";

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL || "";

/**
 * How far back (in hours) the sidebar fetches sessions for. Override at
 * build time with VITE_HISTORY_WINDOW_HOURS - e.g. set to 168 for a week
 * of history. Defaults to 48 to match the original product spec.
 */
const HISTORY_WINDOW_HOURS = Math.max(
  1,
  Number(import.meta.env.VITE_HISTORY_WINDOW_HOURS) || 48
);

/**
 * Background poll cadence in seconds. Override with VITE_HISTORY_POLL_SECONDS.
 * Set to 0 to disable polling entirely (refresh chip + post-send nudge
 * still work). Defaults to 30s.
 */
const HISTORY_POLL_SECONDS = Math.max(
  0,
  Number(import.meta.env.VITE_HISTORY_POLL_SECONDS) || 30
);

/** Sidebar header label - derives from the configured window for clarity. */
const HISTORY_HEADER = HISTORY_WINDOW_HOURS % 24 === 0
  ? `Recent (${HISTORY_WINDOW_HOURS / 24}d)`
  : `Recent (${HISTORY_WINDOW_HOURS}h)`;

export interface SessionSummary {
  sessionId: string;
  actorId: string;
  createdAt: number; // epoch ms
  /**
   * Timestamp of the most recent event in the session. The sidebar sorts
   * and displays by this, not createdAt - a session whose first turn was
   * weeks ago can still be "recent" if the UI is reusing the sessionId.
   */
  lastEventAt: number;
  firstPrompt: string;
}

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

interface SessionHistoryProps {
  /** Customer whose sessions to fetch. Required - history is per-user. */
  actorId: string | null;
  /** Currently active sessionId (so we can highlight it in the list). */
  currentSessionId: string;
  /**
   * Called with the full message timeline when the user clicks a past
   * session. The parent re-hydrates the chat and switches the active
   * sessionId so new turns continue that thread.
   */
  onResume: (sessionId: string, messages: SessionMessage[]) => void;
  /**
   * Bump to trigger a one-shot reload (e.g. after the user clicks
   * "New chat" the parent increments this so the sidebar refreshes
   * even though actorId hasn't changed).
   */
  refreshKey?: number;
}

/**
 * 48-hour conversation history panel.
 *
 * Backed entirely by AgentCore Memory (no DDB / no separate state store):
 *   - `list_sessions` Lambda tool → AgentCore ListSessions + ListEvents
 *   - `get_session_history` Lambda tool → AgentCore ListEvents
 *
 * Re-fetches when the actorId changes (e.g. customer selector switches).
 * No actor → renders an empty-state message rather than a list.
 */
export function SessionHistory({ actorId, currentSessionId, onResume, refreshKey }: SessionHistoryProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);

  // (Re)load whenever the actor changes or the parent bumps refreshKey
  // (e.g. after "New chat" is clicked). We keep the loadSessions function
  // out of the dep array deliberately - it would otherwise re-create on
  // every render and re-fire the effect.
  useEffect(() => {
    if (!actorId) {
      setSessions([]);
      setLoadState("idle");
      return;
    }
    void loadSessions(actorId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId, refreshKey]);

  // Background polling: re-fetch on a configurable cadence so new
  // sessions / new turns appear in the sidebar without the user clicking
  // the refresh chip. Disabled when HISTORY_POLL_SECONDS is 0 or when
  // no actor is selected.
  useEffect(() => {
    if (!actorId || HISTORY_POLL_SECONDS <= 0) return;
    const id = setInterval(() => {
      void loadSessions(actorId, { silent: true });
    }, HISTORY_POLL_SECONDS * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId]);

  async function callGatewayTool<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
    const credentials = getCredentials();
    if (!credentials) throw new Error("AWS credentials not set");

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: `${Date.now()}`,
      method: "tools/call",
      params: {
        name: `PartySupplyTarget___${toolName}`,
        arguments: args,
      },
    });
    const url = `${GATEWAY_URL}/mcp`;
    const signedHeaders = await signRequest(url, "POST", body, credentials);
    const response = await fetch(url, {
      method: "POST",
      headers: { ...signedHeaders, "content-type": "application/json" },
      body,
    });
    if (!response.ok) {
      throw new Error(`${toolName} failed: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    const text = data?.result?.content
      ?.filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("\n") || "{}";
    return JSON.parse(text) as T;
  }

  async function loadSessions(forActor: string, opts?: { silent?: boolean }) {
    if (!opts?.silent) {
      setLoadState("loading");
      setLoadError(null);
    }
    try {
      const result = await callGatewayTool<{ sessions: SessionSummary[] }>(
        "list_sessions",
        {
          action: "list_sessions",
          actorId: forActor,
          // Configurable lookback window. Backend will short-circuit
          // older sessions even if more exist.
          sinceMs: Date.now() - HISTORY_WINDOW_HOURS * 60 * 60 * 1000,
          maxSessions: 20,
        }
      );
      setSessions(Array.isArray(result.sessions) ? result.sessions : []);
      setLoadState("loaded");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.error("[SessionHistory] load failed:", e);
      if (!opts?.silent) {
        setLoadError(msg);
        setLoadState("error");
      }
    }
  }

  async function handleResume(s: SessionSummary) {
    if (!actorId) return;
    if (resumingId) return; // ignore double-clicks
    setResumingId(s.sessionId);
    try {
      const result = await callGatewayTool<{ messages: SessionMessage[] }>(
        "get_session_history",
        {
          action: "get_session_history",
          actorId,
          sessionId: s.sessionId,
          maxResults: 100,
        }
      );
      onResume(s.sessionId, Array.isArray(result.messages) ? result.messages : []);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.error("[SessionHistory] resume failed:", e);
      setLoadError(msg);
    } finally {
      setResumingId(null);
    }
  }

  /** Friendly "2h ago" style timestamp without pulling in date-fns. */
  function relativeTime(ms: number): string {
    const diff = Date.now() - ms;
    if (diff < 60_000) return "just now";
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  return (
    <aside className="session-history">
      <div className="sh-header">
        <span className="sh-title">{HISTORY_HEADER}</span>
        {actorId && loadState === "loaded" && (
          <button
            type="button"
            className="sh-refresh"
            onClick={() => loadSessions(actorId)}
            title="Refresh session list"
          >
            ↻
          </button>
        )}
      </div>

      {!actorId && (
        <div className="sh-empty">
          Select a customer above to see their recent conversations.
        </div>
      )}

      {actorId && loadState === "loading" && (
        <div className="sh-status">Loading sessions...</div>
      )}

      {actorId && loadState === "error" && (
        <div className="sh-status sh-error">
          {loadError}
          <button type="button" onClick={() => loadSessions(actorId)}>Retry</button>
        </div>
      )}

      {actorId && loadState === "loaded" && sessions.length === 0 && (
        <div className="sh-empty">
          No conversations in the last {HISTORY_WINDOW_HOURS} hours.
        </div>
      )}

      {actorId && loadState === "loaded" && sessions.length > 0 && (
        <ul className="sh-list">
          {sessions.map((s) => {
            const isActive = s.sessionId === currentSessionId;
            const isResuming = resumingId === s.sessionId;
            return (
              <li key={s.sessionId}>
                <button
                  type="button"
                  className={`sh-row ${isActive ? "sh-row-active" : ""}`}
                  onClick={() => handleResume(s)}
                  disabled={isResuming || isActive}
                  title={isActive ? "Current session" : "Resume this conversation"}
                >
                  <div className="sh-row-prompt">
                    {s.firstPrompt || <em>(no opening prompt found)</em>}
                  </div>
                  <div className="sh-row-meta">
                    <span>{relativeTime(s.lastEventAt || s.createdAt)}</span>
                    {isActive && <span className="sh-row-active-tag">current</span>}
                    {isResuming && <span className="sh-row-loading-tag">loading...</span>}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
