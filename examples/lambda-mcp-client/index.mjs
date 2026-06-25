/**
 * AWS Lambda → AgentCore Gateway MCP Client
 *
 * Example handler showing how a Lambda function can call the Party Supply
 * gateway's MCP tools (chat, list_sessions, get_session_history) using its
 * execution-role credentials via AWS SigV4.
 *
 * Trigger this Lambda with an event shaped like:
 *   { "action": "chat",                 "prompt": "Hello!",       "actorId": "CUST-100005" }
 *   { "action": "list_sessions",        "actorId": "CUST-100005" }
 *   { "action": "get_session_history",  "actorId": "CUST-100005", "sessionId": "session-..." }
 *
 * Required Lambda env vars:
 *   AGENTCORE_GATEWAY_URL   - https://<gateway-id>.gateway.bedrock-agentcore.<region>.amazonaws.com
 *   AWS_REGION              - resolved automatically by Lambda; override if you need to
 *   MCP_TARGET_PREFIX       - gateway target name (default "PartySupplyTarget")
 *
 * Required IAM (attach to the Lambda execution role):
 *   - bedrock-agentcore:InvokeGateway     (authorizes the SigV4-signed
 *                                          POST /mcp call; scope to the
 *                                          specific gateway ARN in prod)
 *   - logs:CreateLogStream / PutLogEvents (Lambda basic execution)
 *
 * No npm install needed: @aws-sdk/* and @smithy/* modules are part of the
 * managed Node.js 24.x Lambda runtime, and `fetch` is built into Node 18+.
 * If you bundle this with your own deps, see package.json.
 */

import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

const GATEWAY_URL = process.env.AGENTCORE_GATEWAY_URL;
const AWS_REGION = process.env.AWS_REGION || "us-west-2";
const TARGET_PREFIX = process.env.MCP_TARGET_PREFIX || "PartySupplyTarget";

// Reuse a single credential provider per container (Lambda re-runs the
// module top-level once per cold start; warm invocations skip this).
// fromNodeProviderChain resolves the Lambda execution role automatically.
const credentialProvider = fromNodeProviderChain();

/** Sign an HTTP request with SigV4 for service=bedrock-agentcore. */
async function signRequest(url, method, body, credentials) {
  const parsedUrl = new URL(url);
  const request = new HttpRequest({
    method,
    protocol: parsedUrl.protocol,
    hostname: parsedUrl.hostname,
    port: parsedUrl.port ? Number(parsedUrl.port) : undefined,
    path: parsedUrl.pathname,
    headers: {
      host: parsedUrl.hostname,
      "content-type": "application/json",
    },
    body,
  });
  const signer = new SignatureV4({
    service: "bedrock-agentcore",
    region: AWS_REGION,
    credentials,
    sha256: Sha256,
  });
  const signed = await signer.sign(request);
  return signed.headers;
}

/**
 * Generic MCP tool caller. Signs and POSTs a JSON-RPC tools/call payload
 * to the gateway's /mcp endpoint, then unwraps the standard MCP content
 * envelope: result.content[0].text → JSON.parse → structured payload.
 *
 * Tool names on the gateway are namespaced as `<TargetPrefix>___<toolName>`.
 */
async function callTool(toolName, args) {
  if (!GATEWAY_URL) {
    throw new Error("AGENTCORE_GATEWAY_URL env var is required");
  }
  const credentials = await credentialProvider();
  const mcpUrl = `${GATEWAY_URL.replace(/\/+$/, "")}/mcp`;

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now().toString(),
    method: "tools/call",
    params: {
      name: `${TARGET_PREFIX}___${toolName}`,
      arguments: args,
    },
  });

  const headers = await signRequest(mcpUrl, "POST", body, credentials);
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${toolName} failed (${response.status}): ${text}`);
  }
  const data = await response.json();
  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  const text = (data.result?.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** chat tool — proxies through to the AgentCore Runtime. */
async function chat({ prompt, sessionId, actorId, conversationHistory }) {
  if (!prompt) throw new Error("`prompt` is required for action=chat");
  return callTool("chat", {
    prompt,
    ...(sessionId ? { sessionId } : {}),
    ...(actorId ? { userId: actorId } : {}),
    conversationHistory: conversationHistory || [],
  });
}

/** list_sessions tool — recent conversations for an actor (default 48h). */
async function listSessions({ actorId, sinceMs, windowHours, maxSessions }) {
  if (!actorId) throw new Error("`actorId` is required for action=list_sessions");
  const effectiveSince =
    typeof sinceMs === "number"
      ? sinceMs
      : Date.now() - (windowHours || 48) * 60 * 60 * 1000;
  return callTool("list_sessions", {
    action: "list_sessions",
    actorId,
    sinceMs: effectiveSince,
    maxSessions: maxSessions || 20,
  });
}

/** get_session_history tool — full timeline for one session. */
async function getSessionHistory({ actorId, sessionId, maxResults }) {
  if (!actorId || !sessionId) {
    throw new Error("`actorId` and `sessionId` are required for action=get_session_history");
  }
  return callTool("get_session_history", {
    action: "get_session_history",
    actorId,
    sessionId,
    maxResults: maxResults || 100,
  });
}

/**
 * Lambda entry point. Dispatches on `event.action`.
 *
 * Returns the raw tool payload so the caller (Step Functions, API Gateway,
 * a downstream Lambda) can consume the structured result directly. Errors
 * are surfaced as `{ ok: false, error }` rather than thrown so async
 * invokers don't trigger destination-on-failure handlers for client-side
 * mistakes - flip this if you'd rather rely on dead-letter queues.
 */
export const handler = async (event) => {
  console.log("Event:", JSON.stringify(event));
  const action = event.action || "chat";

  try {
    let result;
    switch (action) {
      case "chat":
        result = await chat(event);
        break;
      case "list_sessions":
        result = await listSessions(event);
        break;
      case "get_session_history":
        result = await getSessionHistory(event);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
    return { ok: true, action, result };
  } catch (err) {
    console.error("Handler error:", err);
    return {
      ok: false,
      action,
      error: err instanceof Error ? err.message : String(err),
    };
  }
};
