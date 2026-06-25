# Node.js Client for AgentCore Gateway

This example shows how to call the AgentCore Gateway from a Node.js application using AWS SigV4 authentication.

## Prerequisites

- Node.js 18+ (for native `fetch` support)
- AWS credentials with permissions to invoke the AgentCore Gateway
- AgentCore Gateway URL

## Installation

```bash
cd examples/nodejs-client
npm install
```

## Configuration

Set the following environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENTCORE_GATEWAY_URL` | Yes | The AgentCore Gateway endpoint (e.g., `https://xxxx.execute-api.us-west-2.amazonaws.com`) |
| `AWS_PROFILE` | No | AWS profile name to use from `~/.aws/credentials` or `~/.aws/config` |
| `AWS_REGION` | No | AWS region (defaults to `us-west-2`) |
| `TOOL_NAME` | No | MCP tool name (defaults to `PartySupplyTarget___chat`) |

### AWS Credentials

The client uses the **AWS SDK default credential provider chain**, which automatically loads credentials from (in order):

1. **Environment variables** - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`
2. **SSO credentials** - From `aws sso login`
3. **Shared credentials file** - `~/.aws/credentials`
4. **Shared config file** - `~/.aws/config` (with profiles)
5. **EC2/ECS instance metadata** - IAM role attached to the instance
6. **EKS Pod Identity** - For Kubernetes workloads

### Using Default Profile (Local Development)

If you don't specify `AWS_PROFILE`, the SDK uses the `default` profile automatically:

```bash
# Uses ~/.aws/credentials [default] profile
export AGENTCORE_GATEWAY_URL="https://your-gateway.execute-api.us-west-2.amazonaws.com"
node index.js "Hello!"
```

### Using a Specific AWS Profile

If you have multiple profiles configured, specify which one to use:

```bash
export AWS_PROFILE="my-profile-name"
```

Or use SSO:

```bash
aws sso login --profile my-sso-profile
export AWS_PROFILE="my-sso-profile"
```

### On Lambda with Execution Role

**No credential configuration needed!** The SDK automatically resolves credentials from the Lambda execution role. Just set the gateway URL as an environment variable in your Lambda configuration:

```
AGENTCORE_GATEWAY_URL=https://your-gateway.execute-api.us-west-2.amazonaws.com
```

The execution role must have permissions to invoke the AgentCore Gateway (`bedrock-agentcore:InvokeAgent` or similar).

### On EC2/ECS with IAM Roles

Same as Lambda - the SDK automatically uses the attached IAM role via instance metadata:

```bash
# Just set the gateway URL - credentials come from the instance/task role
export AGENTCORE_GATEWAY_URL="https://your-gateway.execute-api.us-west-2.amazonaws.com"
node index.js "Hello!"
```

### Manual Credentials (for testing)

If you need to manually export credentials:

```bash
aws configure export-credentials
```

Then set them as environment variables:

```bash
export AWS_ACCESS_KEY_ID="ASIA..."
export AWS_SECRET_ACCESS_KEY="..."
export AWS_SESSION_TOKEN="..."
```

## Usage

### Interactive Mode

Start an interactive chat session:

```bash
# Set gateway URL and optionally specify a profile
export AGENTCORE_GATEWAY_URL="https://your-gateway-url.execute-api.us-west-2.amazonaws.com"
export AWS_PROFILE="my-profile"  # optional

# Start interactive chat
npm start
```

Example session:

```
🎉 AgentCore Chat Client
   Type your message and press Enter. Type 'exit' to quit.

You: What party supplies do you have?

📡 Calling AgentCore Gateway...
   URL: https://xxxx.execute-api.us-west-2.amazonaws.com/mcp
   Tool: PartySupplyTarget___chat
   Prompt: "What party supplies do you have?"

🤖 Assistant: We have a great selection of party supplies! ...

You: exit

Goodbye! 👋
```

### Single Message Mode

Send a single message and get a response:

```bash
npm start "What balloon colors do you have?"
```

Or directly:

```bash
node index.js "Check order status for ORD-12345"
```

### One-liner with Profile

```bash
AWS_PROFILE="my-profile" \
AGENTCORE_GATEWAY_URL="https://your-gateway.execute-api.us-west-2.amazonaws.com" \
node index.js "Hello, what can you help me with?"
```

## How It Works

1. **SigV4 Signing**: The client signs each request using AWS Signature Version 4 with the `bedrock-agentcore` service name.

2. **MCP Protocol**: Requests are sent as JSON-RPC 2.0 messages following the Model Context Protocol (MCP):

   ```json
   {
     "jsonrpc": "2.0",
     "id": "unique-id",
     "method": "tools/call",
     "params": {
       "name": "PartySupplyTarget___chat",
       "arguments": {
         "prompt": "Your message here"
       }
     }
   }
   ```

3. **Response Parsing**: The response contains the agent's reply in the MCP content format.

## Integrating into Your Application

### Basic Example

```javascript
const { chat } = require('./index');

async function myApp() {
  const response = await chat("What products do you recommend for a birthday party?");
  console.log(response);
}
```

### With Custom Error Handling

```javascript
const { SignatureV4 } = require("@smithy/signature-v4");
const { HttpRequest } = require("@smithy/protocol-http");
const { Sha256 } = require("@aws-crypto/sha256-js");

async function callAgent(prompt, credentials, gatewayUrl) {
  const mcpUrl = `${gatewayUrl}/mcp`;
  
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now().toString(),
    method: "tools/call",
    params: {
      name: "PartySupplyTarget___chat",
      arguments: { prompt },
    },
  });

  // Sign request
  const signer = new SignatureV4({
    service: "bedrock-agentcore",
    region: "us-west-2",
    credentials,
    sha256: Sha256,
  });

  const request = new HttpRequest({
    method: "POST",
    protocol: "https:",
    hostname: new URL(gatewayUrl).hostname,
    path: "/mcp",
    headers: {
      host: new URL(gatewayUrl).hostname,
      "content-type": "application/json",
    },
    body,
  });

  const signedRequest = await signer.sign(request);

  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: signedRequest.headers,
    body,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  return response.json();
}
```

## Calling Session-History MCP Tools

In addition to `chat`, the gateway exposes two MCP tools for the conversation-history sidebar feature:

| Tool | Purpose |
|---|---|
| `list_sessions` | List an actor's recent sessions with first-prompt previews. |
| `get_session_history` | Fetch the full user/assistant timeline for a single session. |

A second example script, [`session-history.js`](session-history.js), shows how to call both with the same SigV4 + JSON-RPC plumbing as the chat client.

```bash
# Set up env
export AGENTCORE_GATEWAY_URL="https://your-gateway.gateway.bedrock-agentcore.us-west-2.amazonaws.com"
export AWS_PROFILE="my-profile"          # optional - defaults to default chain
export MCP_TARGET_PREFIX="PartySupplyTarget"  # optional - matches deploy.sh

# List the actor's recent sessions (last 48h by default)
node session-history.js list CUST-100005

# Output:
# • session-1780951267383-7bm7iut
#     12m ago  —  show me birthday party supplies
# • session-1782345670123-abc1234
#     2h ago   —  Where's my order ORD-12345?
#
# 2 session(s).

# Fetch the full timeline of a specific session
node session-history.js resume CUST-100005 session-1780951267383-7bm7iut

# Output:
# 👤 USER  [2026-06-25T01:09:37.045Z]
#   show me birthday party supplies
#
# 🤖 ASSISTANT  [2026-06-25T01:09:46.480Z]
#   Great! Here are some awesome birthday party supplies...
#
# (4 message(s))
```

### Programmatic Use

The script also exports its primitives so you can reuse them in your own code:

```javascript
const {
  callTool,
  listSessions,
  getSessionHistory,
} = require("./session-history");

async function showRecentChats(actorId) {
  // Window can be customized — pass sinceMs explicitly, or windowHours for
  // human-readable lookback. Both feed the tool's sinceMs argument.
  const { sessions } = await listSessions(actorId, { windowHours: 168 });

  for (const s of sessions) {
    const history = await getSessionHistory(actorId, s.sessionId, 50);
    console.log(`Session ${s.sessionId} — ${history.messages.length} turns`);
  }
}
```

`callTool(toolName, args)` is generic — point it at any MCP tool the gateway target exposes and it'll handle signing, JSON-RPC framing, and result parsing for you.

### What the tools return

`list_sessions` → `{ sessions: [{sessionId, actorId, createdAt, lastEventAt, firstPrompt}], totalReturned }`. Filter/sort happens server-side based on `lastEventAt` (so reused sessionIds with fresh events still surface). See [lambda/tools.json](../../lambda/tools.json) for the full output schema.

`get_session_history` → `{ messages: [{role, content, timestamp}], totalReturned }`, oldest-first. Only conversational text is recoverable — product cards and chip envelopes are not persisted in AgentCore Memory.

### Required IAM

The caller's principal needs `bedrock-agentcore:InvokeAgent`-style permission on the gateway (same as the `chat` tool). The Lambda fronting the tools handles the `bedrock-agentcore:ListSessions` / `ListEvents` calls itself via its execution role — `./scripts/deploy.sh --lambda` wires the `MemoryHistoryAccess` policy automatically.

## Troubleshooting

### "AGENTCORE_GATEWAY_URL environment variable is required"

Set the gateway URL:

```bash
export AGENTCORE_GATEWAY_URL="https://your-gateway.execute-api.us-west-2.amazonaws.com"
```

### "The security token included in the request is invalid"

Your AWS credentials may be expired. Get fresh credentials:

```bash
aws configure export-credentials
```

### "Access Denied" or 403 Error

Ensure your IAM user/role has permissions to invoke the AgentCore Gateway. Check with your administrator.

### "fetch is not defined"

You need Node.js 18 or later. Check your version:

```bash
node --version
```

## Related

- [Chat UI](../../chat-ui/) - Browser-based chat interface
- [Agent Lambda](../../agent/) - The agent implementation
- [AgentCore Setup](../../agentcore/) - Gateway configuration
