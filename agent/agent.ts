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
  searchInteractions,
  getRecentInteractionsByUser,
  formatInteractionHistory,
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
import {
  ChatResponse,
  ProductCard,
  searchResultToCard,
} from "./response-envelope.js";
import {
  CatalogFacets,
  getCatalogFacets,
} from "./tools/catalog-facets.js";
import {
  renderBasePrompt,
  renderProfileBlock,
} from "./prompt-loader.js";

// ─── Per-request tool result accumulator ───────────────────────────────────
//
// Recommendation tools push their authoritative SearchResult[] here so the
// envelope can carry structured product data even if Claude's prose drifts
// from what the tool actually returned (no hallucinated prices/links).
// Reset at the start of each /invocations call.
const toolCallLog: Array<{ tool: string; results: ProductCard[] }> = [];
function resetToolLog() {
  toolCallLog.length = 0;
}
function recordTool(tool: string, results: Array<{ id: string; score: number; metadata: Record<string, string> }>) {
  toolCallLog.push({ tool, results: results.map(searchResultToCard) });
}

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
    recordTool("search_products", results);
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

const queryInteractionsTool = tool({
  name: "query_interactions",
  description:
    "Search the user-item interaction log (views, add-to-cart, purchases) by semantic query. " +
    "Use this for behavioral questions like 'what has user X been browsing recently', " +
    "'which items did user Y add to cart', or 'show me purchase events for item Z'. " +
    "Each result is one event with userId, itemId, eventType, timestamp, quantity, price. " +
    "If you need product details for the items returned, follow up with search_products. " +
    "If the customer is asking about THEIR own activity, prefer this over search_orders - " +
    "interactions cover all event types (view/cart/purchase), orders only cover completed purchases.",
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "Semantic query (e.g., 'recent views by user 4503601698855094', 'add to cart events', 'purchases of item 14512445')"
      ),
    maxResults: z
      .number()
      .optional()
      .describe("Maximum number of events to return (default: 10)"),
  }),
  callback: async (input) => {
    const results = await searchInteractions(input.query, input.maxResults || 10);
    if (results.length === 0) {
      return "No interaction events found matching your query.";
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
    recordTool("recommend_products", results);
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
    recordTool("personalized_search", results);
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

    recordTool("recommend_for_customer", result.recommendations);

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
//
// Prompt templates live in agent/prompts.md and are uploaded to DynamoDB
// by `./scripts/deploy.sh --prompts`. The runtime calls the loader which
// caches DDB reads for 60s, so prompt edits go live within a minute
// without rebuilding the agent. See agent/prompt-loader.ts for the
// caching/fallback behavior.

/**
 * Build the system prompt. Catalog facets (themes/occasions/categories
 * actually present in S3 Vectors) are embedded so chip suggestions
 * mirror the real product catalog rather than hardcoded examples.
 */
async function buildBasePrompt(facets: CatalogFacets): Promise<string> {
  // Format facet lists for inline use in the prompt. Cap at the cache's
  // top-N to keep the prompt short.
  const themesList = facets.themes.slice(0, 8).join(", ") || "Elegant, Tropical, Rustic";
  const occasionsList = facets.occasions.slice(0, 8).join(", ") || "Birthday, Wedding, Baby Shower";
  const categoriesList = facets.categories.slice(0, 6).join(", ") || "Balloons, Tableware, Decorations";

  return renderBasePrompt({
    THEMES: themesList,
    OCCASIONS: occasionsList,
    CATEGORIES: categoriesList,
  });
}

// Inline prompt body has moved to agent/prompts.md (uploaded to DynamoDB
// by `./scripts/deploy.sh --prompts`). The full historical prompt is
// available in git history if you need to reference it.

/**
 * Build the per-customer tips list. Each non-empty rule becomes a line
 * that gets injected into the PROFILE_TIPS placeholder of the
 * PROFILE_BLOCK template (see agent/prompts.md).
 */
function buildProfileTips(profile: CustomerProfile): string {
  const tips: string[] = [];
  if (profile.preferredTheme) {
    tips.push(`- This customer prefers "${profile.preferredTheme}" themed items - prioritize these in recommendations`);
  }
  if (profile.preferredCategoryL1) {
    tips.push(`- They frequently shop in "${profile.preferredCategoryL1}" - suggest related products`);
  }
  if (profile.priceAffinity === "HIGH") {
    tips.push("- This is a premium customer - feel free to suggest higher-end options");
  }
  if (profile.priceAffinity === "BULK") {
    tips.push("- This is a bulk/business customer - emphasize quantity discounts and bulk options");
  }
  if (profile.daysSinceLastOrder && profile.daysSinceLastOrder > 90) {
    tips.push(`- It's been ${profile.daysSinceLastOrder} days since their last order - consider a welcome-back message`);
  }
  if (profile.lifetimeOrderCount && profile.lifetimeOrderCount > 10) {
    tips.push("- This is a loyal customer - thank them for their continued business");
  }
  return tips.join("\n");
}

/**
 * Build system prompt with catalog facets and optional customer profile.
 * Catalog facets are always required; profile is optional. When a
 * customerProfile is provided we also pass through formatted recent
 * interaction history so the agent has behavioral context up front
 * (rather than needing to call query_interactions to discover it).
 *
 * Templates come from DynamoDB via the prompt-loader.
 */
async function buildSystemPrompt(
  facets: CatalogFacets,
  customerProfile: CustomerProfile | null,
  interactionHistory: string
): Promise<string> {
  const base = await buildBasePrompt(facets);
  if (!customerProfile) return base;

  const profileBlock = await renderProfileBlock({
    PROFILE_CONTEXT: formatCustomerProfile(customerProfile),
    PROFILE_TIPS: buildProfileTips(customerProfile),
    INTERACTION_HISTORY: interactionHistory,
  });

  // PROFILE_BLOCK is optional in prompts.md; if absent we just return the
  // base prompt without the personalization layer.
  return profileBlock ? `${base}\n${profileBlock}` : base;
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
      queryInteractionsTool,
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

      // Load catalog facets, customer profile, and recent interactions in
      // parallel. First-call latency for facets is ~500ms (one-time per
      // container); profile and interactions are ~300-500ms each. Running
      // them concurrently keeps total cold-path overhead under ~600ms.
      const [facets, customerProfile, recentInteractions] = await Promise.all([
        getCatalogFacets(),
        userId
          ? getCustomerProfile(userId).catch((error) => {
              console.warn(`  Failed to load customer profile for ${userId}:`, error);
              return null;
            })
          : Promise.resolve(null),
        userId
          ? getRecentInteractionsByUser(userId, 10).catch((error) => {
              console.warn(`  Failed to load interactions for ${userId}:`, error);
              return [];
            })
          : Promise.resolve([]),
      ]);

      if (userId) {
        console.log(
          customerProfile
            ? `  Loaded customer profile for ${userId} + ${recentInteractions.length} recent interactions`
            : `  No customer profile found for ${userId} (continuing without)`
        );
      }

      // Build personalized system prompt with live catalog facets and
      // recent behavioral context. Empty interaction history is fine -
      // the prompt template handles the placeholder either way.
      const interactionHistory = formatInteractionHistory(recentInteractions);
      const systemPrompt = await buildSystemPrompt(
        facets,
        customerProfile,
        interactionHistory
      );

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

      // Reset the per-request tool log before invoking the agent so we
      // only capture results from THIS turn, not previous ones (the
      // accumulator is module-scoped because Strands tools have no
      // straightforward request-context plumbing).
      resetToolLog();

      // Invoke the agent with the new prompt
      const rawResponse = (await agent.invoke(prompt)).toString();

      // Build the response envelope. We accept three shapes from Claude:
      //   1. Valid JSON envelope              -> use as-is
      //   2. Markdown-fenced JSON envelope    -> strip fence and parse
      //   3. Anything else (free prose, etc.) -> coerce into type="answer"
      // We also detect Bedrock's blockedOutputsMessaging substring and
      // override to type="blocked" regardless of what Claude wrote.
      const envelope = buildEnvelope(rawResponse);

      // Attach product cards from the per-request tool log. The runtime
      // is the source of truth for product data - Claude never sees
      // links/images directly, so it can't hallucinate them.
      const cardsByTool = toolCallLog.flatMap((t) => t.results);
      if (envelope.type === "answer" && cardsByTool.length > 0) {
        // De-dupe by id, preserving order of first appearance
        const seen = new Set<string>();
        envelope.recommendations = cardsByTool.filter((c) => {
          if (seen.has(c.id)) return false;
          seen.add(c.id);
          return true;
        });
      }
      if (toolCallLog.length > 0) {
        envelope.meta = {
          ...(envelope.meta || {}),
          toolsCalled: toolCallLog.map((t) => t.tool),
        };
      }

      // Persist a clean prose-only version to long-term memory. The JSON
      // envelope itself would pollute memory recall.
      const memoryText = envelope.message;
      await storeConversationEvent(
        sessionId,
        actorId,
        "assistant",
        memoryText || rawResponse
      );

      // Return the envelope as a JSON string. Lambda forwards it through
      // unchanged; the UI parses on the other side.
      return JSON.stringify(envelope);
    },
  },
});

/**
 * Coerce whatever Claude returned into a valid ChatResponse envelope.
 * Handles three cases (in order):
 *   1. Bedrock guardrail block message present -> type="blocked"
 *   2. Valid JSON envelope -> use as-is (with stripping of any markdown fence)
 *   3. Anything else -> wrap as type="answer" with the raw text as message
 */
function buildEnvelope(raw: string): ChatResponse {
  // 1. Guardrail intervention check. Bedrock's blockedOutputsMessaging
  // (configured in guardrail-cdk) starts with "I'm sorry, I can't provide
  // that information." We detect on substring because mid-stream blocks
  // concatenate the message onto whatever was being emitted.
  const BLOCK_MARKER = "I'm sorry, I can't provide that information.";
  if (raw.includes(BLOCK_MARKER)) {
    const beforeBlock = raw.split(BLOCK_MARKER)[0].trim();
    const wasMidStream = beforeBlock.length > 0;
    console.warn("[guardrail] Output blocked", {
      wasMidStream,
      partialLength: beforeBlock.length,
    });
    return {
      type: "blocked",
      message: wasMidStream
        ? "Part of my response was filtered. Try a more specific query - e.g., a particular theme, color, or occasion - and I can give you a complete list."
        : "I couldn't complete that request. Try rephrasing with a specific theme, occasion, or product category.",
      meta: { blockedReason: wasMidStream ? "mid-stream" : "full-block" },
    };
  }

  // 2. Try to parse as JSON envelope (with optional markdown fence).
  let candidate = raw.trim();
  const fenced = candidate.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) candidate = fenced[1].trim();
  try {
    const parsed = JSON.parse(candidate) as Partial<ChatResponse>;
    if (
      typeof parsed.type === "string" &&
      typeof parsed.message === "string" &&
      ["answer", "followup", "blocked"].includes(parsed.type)
    ) {
      return parsed as ChatResponse;
    }
  } catch {
    // not JSON, fall through to coercion
  }

  // 3. Coerce free-form prose into type="answer". This is the safety net
  // for when Claude forgets the format - the user still sees something
  // useful, and we log so you can spot drift in CloudWatch.
  console.warn("[envelope] Claude returned non-JSON output, coercing to type=answer", {
    preview: raw.slice(0, 200),
  });
  return {
    type: "answer",
    message: raw,
  };
}

app.run();

console.log("Party Supply Agent is running on port 8080 (with customer profiles and long-term memory)");
