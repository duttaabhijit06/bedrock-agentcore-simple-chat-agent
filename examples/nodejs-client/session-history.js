/**
 * AgentCore Gateway - Session History MCP Example
 *
 * Demonstrates how to call the `list_sessions` and `get_session_history`
 * MCP tools exposed by the Party Supply gateway, using AWS SigV4
 * authentication from Node.js.
 *
 * Usage:
 *   AGENTCORE_GATEWAY_URL=https://your-gateway.../mcp \
 *   node session-history.js list   CUST-100005
 *   node session-history.js resume CUST-100005 session-1780951267383-7bm7iut
 *
 * The two tools are part of the standard MCP toolSchema on the gateway
 * target, so any MCP client (Claude Desktop, a downstream agent, your
 * own code) can call them through the same gateway URL once IAM grants
 * `bedrock-agentcore:InvokeAgent`-style access.
 */

const { SignatureV4 } = require("@smithy/signature-v4");
const { HttpRequest } = require("@smithy/protocol-http");
const { Sha256 } = require("@aws-crypto/sha256-js");
const { fromNodeProviderChain } = require("@aws-sdk/credential-providers");

const GATEWAY_URL = process.env.AGENTCORE_GATEWAY_URL;
const AWS_REGION = process.env.AWS_REGION || "us-west-2";
const AWS_PROFILE = process.env.AWS_PROFILE;

// Gateway tool names are namespaced as `<TargetName>___<toolName>`.
// The default target deployed by ./scripts/deploy.sh is "PartySupplyTarget".
const TARGET_PREFIX = process.env.MCP_TARGET_PREFIX || "PartySupplyTarget";

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
 * Call any MCP tool on the gateway over JSON-RPC.
 *
 * The gateway returns tool results wrapped in MCP `content` blocks; for
 * Lambda-backed targets the result is a single text block whose body is
 * a JSON string. We parse that here so callers see the structured shape
 * defined by the tool's outputSchema in lambda/tools.json.
 */
async function callTool(toolName, args) {
  if (!GATEWAY_URL) {
    throw new Error("AGENTCORE_GATEWAY_URL environment variable is required");
  }
  const credentials = await fromNodeProviderChain({ profile: AWS_PROFILE })();
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

/**
 * list_sessions — fetch recent sessions for an actor (default 48h).
 *
 * Backed by `bedrock-agentcore:ListSessions` + per-session `ListEvents`
 * fan-out. Returns sessions sorted by lastEventAt desc, which means a
 * sessionId reused across days still surfaces if it has fresh activity.
 */
async function listSessions(actorId, opts = {}) {
  const sinceMs =
    typeof opts.sinceMs === "number"
      ? opts.sinceMs
      : Date.now() - (opts.windowHours || 48) * 60 * 60 * 1000;
  return callTool("list_sessions", {
    action: "list_sessions",
    actorId,
    sinceMs,
    maxSessions: opts.maxSessions || 20,
  });
}

/**
 * get_session_history — fetch the full event timeline of a session.
 *
 * Returns messages oldest -> newest as `[{role, content, timestamp}]`.
 * Note: only the conversational text is recoverable from AgentCore
 * Memory; the original ChatResponse envelope (product cards, chips) is
 * not persisted, so a resumed UI shows prose only.
 */
async function getSessionHistory(actorId, sessionId, maxResults = 100) {
  return callTool("get_session_history", {
    action: "get_session_history",
    actorId,
    sessionId,
    maxResults,
  });
}

function relativeTime(ms) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

async function cmdList(actorId) {
  console.log(`\nFetching sessions for ${actorId} (last 48h)...\n`);
  const result = await listSessions(actorId);
  if (!result.sessions || result.sessions.length === 0) {
    console.log("(no recent sessions)");
    return;
  }
  for (const s of result.sessions) {
    const when = relativeTime(s.lastEventAt || s.createdAt);
    console.log(`• ${s.sessionId}`);
    console.log(`    ${when}  —  ${s.firstPrompt || "(no opening prompt)"}`);
  }
  console.log(`\n${result.sessions.length} session(s).`);
}

async function cmdResume(actorId, sessionId) {
  console.log(`\nFetching history for ${sessionId}...\n`);
  const result = await getSessionHistory(actorId, sessionId);
  if (!result.messages || result.messages.length === 0) {
    console.log("(no messages found)");
    return;
  }
  for (const m of result.messages) {
    const tag = m.role === "user" ? "👤 USER" : "🤖 ASSISTANT";
    console.log(`${tag}  [${new Date(m.timestamp).toISOString()}]`);
    console.log(`  ${m.content.slice(0, 500)}\n`);
  }
  console.log(`(${result.messages.length} message(s))`);
}

async function main() {
  const [cmd, actorId, sessionId] = process.argv.slice(2);
  if (cmd === "list" && actorId) {
    await cmdList(actorId);
  } else if (cmd === "resume" && actorId && sessionId) {
    await cmdResume(actorId, sessionId);
  } else {
    console.log(
      "Usage:\n" +
        "  node session-history.js list   <actorId>\n" +
        "  node session-history.js resume <actorId> <sessionId>\n"
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nError: ${err.message}\n`);
  process.exit(1);
});

module.exports = { callTool, listSessions, getSessionHistory };
