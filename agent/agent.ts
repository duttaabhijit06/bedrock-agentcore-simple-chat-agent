/**
 * Party Supply Chat Agent
 *
 * A Strands Agent deployed to Amazon Bedrock AgentCore Runtime.
 * Uses Claude Sonnet 4.5 for reasoning, S3 Vectors RAG for
 * party supply product/order knowledge, and AgentCore Memory
 * for long-term customer context (preferences, facts, summaries).
 *
 * Supports optional customer profile lookup via userId for personalization.
 */

import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { Agent, tool, Message, TextBlock } from "@strands-agents/sdk";
import { z } from "zod";
import {
  ragSearch,
  searchProducts,
  searchOrders,
  getCustomerProfile,
  formatCustomerProfile,
  CustomerProfile,
} from "./tools/rag-search.js";
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

// ─── Customer Lookup Tool ───────────────────────────────────────────────────

const lookupCustomerTool = tool({
  name: "lookup_customer",
  description:
    "Look up a customer by their ID to get their profile and order history. Returns customer preferences, segment, lifetime spend, and recent orders. Use this when a customer asks about their account, preferences, or past orders.",
  inputSchema: z.object({
    customerId: z
      .string()
      .describe("The customer ID to look up (e.g., 'CUST-201', '93107547')"),
  }),
  callback: async (input) => {
    const results: {
      profile: CustomerProfile | null;
      orders: Array<{ id: string; score: number; metadata: Record<string, string> }>;
    } = {
      profile: null,
      orders: [],
    };

    // 1. First, look up customer profile from customers index
    try {
      results.profile = await getCustomerProfile(input.customerId);
    } catch (error) {
      console.warn(`Customer profile lookup failed for ${input.customerId}:`, error);
    }

    // 2. Then, search for orders by this customer
    try {
      const orderResults = await searchOrders(`customer ${input.customerId}`, 5);
      results.orders = orderResults;
    } catch (error) {
      console.warn(`Order search failed for ${input.customerId}:`, error);
    }

    // Format response
    const parts: string[] = [];

    if (results.profile) {
      parts.push("## Customer Profile");
      parts.push(formatCustomerProfile(results.profile));
    } else {
      parts.push(`No customer profile found for ID: ${input.customerId}`);
    }

    if (results.orders.length > 0) {
      parts.push("\n## Order History");
      results.orders.forEach((order) => {
        const meta = order.metadata;
        parts.push(`- Order ${meta.orderId || order.id}: ${meta.status || 'Unknown'} - $${meta.total || '0'} (${meta.orderDate || 'Unknown date'})`);
        if (meta.items) {
          try {
            const items = JSON.parse(meta.items);
            items.forEach((item: { productName: string; quantity: number }) => {
              parts.push(`  - ${item.productName} x${item.quantity}`);
            });
          } catch {
            // Items not parseable, skip
          }
        }
      });
    } else if (results.profile) {
      parts.push("\nNo order history found for this customer.");
    }

    if (!results.profile && results.orders.length === 0) {
      return `No customer or order data found for ID: ${input.customerId}`;
    }

    return parts.join("\n");
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

// ─── System Prompt Builder ──────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are a helpful party supply customer service agent with long-term memory. You assist customers with:

1. **Product Discovery** - Help customers find the right party supplies for their events
2. **Order Inquiries** - Look up order status, delivery information, and order history
3. **Customer Account** - Look up customer profiles, preferences, and purchase history
4. **Recommendations** - Suggest products based on themes, budgets, and event types
5. **Personalization** - Remember customer preferences across conversations

Guidelines:
- Always be friendly, enthusiastic, and helpful
- Use recall_customer_context at the start of conversations to check for returning customers
- Use lookup_customer when a customer asks about their account, preferences, or order history by ID
- When searching for products, use descriptive queries to get the best results
- If a customer asks about an order, search orders first
- Provide specific product details (price, description) when available
- If you cannot find what the customer is looking for, suggest alternatives
- Format responses clearly with product names, prices, and key details
- Remember customer preferences (favorite themes, colors, event types) for future interactions`;

/**
 * Build system prompt with optional customer profile context
 */
function buildSystemPrompt(customerProfile: CustomerProfile | null): string {
  if (!customerProfile) {
    return BASE_SYSTEM_PROMPT;
  }

  const profileContext = formatCustomerProfile(customerProfile);

  return `${BASE_SYSTEM_PROMPT}

## Current Customer Profile

The following customer profile was loaded from the customer database. Use this information to personalize your recommendations:

${profileContext}

**Personalization Tips:**
${customerProfile.preferredTheme ? `- This customer prefers "${customerProfile.preferredTheme}" themed items - prioritize these in recommendations` : ""}
${customerProfile.preferredCategoryL1 ? `- They frequently shop in "${customerProfile.preferredCategoryL1}" - suggest related products` : ""}
${customerProfile.priceAffinity === "HIGH" ? "- This is a premium customer - feel free to suggest higher-end options" : ""}
${customerProfile.priceAffinity === "BULK" ? "- This is a bulk/business customer - emphasize quantity discounts and bulk options" : ""}
${customerProfile.daysSinceLastOrder && customerProfile.daysSinceLastOrder > 90 ? `- It's been ${customerProfile.daysSinceLastOrder} days since their last order - consider a welcome-back message` : ""}
${customerProfile.lifetimeOrderCount && customerProfile.lifetimeOrderCount > 10 ? "- This is a loyal customer - thank them for their continued business" : ""}`;
}

// ─── Agent Setup ────────────────────────────────────────────────────────────

/**
 * Create an Agent with conversation history.
 * Since container may restart between requests, we pass history from UI.
 */
function createAgentWithHistory(
  systemPrompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): Agent {
  // Convert history to Strands SDK Message format
  const messages = history.map(
    (msg) =>
      new Message({
        role: msg.role,
        content: [new TextBlock(msg.content)],
      })
  );

  console.log(`  Creating agent with ${messages.length} history messages`);

  return new Agent({
    model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    tools: [searchProductsTool, searchOrdersTool, searchAllTool, lookupCustomerTool, recallMemoryTool],
    systemPrompt,
    messages,
  });
}

// Track current actor for memory tool access
let currentActorId = "anonymous";

// ─── Runtime Application ────────────────────────────────────────────────────

// Type for conversation history passed from UI
interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    process: async (payload, context) => {
      const body = payload as {
        prompt?: string;
        actorId?: string;
        userId?: string;
        sessionId?: string;
        conversationHistory?: ConversationMessage[];
      };
      const prompt = body.prompt ?? "Hello! How can I help you?";
      const conversationHistory = body.conversationHistory || [];

      // Support both actorId and userId for customer identification
      // userId is the customer profile lookup key, actorId is for memory
      const userId = body.userId || body.actorId;
      const actorId = body.actorId || body.userId || context.sessionId || "anonymous";
      currentActorId = actorId;

      // Use sessionId from payload (sent by UI via Lambda) or fall back to context
      const sessionId = body.sessionId || context.sessionId;

      console.log(
        `Session ${sessionId} | Actor ${actorId}${userId ? ` | User ${userId}` : ""} - Received: ${prompt.substring(0, 100)}`
      );
      console.log(`  Conversation history: ${conversationHistory.length} messages`);

      // Attempt to load customer profile if userId is provided
      // This is optional and gracefully degrades if not available
      let customerProfile: CustomerProfile | null = null;
      if (userId) {
        try {
          customerProfile = await getCustomerProfile(userId);
          if (customerProfile) {
            console.log(`  Loaded customer profile for ${userId}`);
          } else {
            console.log(`  No customer profile found for ${userId} (continuing without)`);
          }
        } catch (error) {
          console.warn(`  Failed to load customer profile for ${userId}:`, error);
          // Continue without profile - graceful degradation
        }
      }

      // Build personalized system prompt
      const systemPrompt = buildSystemPrompt(customerProfile);

      // Create agent with conversation history from UI
      // (Container may restart between requests, so we can't rely on in-memory state)
      const agent = createAgentWithHistory(systemPrompt, conversationHistory);

      // Store the user message in long-term memory
      await storeConversationEvent(
        sessionId,
        actorId,
        "user",
        prompt
      );

      // Invoke the agent with the new prompt
      const result = await agent.invoke(prompt);
      const response = result.toString();

      // Store the assistant response in long-term memory
      await storeConversationEvent(
        sessionId,
        actorId,
        "assistant",
        response
      );

      return response;
    },
  },
});

app.run();

console.log("Party Supply Agent is running on port 8080 (with customer profiles and long-term memory)");
