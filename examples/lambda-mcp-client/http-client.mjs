/**
 * HTTP client for the API Gateway HTTP API in front of the Lambda
 * example. SigV4-signs against service=execute-api with credentials
 * from the default provider chain.
 *
 * Usage:
 *   AGENTCORE_HTTP_API_URL=https://...execute-api.us-west-2.amazonaws.com/prod/mcp \
 *     node http-client.mjs list_sessions CUST-100005
 *   node http-client.mjs get_session_history CUST-100005 session-...
 *   node http-client.mjs chat "Show me birthday party supplies" CUST-100005
 *
 * Required IAM (on the caller, not the Lambda):
 *   - execute-api:Invoke on the API's POST /mcp route ARN.
 */

import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

const URL_STR = process.env.AGENTCORE_HTTP_API_URL;
const REGION = process.env.AWS_REGION || "us-west-2";
const PROFILE = process.env.AWS_PROFILE;

if (!URL_STR) {
  console.error("Set AGENTCORE_HTTP_API_URL (printed by deploy.sh).");
  process.exit(1);
}

async function callApi(payload) {
  const url = new URL(URL_STR);
  const body = JSON.stringify(payload);

  const credentials = await fromNodeProviderChain({ profile: PROFILE })();
  const signer = new SignatureV4({
    service: "execute-api",
    region: REGION,
    credentials,
    sha256: Sha256,
  });
  const signed = await signer.sign(
    new HttpRequest({
      method: "POST",
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        host: url.hostname,
        "content-type": "application/json",
      },
      body,
    })
  );

  const res = await fetch(url, {
    method: "POST",
    headers: signed.headers,
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function main() {
  const [action, a, b] = process.argv.slice(2);
  let payload;
  switch (action) {
    case "chat":
      if (!a) throw new Error("Usage: chat <prompt> [actorId]");
      payload = { action: "chat", prompt: a, ...(b ? { actorId: b } : {}) };
      break;
    case "list_sessions":
      if (!a) throw new Error("Usage: list_sessions <actorId>");
      payload = { action: "list_sessions", actorId: a };
      break;
    case "get_session_history":
      if (!a || !b) throw new Error("Usage: get_session_history <actorId> <sessionId>");
      payload = { action: "get_session_history", actorId: a, sessionId: b };
      break;
    default:
      console.error("Unknown action. Use: chat | list_sessions | get_session_history");
      process.exit(1);
  }

  const result = await callApi(payload);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
