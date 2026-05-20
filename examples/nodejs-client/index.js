/**
 * Node.js Client for AgentCore Gateway
 *
 * This example demonstrates how to call the AgentCore Gateway
 * using AWS SigV4 authentication from a Node.js application.
 */

const { SignatureV4 } = require("@smithy/signature-v4");
const { HttpRequest } = require("@smithy/protocol-http");
const { Sha256 } = require("@aws-crypto/sha256-js");
const { fromNodeProviderChain } = require("@aws-sdk/credential-providers");

// Configuration - set these via environment variables
const GATEWAY_URL = process.env.AGENTCORE_GATEWAY_URL;
const AWS_REGION = process.env.AWS_REGION || "us-west-2";
const AWS_PROFILE = process.env.AWS_PROFILE; // Optional: use a specific profile
const TOOL_NAME = process.env.TOOL_NAME || "PartySupplyTarget___chat";

/**
 * Sign an HTTP request with AWS SigV4
 */
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

  const signedRequest = await signer.sign(request);
  return signedRequest.headers;
}

/**
 * Call the AgentCore Gateway with a chat message
 */
async function chat(prompt) {
  if (!GATEWAY_URL) {
    throw new Error("AGENTCORE_GATEWAY_URL environment variable is required");
  }

  // Get credentials using the default credential provider chain:
  // 1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)
  // 2. SSO credentials from AWS CLI
  // 3. Shared credentials file (~/.aws/credentials)
  // 4. EC2/ECS instance metadata (IAM role)
  // 5. And more...
  const credentialProvider = fromNodeProviderChain({
    profile: AWS_PROFILE, // Use specific profile if set, otherwise default
  });
  const credentials = await credentialProvider();

  const mcpUrl = `${GATEWAY_URL}/mcp`;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: Date.now().toString(),
    method: "tools/call",
    params: {
      name: TOOL_NAME,
      arguments: {
        prompt,
      },
    },
  });

  console.log(`\n📡 Calling AgentCore Gateway...`);
  console.log(`   URL: ${mcpUrl}`);
  console.log(`   Tool: ${TOOL_NAME}`);
  console.log(`   Prompt: "${prompt}"\n`);

  // Sign the request
  const signedHeaders = await signRequest(mcpUrl, "POST", body, credentials);

  // Make the request
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      ...signedHeaders,
      "content-type": "application/json",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gateway error (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // Parse the response
  if (data.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }

  if (data.result?.content) {
    const textContent = data.result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    // Try to parse nested JSON response
    try {
      const parsed = JSON.parse(textContent);
      return parsed.response || parsed.output || textContent;
    } catch {
      return textContent;
    }
  }

  return JSON.stringify(data, null, 2);
}

/**
 * Interactive CLI mode
 */
async function interactiveMode() {
  const readline = require("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("🎉 AgentCore Chat Client");
  console.log("   Type your message and press Enter. Type 'exit' to quit.\n");

  const askQuestion = () => {
    rl.question("You: ", async (input) => {
      const trimmed = input.trim();
      if (trimmed.toLowerCase() === "exit") {
        console.log("\nGoodbye! 👋");
        rl.close();
        return;
      }

      if (!trimmed) {
        askQuestion();
        return;
      }

      try {
        const response = await chat(trimmed);
        console.log(`\n🤖 Assistant: ${response}\n`);
      } catch (error) {
        console.error(`\n❌ Error: ${error.message}\n`);
      }

      askQuestion();
    });
  };

  askQuestion();
}

/**
 * Single message mode
 */
async function singleMessage(prompt) {
  try {
    const response = await chat(prompt);
    console.log(`\n🤖 Response:\n${response}\n`);
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(1);
  }
}

// Main entry point
async function main() {
  const args = process.argv.slice(2);

  if (args.length > 0) {
    // Single message mode: node index.js "your message here"
    await singleMessage(args.join(" "));
  } else {
    // Interactive mode
    await interactiveMode();
  }
}

main();
