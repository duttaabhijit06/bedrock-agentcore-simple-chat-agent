/**
 * Gateway Lambda Target
 *
 * Invoked by the AgentCore Gateway when the "chat" tool is called.
 * Forwards the prompt to the AgentCore Runtime agent and returns the response.
 */

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
  ListSessionsCommand,
  ListEventsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  S3VectorsClient,
  ListVectorsCommand,
} from "@aws-sdk/client-s3vectors";

const REGION = process.env.AGENT_REGION || process.env.AWS_REGION || "us-west-2";
const RUNTIME_ARN = process.env.RUNTIME_ARN;
const VECTOR_BUCKET_NAME =
  process.env.VECTOR_BUCKET_NAME || "party-supply-vectors";
// MEMORY_ID is the resolved AgentCore Memory id (e.g.
// "PartySupply_PartySupplyMemory-abc1234567"). Needed for the
// ListSessions / ListEvents calls the UI's history sidebar makes.
const MEMORY_ID = process.env.MEMORY_ID;

// Adaptive retry so ThrottlingException on the chat forward path
// (InvokeAgentRuntime) or on customer-selector ListVectors calls
// backs off rather than surfacing as a Gateway 5xx.
const RETRY_CONFIG = { maxAttempts: 10, retryMode: "adaptive" };
const client = new BedrockAgentCoreClient({ region: REGION, ...RETRY_CONFIG });
const s3vectors = new S3VectorsClient({ region: REGION, ...RETRY_CONFIG });

// Middleware to force Content-Type: application/json (runtime requires it)
client.middlewareStack.add(
  (next) => async (args) => {
    if (args.request && args.request.headers) {
      args.request.headers["content-type"] = "application/json";
    }
    return next(args);
  },
  { step: "build", name: "forceJsonContentType", priority: "low" }
);

export const handler = async (event, context) => {
  // Warm-up ping from EventBridge keeps Lambda containers hot so first
  // user request after a quiet period doesn't pay cold-start cost
  // (~1-2s on Node.js). EventBridge passes `{"warmup": true}` per the
  // schedule rule deploy.sh creates. Short-circuit and don't touch the
  // runtime - we just need the container alive.
  if (event && event.warmup === true) {
    console.log("Warm-up ping received");
    return { warmed: true };
  }

  // Dispatch on tool action. The chat tool is the default (no `action`
  // field needed, preserving back-compat with older UIs). The list_customers
  // tool is a lightweight read-only call against the customers vector index
  // - it doesn't go through the AgentCore runtime, so it's fast and cheap.
  if (event && event.action === "list_customers") {
    return await handleListCustomers(event);
  }
  if (event && event.action === "list_sessions") {
    return await handleListSessions(event);
  }
  if (event && event.action === "get_session_history") {
    return await handleGetSessionHistory(event);
  }

  console.log("Event:", JSON.stringify(event));

  const prompt = event.prompt || event.message || "Hello";
  // Use provided sessionId or generate one from Lambda request context
  const sessionId = event.sessionId || context.awsRequestId || `session-${Date.now()}`;
  // Conversation history from UI (array of {role, content} objects)
  const conversationHistory = event.conversationHistory || [];
  // Optional customer identity for personalization. When set, the runtime
  // loads the customer profile + last 10 interactions and injects them
  // into the system prompt.
  const userId = event.userId || undefined;

  console.log("Session ID:", sessionId);
  console.log("History length:", conversationHistory.length);
  if (userId) console.log("User ID:", userId);

  try {
    // Include sessionId, history, and (if present) userId so the agent
    // can personalize responses with profile + interaction context.
    const payloadBody = JSON.stringify({
      prompt,
      sessionId,
      conversationHistory,
      ...(userId ? { userId } : {}),
    });

    const command = new InvokeAgentRuntimeCommand({
      agentRuntimeArn: RUNTIME_ARN,
      payload: payloadBody,
      qualifier: "DEFAULT",
      sessionId: sessionId,
    });

    const response = await client.send(command);

    // The response body is an async iterable stream
    let result = "";
    const decoder = new TextDecoder();

    if (response.body) {
      for await (const event of response.body) {
        // Try all possible event shapes
        if (event.chunk?.bytes) {
          result += decoder.decode(event.chunk.bytes, { stream: true });
        } else if (event.bytes) {
          result += decoder.decode(event.bytes, { stream: true });
        } else if (typeof event === "object") {
          // The stream might yield raw Uint8Array chunks
          const raw = event.chunk || event.data || event;
          if (raw instanceof Uint8Array) {
            result += decoder.decode(raw, { stream: true });
          } else if (raw.body) {
            result += typeof raw.body === "string" ? raw.body : decoder.decode(raw.body, { stream: true });
          }
        }
      }
    }

    // If streaming didn't yield content, check for direct output
    if (!result && response.output) {
      result = typeof response.output === "string" ? response.output : JSON.stringify(response.output);
    }
    if (!result && response.payload) {
      result = typeof response.payload === "string" ? response.payload : decoder.decode(response.payload);
    }
    if (!result && response.response) {
      // InvokeAgentRuntime returns the response in the 'response' field
      if (typeof response.response === "string") {
        result = response.response;
      } else if (response.response instanceof Uint8Array) {
        result = decoder.decode(response.response);
      } else if (typeof response.response === "object") {
        // Could be a readable stream or buffer
        const chunks = [];
        for await (const chunk of response.response) {
          chunks.push(typeof chunk === "string" ? chunk : decoder.decode(chunk));
        }
        result = chunks.join("");
      }
    }

    console.log("Runtime response length:", result.length);
    console.log("Runtime response preview:", result.substring(0, 200));

    if (!result) {
      // Log the full response object keys for debugging
      console.log("Response keys:", Object.keys(response));
      console.log("Response body type:", typeof response.body);
      console.log("Response.response type:", typeof response.response);
      console.log("Response.response value:", JSON.stringify(response.response)?.substring(0, 200));
      return { response: "The agent processed your request but returned no text content." };
    }

    // Try to parse as JSON. The agent now returns a structured ChatResponse
    // envelope (see agent/response-envelope.ts):
    //   { type: "answer"|"followup"|"blocked", message, recommendations?, followups?, meta? }
    // We forward the envelope verbatim to the UI when we recognize it.
    // Older legacy shapes (output/result/message/text) still work as a
    // fallback so a client/server version mismatch doesn't break chat.
    try {
      const parsed = JSON.parse(result);

      // Detect new envelope by its discriminator
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.type === "string" &&
        ["answer", "followup", "blocked"].includes(parsed.type)
      ) {
        return { envelope: parsed, response: parsed.message || "" };
      }

      // Legacy: agent returned a shaped object but not the envelope.
      // Pull text out for the UI's old code path.
      return {
        response: parsed.output || parsed.result || parsed.message || parsed.text || JSON.stringify(parsed),
      };
    } catch {
      return { response: result };
    }
  } catch (error) {
    console.error("Error:", error.message);
    return {
      error: error.message,
      response: "Sorry, I encountered an error processing your request.",
    };
  }
};

/**
 * list_customers tool handler.
 *
 * Returns a paginated list of customers from the S3 Vectors customers-index
 * for the UI's customer-selector type-ahead. Returns at most `limit` customers
 * per call (default 500); the UI can paginate via `nextToken` if more are
 * needed but with 5K customers a single call is usually enough.
 *
 * Response shape:
 *   {
 *     customers: [{userId, customerType, customerSegment, region, lifetimeSpend, ...}],
 *     nextToken: string | null,
 *     totalReturned: number
 *   }
 *
 * This handler runs inside the Lambda but does NOT invoke the AgentCore
 * runtime - it just reads metadata directly from S3 Vectors. Latency is
 * ~500ms for a 500-row page.
 */
async function handleListCustomers(event) {
  const limit = Math.min(event.limit || 500, 500); // S3 Vectors caps at 500 per call
  const nextToken = event.nextToken || undefined;

  try {
    const out = await s3vectors.send(
      new ListVectorsCommand({
        vectorBucketName: VECTOR_BUCKET_NAME,
        indexName: "customers-index",
        maxResults: limit,
        returnMetadata: true,
        nextToken,
      })
    );

    const customers = (out.vectors || []).map((v) => {
      const m = v.metadata || {};
      return {
        userId: v.key || m.userId || "",
        customerType: m.customerType || "",
        customerSegment: m.customerSegment || "",
        region: m.region || "",
        state: m.state || "",
        preferredTheme: m.preferredTheme || "",
        priceAffinity: m.priceAffinity || "",
        lifetimeSpend: m.lifetimeSpend || "",
      };
    });

    return {
      customers,
      nextToken: out.nextToken || null,
      totalReturned: customers.length,
    };
  } catch (error) {
    console.error("list_customers error:", error.message);
    return {
      customers: [],
      nextToken: null,
      totalReturned: 0,
      error: error.message,
    };
  }
}

/**
 * list_sessions tool handler.
 *
 * Lists chat sessions for a given actor within an optional time window.
 * Backed entirely by AgentCore Memory's `ListSessions` + `ListEvents`
 * APIs - no separate database. AgentCore Memory is the source of truth.
 *
 * Per-session "firstPrompt" is fetched via ListEvents(maxResults=1...)
 * for each session in parallel. With the typical UI request of ~10-20
 * sessions per window that's a small fan-out (~500ms total).
 *
 * Input:
 *   {
 *     action: "list_sessions",
 *     actorId: "CUST-...",           // required
 *     sinceMs: 1718380800000,        // optional, defaults to 48h ago
 *     maxSessions: 20                // optional, defaults to 20
 *   }
 *
 * Output:
 *   {
 *     sessions: [
 *       {
 *         sessionId: "...",
 *         actorId: "...",
 *         createdAt: 1718380800000,   // epoch ms
 *         firstPrompt: "show me birthday party supplies"  // empty if no user event
 *       }
 *     ],
 *     totalReturned: 5
 *   }
 */
async function handleListSessions(event) {
  if (!MEMORY_ID) {
    return { sessions: [], totalReturned: 0, error: "MEMORY_ID env var not set" };
  }
  const actorId = event.actorId;
  if (!actorId || actorId === "anonymous") {
    return { sessions: [], totalReturned: 0 };
  }

  const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
  const sinceMs = typeof event.sinceMs === "number"
    ? event.sinceMs
    : Date.now() - FORTY_EIGHT_HOURS_MS;
  const maxSessions = Math.min(event.maxSessions || 20, 100);

  try {
    // Pool the actor's sessions. We can't filter by "recent activity" via
    // ListSessions (it only returns createdAt) - a session created weeks
    // ago can still receive fresh CreateEvent calls if the UI reuses the
    // sessionId across reloads. So we collect a generous pool, then derive
    // lastEventAt from ListEvents below.
    const pool = [];
    let nextToken;
    let pages = 0;
    const POOL_CAP = 100;

    do {
      const out = await client.send(
        new ListSessionsCommand({
          memoryId: MEMORY_ID,
          actorId,
          maxResults: 100,
          ...(nextToken ? { nextToken } : {}),
        })
      );
      const summaries = out.sessionSummaries || [];
      for (const s of summaries) {
        const createdMs = s.createdAt instanceof Date
          ? s.createdAt.getTime()
          : Number(s.createdAt) || 0;
        pool.push({
          sessionId: s.sessionId,
          actorId: s.actorId,
          createdAt: createdMs,
        });
      }
      nextToken = out.nextToken;
      pages++;
      if (pool.length >= POOL_CAP || pages >= 5) break;
    } while (nextToken);

    // Fan out ListEvents to find both the first user prompt and the last
    // event timestamp per session. We then filter by lastEventAt >= sinceMs
    // and sort by lastEventAt desc - this is what users actually mean by
    // "recent conversations" (sessions with recent activity, not sessions
    // whose first turn was recent).
    const enriched = await Promise.all(
      pool.map(async (s) => {
        try {
          const ev = await client.send(
            new ListEventsCommand({
              memoryId: MEMORY_ID,
              actorId,
              sessionId: s.sessionId,
              maxResults: 20,
              includePayloads: true,
            })
          );
          const events = (ev.events || []).slice().sort((a, b) => {
            const at = a.eventTimestamp instanceof Date ? a.eventTimestamp.getTime() : Number(a.eventTimestamp) || 0;
            const bt = b.eventTimestamp instanceof Date ? b.eventTimestamp.getTime() : Number(b.eventTimestamp) || 0;
            return at - bt;
          });
          const firstUser = events.find((e) => extractRole(e) === "USER");
          const firstPrompt = firstUser ? extractText(firstUser).slice(0, 200) : "";
          const last = events[events.length - 1];
          const lastEventAt = last
            ? (last.eventTimestamp instanceof Date ? last.eventTimestamp.getTime() : Number(last.eventTimestamp) || 0)
            : s.createdAt;
          return { ...s, firstPrompt, lastEventAt };
        } catch (err) {
          console.warn("list_sessions: ListEvents failed for", s.sessionId, err.message);
          return { ...s, firstPrompt: "", lastEventAt: s.createdAt };
        }
      })
    );

    const filtered = enriched
      .filter((s) => s.lastEventAt >= sinceMs)
      .sort((a, b) => b.lastEventAt - a.lastEventAt)
      .slice(0, maxSessions);

    return { sessions: filtered, totalReturned: filtered.length };
  } catch (error) {
    console.error("list_sessions error:", error.message);
    return { sessions: [], totalReturned: 0, error: error.message };
  }
}

/**
 * get_session_history tool handler.
 *
 * Returns the full event timeline for a session so the UI can re-hydrate
 * the chat when a user clicks an entry in the sidebar. Events are sorted
 * oldest -> newest and mapped to the shape the UI's chat history expects.
 *
 * Input:
 *   {
 *     action: "get_session_history",
 *     actorId: "CUST-...",
 *     sessionId: "session-...",
 *     maxResults: 100               // optional, defaults to 50
 *   }
 *
 * Output:
 *   {
 *     messages: [{ role: "user"|"assistant", content: "...", timestamp: 123 }],
 *     totalReturned: N
 *   }
 */
async function handleGetSessionHistory(event) {
  if (!MEMORY_ID) {
    return { messages: [], totalReturned: 0, error: "MEMORY_ID env var not set" };
  }
  const { actorId, sessionId } = event;
  if (!actorId || !sessionId) {
    return { messages: [], totalReturned: 0, error: "actorId and sessionId required" };
  }
  const maxResults = Math.min(event.maxResults || 50, 100);

  try {
    const out = await client.send(
      new ListEventsCommand({
        memoryId: MEMORY_ID,
        actorId,
        sessionId,
        maxResults,
        includePayloads: true,
      })
    );
    const events = (out.events || []).slice().sort((a, b) => {
      const at = a.eventTimestamp instanceof Date ? a.eventTimestamp.getTime() : Number(a.eventTimestamp) || 0;
      const bt = b.eventTimestamp instanceof Date ? b.eventTimestamp.getTime() : Number(b.eventTimestamp) || 0;
      return at - bt;
    });

    const messages = events
      .map((e) => {
        const role = extractRole(e);
        const content = extractText(e);
        if (!role || !content) return null;
        const ts = e.eventTimestamp instanceof Date ? e.eventTimestamp.getTime() : Number(e.eventTimestamp) || 0;
        return {
          role: role.toLowerCase(), // "USER" -> "user"
          content,
          timestamp: ts,
        };
      })
      .filter(Boolean);

    return { messages, totalReturned: messages.length };
  } catch (error) {
    console.error("get_session_history error:", error.message);
    return { messages: [], totalReturned: 0, error: error.message };
  }
}

/**
 * Pull the role out of an AgentCore Memory event payload.
 * Payload shape: payload[0].conversational.role = "USER" | "ASSISTANT"
 */
function extractRole(event) {
  const first = (event.payload || [])[0];
  return first?.conversational?.role || null;
}

/**
 * Pull the text content out of an AgentCore Memory event payload.
 * Payload shape: payload[0].conversational.content.text
 */
function extractText(event) {
  const first = (event.payload || [])[0];
  const content = first?.conversational?.content;
  if (!content) return "";
  if (typeof content === "string") return content;
  if ("text" in content) return content.text || "";
  return "";
}
