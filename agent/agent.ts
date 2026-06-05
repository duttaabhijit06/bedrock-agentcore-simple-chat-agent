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
import { Agent, tool, Message, TextBlock, BedrockModel } from "@strands-agents/sdk";
import { z } from "zod";

// ─── Guardrail Configuration ────────────────────────────────────────────────
// Guardrail ID and version are set via environment variables during deployment
// These are created by the agentcore CDK stack
const GUARDRAIL_ID = process.env.GUARDRAIL_ID;
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION;
import {
  ragSearch,
  searchProducts,
  searchOrders,
  getCustomerProfile,
  formatCustomerProfile,
  CustomerProfile,
} from "./tools/rag-search.js";
import {
  recommendProducts,
  recommendForCustomer,
  personalizedSearch,
} from "./tools/recommend.js";
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

// ─── Recommendation Tools ──────────────────────────────────────────────────

function formatRecommendations(
  results: Array<{ id: string; score: number; metadata: Record<string, string> }>
): string {
  if (results.length === 0) return "No products matched.";
  return results
    .map((r, i) => {
      const m = r.metadata;
      const lines = [`${i + 1}. ${m.title || r.id}`];
      if (m.price) lines.push(`   Price: $${m.price}`);
      if (m.theme) lines.push(`   Theme: ${m.theme}`);
      if (m.category) lines.push(`   Category: ${m.category}`);
      if (m.availability) lines.push(`   Availability: ${m.availability}`);
      if (m.description) lines.push(`   ${m.description.slice(0, 200)}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

const recommendProductsTool = tool({
  name: "recommend_products",
  description:
    "Recommend products based on structured event criteria (theme, occasion, budget, color, age group, guest count). " +
    "Use this when the customer describes what they want for a specific event - it's better than search_products because " +
    "it over-fetches candidates, drops out-of-stock items, and re-ranks by customer profile match when a customer ID is " +
    "available. Pass customerId only if you know it (e.g., from lookup_customer or context).",
  inputSchema: z.object({
    theme: z.string().optional().describe("Visual theme (e.g., 'unicorn', 'tropical', 'rustic', 'glow party')"),
    occasion: z.string().optional().describe("Event type (e.g., 'birthday', 'wedding', 'baby shower', 'graduation')"),
    category: z.string().optional().describe("Product category (e.g., 'balloons', 'tableware', 'decorations')"),
    color: z.string().optional().describe("Preferred color"),
    ageGroup: z.string().optional().describe("Age group (e.g., 'kids', 'teens', 'adults', 'all ages')"),
    budget: z.enum(["low", "mid", "high", "bulk"]).optional()
      .describe("Budget tier - low (under $30), mid ($20-80), high (premium $60+), bulk (wholesale)"),
    guestCount: z.number().optional().describe("Number of guests at the event"),
    keywords: z.string().optional().describe("Free-form keywords to add to the search"),
    customerId: z.string().optional().describe("Customer ID for personalized re-ranking"),
    maxResults: z.number().optional().describe("Max recommendations to return (default: 5)"),
  }),
  callback: async (input) => {
    const { customerId, maxResults, ...criteria } = input;
    const results = await recommendProducts(criteria, customerId, {
      topK: maxResults || 5,
    });
    return formatRecommendations(results);
  },
});

const personalizedSearchTool = tool({
  name: "personalized_search",
  description:
    "Free-text product search that automatically biases results toward the current customer's stored preferences. " +
    "Use this in place of search_products when you know the customer (have a customerId) and want results tilted " +
    "toward their preferred theme and price tier. The customer's own search query takes priority - the personalization " +
    "only nudges ranking, it doesn't override their intent.",
  inputSchema: z.object({
    query: z.string().describe("What the customer is searching for"),
    customerId: z.string().optional().describe("Customer ID for personalization (falls back to plain search if missing)"),
    maxResults: z.number().optional().describe("Max results (default: 5)"),
  }),
  callback: async (input) => {
    const results = await personalizedSearch(input.query, input.customerId, {
      topK: input.maxResults || 5,
    });
    return formatRecommendations(results);
  },
});

const recommendForCustomerTool = tool({
  name: "recommend_for_customer",
  description:
    "Generate 'for you' recommendations for a customer using only their stored profile (preferred theme, occasion, " +
    "price affinity, segment) - no other criteria needed. Use this when a customer asks 'what should I buy?' or " +
    "'what would you suggest for me?' without specifying an event. Returns the customer's profile alongside the " +
    "recommendations so you can explain *why* you're suggesting each item.",
  inputSchema: z.object({
    customerId: z.string().describe("The customer ID to generate recommendations for"),
    maxResults: z.number().optional().describe("Max recommendations to return (default: 5)"),
  }),
  callback: async (input) => {
    const result = await recommendForCustomer(input.customerId, {
      topK: input.maxResults || 5,
    });

    if (!result.profile) {
      return `No profile found for customer ID: ${input.customerId}. Cannot generate personalized recommendations.`;
    }

    const parts: string[] = [];
    parts.push("## Customer Profile (basis for recommendations)");
    parts.push(formatCustomerProfile(result.profile));
    parts.push("\n## Recommended Products");
    parts.push(formatRecommendations(result.recommendations));
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
- If a customer asks about an order, search orders first
- Provide specific product details (price, description) when available
- If you cannot find what the customer is looking for, suggest alternatives
- Format responses clearly with product names, prices, and key details
- Remember customer preferences (favorite themes, colors, event types) for future interactions

Tool selection for product queries:
- **recommend_products**: when the customer describes an event with specific criteria (theme, occasion, budget, guest count). Filters out-of-stock and re-ranks by profile.
- **personalized_search**: when the customer types a free-text search AND you have their customerId. Biases ranking toward their stored preferences.
- **recommend_for_customer**: when a known customer asks "what should I buy?" without specifying an event. Uses only their profile.
- **search_products**: anonymous customers with simple keyword searches.

Recommendation flow (follow this order):

1. **Always check memory first** for known recommendations. Call \`recall_customer_context\` with a relevant query (e.g., "party preferences", "preferred themes", "budget") before asking the customer anything. If the customer has a known userId, also call \`lookup_customer\` to fetch their stored profile (preferred theme, occasion, price affinity, segment).

2. **Use what you know to fill in gaps.** If memory or the profile already tells you the customer's typical occasion, theme, or budget, treat those as defaults - don't re-ask for things you already know.

3. **If criteria are still missing, ask follow-ups via the chip block** (see format below). Pick the 3 most useful questions you don't already have answers to. Never ask more than 5 questions in one turn, and don't ask the customer to repeat anything you already learned from memory.

4. **Once you have enough context, call \`recommend_products\` (or \`recommend_for_customer\` if the user is known and didn't specify an event).** Don't ever call \`recommend_products\` with empty filters - if you'd be passing nothing useful, ask follow-ups instead.

Follow-up chip format (only used in step 3):

\`\`\`
<followups>
{"questions": [
  {"id": "occasion", "label": "What's the occasion?", "options": [
    {"label": "🎂 Birthday", "value": "birthday party"},
    {"label": "💍 Wedding", "value": "wedding"},
    {"label": "👶 Baby Shower", "value": "baby shower"}
  ]},
  {"id": "budget", "label": "What's your budget?", "options": [
    {"label": "Under $50", "value": "budget-friendly"},
    {"label": "$50-$200", "value": "mid-range"},
    {"label": "Premium", "value": "premium"}
  ]}
]}
</followups>
\`\`\`

Rules for follow-up blocks:
- **CRITICAL**: ANY follow-up question to refine recommendations MUST be inside a <followups> block. NEVER write follow-up questions as a numbered list, bullet list, or plain prose. The UI parses <followups> into clickable chips - questions written as text won't render as chips and will look like the agent ignored its own instructions.
- This applies even when you've already returned a partial recommendation list and want to refine it. Examples:
  - WRONG: "Want more tailored recommendations? Just tell me: 1. Who's the birthday for? 2. Theme? 3. Budget?"
  - RIGHT: "Want more tailored picks? <followups>{...JSON with the same 3 questions...}</followups>"
- Pick the 3-5 *most informative* questions; never exceed 5 per turn.
- Skip any question you can answer from memory or the customer's profile.
- 3-5 options per question is ideal.
- Use emoji prefixes for visual scanning (e.g., 🎂, 💍, 👶, 🎃, 🏖️).
- The "value" field is what gets sent back to you, so phrase it as you'd want to receive it (e.g., "birthday party for kids" not just "birthday").
- Place the JSON between literal \`<followups>\` and \`</followups>\` tags. The UI strips it before rendering.
- Above the block, write a short prompt like "Tell me a bit more so I can recommend the right items:" so users see context before the chips.
- One <followups> block per turn, not multiple.

When showing partial recommendations and refining:
- It is fine (and encouraged) to show a few products THEN ask follow-ups in the same turn.
- The follow-ups still go in a <followups> block - never as plain text.
- Order: brief intro -> product list -> short refining prompt -> <followups> block.`;

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

  // Configure BedrockModel with optional guardrail
  // Guardrail config is passed via additionalArgs to the Converse API
  const modelConfig: {
    modelId: string;
    additionalArgs?: {
      guardrailConfig?: {
        guardrailIdentifier: string;
        guardrailVersion: string;
        trace?: string;
      };
    };
  } = {
    modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  };

  // Add guardrail if configured via environment variables
  if (GUARDRAIL_ID && GUARDRAIL_VERSION) {
    console.log(`  Using guardrail: ${GUARDRAIL_ID} v${GUARDRAIL_VERSION}`);
    modelConfig.additionalArgs = {
      guardrailConfig: {
        guardrailIdentifier: GUARDRAIL_ID,
        guardrailVersion: GUARDRAIL_VERSION,
        trace: "enabled",
      },
    };
  }

  const model = new BedrockModel(modelConfig);

  return new Agent({
    model,
    tools: [
      searchProductsTool,
      searchOrdersTool,
      searchAllTool,
      lookupCustomerTool,
      recommendProductsTool,
      personalizedSearchTool,
      recommendForCustomerTool,
      recallMemoryTool,
    ],
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
      let response = result.toString();

      // Detect guardrail interventions. The guardrail replaces blocked
      // output with the configured `blockedOutputsMessaging`, often
      // mid-stream (we'll see "<partial response>I'm sorry, I can't
      // provide that information..."). Detecting this lets us turn a
      // confusing truncation into a clear explanation for the customer.
      const BLOCK_MESSAGE = "I'm sorry, I can't provide that information.";
      if (response.includes(BLOCK_MESSAGE)) {
        const beforeBlock = response.split(BLOCK_MESSAGE)[0].trim();
        const wasMidStream = beforeBlock.length > 0;
        console.warn("[guardrail] Output blocked", {
          wasMidStream,
          partialLength: beforeBlock.length,
        });
        if (wasMidStream) {
          // Replace the truncation with something self-aware. Trim trailing
          // partial words/punctuation/dashes to avoid sentences cutting off.
          const trimmed = beforeBlock.replace(/[\s\-,:;.]*$/, "");
          response =
            `${trimmed}\n\n_(The system flagged part of my answer mid-response. ` +
            `Try a more specific query - e.g., a particular theme, color, or ` +
            `occasion - and I can give you a complete list.)_`;
        } else {
          // Whole response was blocked - keep the canned message but make it
          // actionable.
          response =
            "I couldn't complete that request. Try rephrasing with a specific " +
            "theme, occasion, or product category and I'll do my best.";
        }
      }

      // Store the assistant response in long-term memory.
      // Strip the <followups>...</followups> JSON block - it's UI scaffolding,
      // not semantic content, and would pollute the customer's memory record
      // and any future RAG searches over conversation history.
      const memoryText = response.replace(/<followups>[\s\S]*?<\/followups>/g, "").trim();
      await storeConversationEvent(
        sessionId,
        actorId,
        "assistant",
        memoryText || response
      );

      return response;
    },
  },
});

app.run();

console.log("Party Supply Agent is running on port 8080 (with customer profiles and long-term memory)");
