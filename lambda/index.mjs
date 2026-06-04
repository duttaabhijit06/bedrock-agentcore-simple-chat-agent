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

const REGION = process.env.AGENT_REGION || process.env.AWS_REGION || "us-west-2";
const RUNTIME_ARN = process.env.RUNTIME_ARN;

const client = new BedrockAgentCoreClient({ region: REGION });

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
  console.log("Event:", JSON.stringify(event));

  const prompt = event.prompt || event.message || "Hello";
  // Use provided sessionId or generate one from Lambda request context
  const sessionId = event.sessionId || context.awsRequestId || `session-${Date.now()}`;
  // Conversation history from UI (array of {role, content} objects)
  const conversationHistory = event.conversationHistory || [];

  console.log("Session ID:", sessionId);
  console.log("History length:", conversationHistory.length);

  try {
    // Include sessionId and history in the payload so the agent can use it
    const payloadBody = JSON.stringify({ prompt, sessionId, conversationHistory });

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

    // Try to parse as JSON
    try {
      const parsed = JSON.parse(result);
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
