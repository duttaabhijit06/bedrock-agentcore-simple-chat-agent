/**
 * Party Supply Chat Agent
 *
 * A Strands Agent deployed to Amazon Bedrock AgentCore Runtime.
 * Uses Claude Sonnet 4.5 for reasoning, S3 Vectors RAG for
 * party supply product/order knowledge, and AgentCore Memory
 * for long-term customer context (preferences, facts, summaries).
 */

import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import { ragSearch, searchProducts, searchOrders } from "./tools/rag-search.js";
import {
  storeConversationEvent,
  retrieveMemories,
} from "./tools/memory.js";

// ─── RAG Tools ──────────────────────────────────────────────────────────────

const searchProductsTool = tool({
  name: "search_products",
  description:
    "Search the party supply product catalog. Use this to find products by name, category, theme, or description. Returns matching products with details like price, availability, and description.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "Search query for products (e.g., 'birthday balloons', 'halloween decorations', 'wedding supplies')"
      ),
    maxResults: z
      .number()
      .optional()
      .describe("Maximum number of results to return (default: 5)"),
  }),
  callback: async (input) => {
    const results = await searchProducts(input.query, input.maxResults || 5);
    if (results.length === 0) {
      return "No products found matching your query.";
    }
    return JSON.stringify(results, null, 2);
  },
});

const searchOrdersTool = tool({
  name: "search_orders",
  description:
    "Search customer orders. Use this to find order information including status, items ordered, delivery dates, and customer details.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "Search query for orders (e.g., 'pending delivery', 'order #12345', 'bulk orders')"
      ),
    maxResults: z
      .number()
      .optional()
      .describe("Maximum number of results to return (default: 5)"),
  }),
  callback: async (input) => {
    const results = await searchOrders(input.query, input.maxResults || 5);
    if (results.length === 0) {
      return "No orders found matching your query.";
    }
    return JSON.stringify(results, null, 2);
  },
});

const searchAllTool = tool({
  name: "search_all",
  description:
    "Search across both products and orders simultaneously. Use this for general queries that might span both catalogs.",
  inputSchema: z.object({
    query: z.string().describe("General search query across products and orders"),
    maxResults: z
      .number()
      .optional()
      .describe("Maximum number of results per category to return (default: 3)"),
  }),
  callback: async (input) => {
    const results = await ragSearch(input.query, input.maxResults || 3);
    return JSON.stringify(results, null, 2);
  },
});

// ─── Memory Tool ────────────────────────────────────────────────────────────

const recallMemoryTool = tool({
  name: "recall_customer_context",
  description:
    "Recall what you know about this customer from previous conversations. Use this at the start of a conversation or when the customer references something from a past interaction. Returns preferences, facts, and session summaries.",
  inputSchema: z.object({
    query: z
      .string()
      .describe("What to recall about the customer (e.g., 'party preferences', 'past orders', 'event details')"),
  }),
  callback: async (input) => {
    const actorId = currentActorId || "anonymous";
    const memories = await retrieveMemories(actorId, input.query, 5);
    if (memories.length === 0) {
      return "No previous context found for this customer.";
    }
    return memories.join("\n");
  },
});

// ─── System Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a helpful party supply customer service agent with long-term memory. You assist customers with:

1. **Product Discovery** - Help customers find the right party supplies for their events
2. **Order Inquiries** - Look up order status, delivery information, and order history
3. **Recommendations** - Suggest products based on themes, budgets, and event types
4. **Personalization** - Remember customer preferences across conversations

Guidelines:
- Always be friendly, enthusiastic, and helpful
- Use recall_customer_context at the start of conversations to check for returning customers
- When searching for products, use descriptive queries to get the best results
- If a customer asks about an order, search orders first
- Provide specific product details (price, description) when available
- If you cannot find what the customer is looking for, suggest alternatives
- Format responses clearly with product names, prices, and key details
- Remember customer preferences (favorite themes, colors, event types) for future interactions`;

// ─── Agent Setup ────────────────────────────────────────────────────────────

const agent = new Agent({
  model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  tools: [searchProductsTool, searchOrdersTool, searchAllTool, recallMemoryTool],
  systemPrompt: SYSTEM_PROMPT,
});

// Track current actor for memory tool access
let currentActorId = "anonymous";

// ─── Runtime Application ────────────────────────────────────────────────────

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async (payload, context) => {
      try {
        const body = payload as { prompt?: string; actorId?: string };
        const prompt = body.prompt ?? "Hello! How can I help you?";
        const actorId = body.actorId || context.sessionId || "anonymous";
        currentActorId = actorId;

        console.log(
          `Session ${context.sessionId} | Actor ${actorId} - Received: ${prompt.substring(0, 100)}`
        );

        // Store the user message in memory
        try {
          await storeConversationEvent(
            context.sessionId,
            actorId,
            "user",
            prompt
          );
        } catch (memErr) {
          console.error("[memory] storeConversationEvent (user) failed:", memErr);
        }

        // Invoke the agent
        let response: string;
        try {
          const result = await agent.invoke(prompt);
          response = result.toString();
          console.log(`Agent response length: ${response.length}`);
        } catch (agentErr) {
          console.error("[agent] invoke failed:", agentErr);
          if (agentErr instanceof Error) {
            console.error("[agent] stack:", agentErr.stack);
          }
          throw agentErr;
        }

        // Store the assistant response in memory
        try {
          await storeConversationEvent(
            context.sessionId,
            actorId,
            "assistant",
            response
          );
        } catch (memErr) {
          console.error("[memory] storeConversationEvent (assistant) failed:", memErr);
        }

        return response;
      } catch (err) {
        console.error("[handler] Unhandled error:", err);
        if (err instanceof Error) {
          console.error("[handler] message:", err.message);
          console.error("[handler] stack:", err.stack);
        }
        throw err;
      }
    },
  },
});

app.run();

console.log("Party Supply Agent is running on port 8080 (with long-term memory)");
