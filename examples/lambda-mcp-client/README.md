# AWS Lambda → AgentCore Gateway MCP Client

This example deploys a small AWS Lambda function that calls the Party Supply gateway's MCP tools (`chat`, `list_sessions`, `get_session_history`) using AWS SigV4. The Lambda authenticates with its **execution-role credentials** — no static API keys, no STS exports — so it's the pattern you'd use to embed AgentCore into a backend workflow (API Gateway, Step Functions, EventBridge, downstream Lambdas).

Companion to the [browser SDK example](../nodejs-client/) and [stand-alone Node CLI](../nodejs-client/session-history.js).

## What it does

The handler in [`index.mjs`](index.mjs) dispatches on `event.action`:

| Action | Calls | Use case |
|---|---|---|
| `chat` | `PartySupplyTarget___chat` | Send a prompt, get back the agent's ChatResponse envelope (cards, chips, etc.). |
| `list_sessions` | `PartySupplyTarget___list_sessions` | List a customer's last-48h conversations (configurable). |
| `get_session_history` | `PartySupplyTarget___get_session_history` | Fetch a single session's full user/assistant timeline. |

Each call:
1. Resolves credentials from the Lambda execution role via `fromNodeProviderChain()`.
2. SigV4-signs a JSON-RPC POST to `${GATEWAY_URL}/mcp` using `service=bedrock-agentcore`.
3. Unwraps the MCP `content[0].text` envelope and `JSON.parse`s it into the structured payload defined in [lambda/tools.json](../../lambda/tools.json).

## Prerequisites

- AWS CLI v2, configured (`aws sts get-caller-identity` works)
- The main Party Supply gateway already deployed (`./scripts/deploy.sh` from repo root)
- `zip` or `7z` on PATH for the deploy script's packaging step
- Local Node.js 22+ if you want to invoke or test it locally (Lambda itself runs `nodejs24.x`)

## Deploy

One script does everything — IAM role, packaging, function create/update:

```bash
cd examples/lambda-mcp-client
./deploy.sh
```

The script auto-detects the gateway URL by searching for a `PartySupply*` gateway in the region. To target a different gateway or non-default region:

```bash
AWS_REGION=us-east-1 \
AGENTCORE_GATEWAY_URL="https://your-gateway.gateway.bedrock-agentcore.us-east-1.amazonaws.com" \
./deploy.sh
```

Other env-var overrides:

| Var | Default | Effect |
|---|---|---|
| `LAMBDA_NAME` | `agentcore-lambda-example` | Lambda function name. |
| `ROLE_NAME` | `agentcore-lambda-example-role` | IAM execution role name. |
| `TIMEOUT` | `60` | Lambda timeout (seconds). |
| `MEMORY` | `256` | Memory (MB). |
| `MCP_TARGET_PREFIX` | `PartySupplyTarget` | Gateway target name (used as the namespace prefix). |

## Invoke

The deploy script prints ready-to-paste invocations. Quick recap:

### Chat

```bash
aws lambda invoke --function-name agentcore-lambda-example --region us-west-2 \
  --cli-binary-format raw-in-base64-out \
  --payload '{
    "action": "chat",
    "prompt": "Show me a birthday party package for a toddler",
    "actorId": "CUST-100005",
    "sessionId": "session-from-some-orchestrator"
  }' /tmp/chat.json && cat /tmp/chat.json
```

`actorId` is optional — without it the agent skips profile personalization. `sessionId` is also optional but recommended so turns from a single workflow accrue into one AgentCore Memory session.

### List recent sessions

```bash
aws lambda invoke --function-name agentcore-lambda-example --region us-west-2 \
  --cli-binary-format raw-in-base64-out \
  --payload '{"action":"list_sessions","actorId":"CUST-100005"}' \
  /tmp/sessions.json && cat /tmp/sessions.json
```

Optional fields in the payload:
- `windowHours` (number) — defaults to `48`. Set to `168` for a week, `1` for the last hour, etc.
- `sinceMs` (number) — explicit epoch-ms lower bound. Takes precedence over `windowHours`.
- `maxSessions` (number) — cap on returned sessions (default 20, hard cap 100).

Returns:
```json
{
  "ok": true,
  "action": "list_sessions",
  "result": {
    "sessions": [
      {
        "sessionId": "session-...",
        "actorId": "CUST-100005",
        "createdAt": 1780951296802,
        "lastEventAt": 1782349811054,
        "firstPrompt": "Show me birthday party supplies"
      }
    ],
    "totalReturned": 1
  }
}
```

### Resume a session

```bash
aws lambda invoke --function-name agentcore-lambda-example --region us-west-2 \
  --cli-binary-format raw-in-base64-out \
  --payload '{
    "action": "get_session_history",
    "actorId": "CUST-100005",
    "sessionId": "session-1780951267383-7bm7iut"
  }' /tmp/history.json && cat /tmp/history.json
```

Returns `{ messages: [{role, content, timestamp}], totalReturned }` oldest-first.

## IAM

The deploy script creates an execution role with:

- `AWSLambdaBasicExecutionRole` (managed) — CloudWatch Logs.
- `InvokeAgentCoreGateway` (inline) — `bedrock-agentcore:InvokeGateway` (authorizes the SigV4-signed `POST /mcp` call) and `:InvokeAgentRuntime` on `Resource: "*"`.

In production, scope the inline policy down to the specific gateway ARN. The example keeps it as `"*"` so the function still works after `./scripts/deploy.sh --clean` recreates the gateway with a new ID.

## Integrating from your own Lambda

If you'd rather embed the client directly into your existing code, you only need three pieces:

```javascript
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

const credentialProvider = fromNodeProviderChain();

async function callTool(toolName, args) {
  const credentials = await credentialProvider();
  const url = new URL(`${process.env.AGENTCORE_GATEWAY_URL}/mcp`);

  const signer = new SignatureV4({
    service: "bedrock-agentcore",
    region: process.env.AWS_REGION,
    credentials,
    sha256: Sha256,
  });
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now().toString(),
    method: "tools/call",
    params: { name: `PartySupplyTarget___${toolName}`, arguments: args },
  });
  const signed = await signer.sign(new HttpRequest({
    method: "POST",
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    headers: { host: url.hostname, "content-type": "application/json" },
    body,
  }));
  const res = await fetch(url, { method: "POST", headers: signed.headers, body });
  const data = await res.json();
  return JSON.parse(data.result.content[0].text);
}
```

That's the entire integration surface — Lambda runtime ships `@aws-sdk/*` and `@smithy/*` preinstalled on nodejs24.x, so bundling is optional.

## Troubleshooting

**"AGENTCORE_GATEWAY_URL env var is required"** — Lambda env var didn't get set. Re-run `deploy.sh` (it auto-populates this from your gateway) or set it manually via `aws lambda update-function-configuration --environment ...`.

**`Authorization error - Insufficient permissions` from the gateway** — execution role is missing `bedrock-agentcore:InvokeGateway`. Verify with `aws iam list-role-policies --role-name agentcore-lambda-example-role` then `aws iam get-role-policy ... --policy-name InvokeAgentCoreGateway`.

**`Internal server error` from the gateway** — most often a stale gateway target. Re-run `./scripts/deploy.sh --gateway-target` from the repo root to refresh the tool schema.

**Tool name not found (`PartySupplyTarget___X`)** — `MCP_TARGET_PREFIX` doesn't match the deployed gateway target name. List targets via:

```bash
GW=$(aws bedrock-agentcore-control list-gateways --region us-west-2 \
  --query "items[?contains(name,'PartySupply')].gatewayId|[0]" --output text)
aws bedrock-agentcore-control list-gateway-targets --gateway-identifier "$GW" --region us-west-2
```

## Cleanup

```bash
aws lambda delete-function --function-name agentcore-lambda-example --region us-west-2
aws iam delete-role-policy --role-name agentcore-lambda-example-role --policy-name InvokeAgentCoreGateway
aws iam detach-role-policy --role-name agentcore-lambda-example-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name agentcore-lambda-example-role
```

## Related

- [Browser/Node CLI example](../nodejs-client/) — same MCP calls from a local shell or React app.
- [Main README — Calling from any MCP client](../../README.md#recent-conversations-sidebar-ui).
- [lambda/tools.json](../../lambda/tools.json) — full inputSchema / outputSchema for all four MCP tools.
