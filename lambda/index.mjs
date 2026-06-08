/**
 * Gateway Lambda Target
 *
 * Invoked by the AgentCore Gateway when the "chat" tool is called.
 * Forwards the prompt to the AgentCore Runtime agent and returns the response.
 */

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  S3VectorsClient,
  ListVectorsCommand,
} from "@aws-sdk/client-s3vectors";

const REGION = process.env.AGENT_REGION || process.env.AWS_REGION || "us-west-2";
const RUNTIME_ARN = process.env.RUNTIME_ARN;
const VECTOR_BUCKET_NAME =
  process.env.VECTOR_BUCKET_NAME || "party-supply-vectors";

const client = new BedrockAgentCoreClient({ region: REGION });
const s3vectors = new S3VectorsClient({ region: REGION });

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
