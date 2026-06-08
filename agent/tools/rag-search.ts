/**
 * RAG Search Tool - Queries S3 Vectors for party supply product, order, and customer data
 * Uses Amazon Titan Text Embeddings V2 to embed the query, then performs
 * vector similarity search against the S3 Vectors index.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

import {
  S3VectorsClient,
  QueryVectorsCommand,
  GetVectorsCommand,
} from "@aws-sdk/client-s3vectors";

const REGION = process.env.AWS_REGION || "us-west-2";
const VECTOR_BUCKET_NAME =
  process.env.VECTOR_BUCKET_NAME || "party-supply-vectors";
const EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0";

const bedrockClient = new BedrockRuntimeClient({ region: REGION });
const s3VectorsClient = new S3VectorsClient({ region: REGION });

/**
 * In-memory LRU cache for query embeddings.
 *
 * Why: chat queries repeat heavily (chip submissions, common themes,
 * follow-up refinements all share text). Each Titan invoke is ~150-300ms,
 * so caching cuts repeat-query latency to near-zero.
 *
 * Why an LRU and not unbounded: the runtime container survives many
 * requests; without bounds, memory grows. 1024 floats * 4 bytes = 4 KB
 * per entry, so 500 entries = 2 MB - small enough that we don't need
 * to be precious about size, but we do need a cap.
 *
 * Why no TTL: embeddings are deterministic for a given (text, model).
 * They don't go stale unless the model version changes, in which case
 * we'd redeploy and the in-memory cache resets anyway.
 */
const EMBED_CACHE_MAX = 500;
const embedCache = new Map<string, number[]>();
let embedCacheHits = 0;
let embedCacheMisses = 0;

function cacheKey(text: string): string {
  // Normalize whitespace + case so "Birthday Party" and "birthday  party"
  // share an entry. Keeps the cap from being eaten by trivial variations.
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Generate embeddings using Amazon Titan Text Embeddings V2.
 * Cached by normalized query text.
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const key = cacheKey(text);

  const cached = embedCache.get(key);
  if (cached) {
    // Move-to-end for LRU recency tracking
    embedCache.delete(key);
    embedCache.set(key, cached);
    embedCacheHits++;
    return cached;
  }

  const payload = {
    inputText: text,
    dimensions: 1024,
    normalize: true,
  };

  const command = new InvokeModelCommand({
    modelId: EMBEDDING_MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(payload),
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  const embedding: number[] = responseBody.embedding;

  // Insert into cache, evicting oldest entry if at capacity. Map preserves
  // insertion order, so the first key returned by keys() is the oldest.
  if (embedCache.size >= EMBED_CACHE_MAX) {
    const oldest = embedCache.keys().next().value;
    if (oldest !== undefined) embedCache.delete(oldest);
  }
  embedCache.set(key, embedding);
  embedCacheMisses++;

  // Periodic visibility into cache effectiveness; cheap to log every 50
  // misses (worst case: every 50 requests). Useful to confirm the cache
  // is paying off in production.
  if (embedCacheMisses % 50 === 0) {
    const total = embedCacheHits + embedCacheMisses;
    const hitRate = total > 0 ? ((embedCacheHits / total) * 100).toFixed(1) : "0";
    console.log(
      `[embed-cache] hits=${embedCacheHits} misses=${embedCacheMisses} hit-rate=${hitRate}% size=${embedCache.size}/${EMBED_CACHE_MAX}`
    );
  }

  return embedding;
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: Record<string, string>;
}

export interface CustomerProfile {
  userId: string;
  customerType?: string;
  customerSegment?: string;
  businessUnit?: string;
  preferredCategoryL1?: string;
  preferredCategoryL2?: string;
  preferredOccasion?: string;
  preferredTheme?: string;
  priceAffinity?: string;
  discountAffinity?: string;
  region?: string;
  state?: string;
  accountAgeDays?: number;
  lifetimeOrderCount?: number;
  lifetimeSpend?: number;
  avgOrderValue?: number;
  daysSinceLastOrder?: number;
  emailOptIn?: boolean;
}

/**
 * Search products in the S3 Vectors index
 */
export async function searchProducts(
  query: string,
  topK: number = 5
): Promise<SearchResult[]> {
  const queryEmbedding = await generateEmbedding(query);

  const command = new QueryVectorsCommand({
    vectorBucketName: VECTOR_BUCKET_NAME,
    indexName: "products-index",
    queryVector: { float32: queryEmbedding },
    topK,
    returnMetadata: true,
  });

  const response = await s3VectorsClient.send(command);

  return (
    response.vectors?.map((v) => ({
      id: v.key || "",
      score: v.distance || 0,
      metadata: (v.metadata as Record<string, string>) || {},
    })) || []
  );
}

/**
 * Search orders in the S3 Vectors index
 */
export async function searchOrders(
  query: string,
  topK: number = 5
): Promise<SearchResult[]> {
  const queryEmbedding = await generateEmbedding(query);

  const command = new QueryVectorsCommand({
    vectorBucketName: VECTOR_BUCKET_NAME,
    indexName: "orders-index",
    queryVector: { float32: queryEmbedding },
    topK,
    returnMetadata: true,
  });

  const response = await s3VectorsClient.send(command);

  return (
    response.vectors?.map((v) => ({
      id: v.key || "",
      score: v.distance || 0,
      metadata: (v.metadata as Record<string, string>) || {},
    })) || []
  );
}

/**
 * Search customer profiles by semantic query
 */
export async function searchCustomers(
  query: string,
  topK: number = 5
): Promise<SearchResult[]> {
  try {
    const queryEmbedding = await generateEmbedding(query);

    const command = new QueryVectorsCommand({
      vectorBucketName: VECTOR_BUCKET_NAME,
      indexName: "customers-index",
      queryVector: { float32: queryEmbedding },
      topK,
      returnMetadata: true,
    });

    const response = await s3VectorsClient.send(command);

    return (
      response.vectors?.map((v) => ({
        id: v.key || "",
        score: v.distance || 0,
        metadata: (v.metadata as Record<string, string>) || {},
      })) || []
    );
  } catch (error) {
    console.warn("Customer search unavailable:", error);
    return [];
  }
}

/**
 * Search the interactions index by semantic query.
 *
 * The interactions index holds one vector per (user, item, timestamp) event,
 * with embedding text like "User X performed view on item Y at timestamp Z".
 * Useful for queries like "what has user 4503... been browsing", "items
 * recently purchased", or "view events for item 14245142".
 *
 * Returns empty if the index isn't available (graceful degradation -
 * customers who haven't run --batch-async or imported interactions still
 * see the agent work for product/order/memory queries).
 */
export async function searchInteractions(
  query: string,
  topK: number = 10
): Promise<SearchResult[]> {
  try {
    const queryEmbedding = await generateEmbedding(query);

    const command = new QueryVectorsCommand({
      vectorBucketName: VECTOR_BUCKET_NAME,
      indexName: "interactions-index",
      queryVector: { float32: queryEmbedding },
      topK,
      returnMetadata: true,
    });

    const response = await s3VectorsClient.send(command);

    return (
      response.vectors?.map((v) => ({
        id: v.key || "",
        score: v.distance || 0,
        metadata: (v.metadata as Record<string, string>) || {},
      })) || []
    );
  } catch (error) {
    console.warn("Interaction search unavailable:", error);
    return [];
  }
}

/**
 * Get the most recent N interactions for a specific user.
 *
 * S3 Vectors has no server-side metadata filter, so we over-fetch via
 * semantic search (the embedded text always begins with "User <id>" so
 * a query for that user ranks their events very high) and then post-
 * filter by exact userId match, sorted by timestamp descending.
 *
 * Used to inject behavioral context into the system prompt when a
 * specific customer is selected in the UI.
 */
export async function getRecentInteractionsByUser(
  userId: string,
  limit: number = 10
): Promise<SearchResult[]> {
  if (!userId) return [];
  // Over-fetch by 10x to give the post-filter enough candidates. Even at
  // 25K interactions across 5K users, the embedding for "User CUST-XYZ"
  // tends to surface that user's events in the top ~50-200 results.
  const candidates = await searchInteractions(`User ${userId}`, Math.max(limit * 10, 100));
  const filtered = candidates.filter((r) => r.metadata.userId === userId);
  filtered.sort((a, b) => {
    const ta = parseInt(a.metadata.timestamp || "0", 10);
    const tb = parseInt(b.metadata.timestamp || "0", 10);
    return tb - ta;
  });
  return filtered.slice(0, limit);
}

/**
 * Format an array of interaction events for inclusion in the system prompt.
 * Each line is one event, human-readable, ordered most-recent first.
 */
export function formatInteractionHistory(events: SearchResult[]): string {
  if (events.length === 0) return "(no recent interactions on file)";
  return events
    .map((e) => {
      const m = e.metadata;
      const ts = m.timestamp ? new Date(parseInt(m.timestamp, 10) * 1000).toISOString().slice(0, 10) : "?";
      const action = m.eventType || "event";
      const item = m.itemId || "?";
      const price = m.price ? ` ($${m.price})` : "";
      const qty = m.quantity && m.quantity !== "0" ? ` qty ${m.quantity}` : "";
      const src = m.recommendationId ? ` via ${m.recommendationId}` : "";
      return `- ${ts}: ${action} ${item}${qty}${price}${src}`;
    })
    .join("\n");
}

/**
 * Get a specific customer profile by user ID (exact match lookup)
 * Returns null if not found or if customer index is not available
 */
export async function getCustomerProfile(
  userId: string
): Promise<CustomerProfile | null> {
  try {
    const command = new GetVectorsCommand({
      vectorBucketName: VECTOR_BUCKET_NAME,
      indexName: "customers-index",
      keys: [userId],
      returnMetadata: true,
    });

    const response = await s3VectorsClient.send(command);
    const vector = response.vectors?.[0];

    if (!vector || !vector.metadata) {
      return null;
    }

    const metadata = vector.metadata as Record<string, string>;

    return {
      userId: metadata.userId || userId,
      customerType: metadata.customerType,
      customerSegment: metadata.customerSegment,
      businessUnit: metadata.businessUnit,
      preferredCategoryL1: metadata.preferredCategoryL1,
      preferredCategoryL2: metadata.preferredCategoryL2,
      preferredOccasion: metadata.preferredOccasion,
      preferredTheme: metadata.preferredTheme,
      priceAffinity: metadata.priceAffinity,
      discountAffinity: metadata.discountAffinity,
      region: metadata.region,
      state: metadata.state,
      accountAgeDays: metadata.accountAgeDays ? parseInt(metadata.accountAgeDays) : undefined,
      lifetimeOrderCount: metadata.lifetimeOrderCount ? parseInt(metadata.lifetimeOrderCount) : undefined,
      lifetimeSpend: metadata.lifetimeSpend ? parseFloat(metadata.lifetimeSpend) : undefined,
      avgOrderValue: metadata.avgOrderValue ? parseFloat(metadata.avgOrderValue) : undefined,
      daysSinceLastOrder: metadata.daysSinceLastOrder ? parseInt(metadata.daysSinceLastOrder) : undefined,
      emailOptIn: metadata.emailOptIn === "true",
    };
  } catch (error) {
    console.warn(`Customer profile lookup failed for ${userId}:`, error);
    return null;
  }
}

/**
 * Format customer profile for display/context injection
 */
export function formatCustomerProfile(profile: CustomerProfile): string {
  const parts: string[] = [];

  parts.push(`Customer ID: ${profile.userId}`);

  if (profile.customerType) parts.push(`Type: ${profile.customerType}`);
  if (profile.customerSegment) parts.push(`Segment: ${profile.customerSegment}`);

  if (profile.preferredCategoryL1 || profile.preferredTheme || profile.preferredOccasion) {
    const prefs: string[] = [];
    if (profile.preferredCategoryL1) prefs.push(`Category: ${profile.preferredCategoryL1}`);
    if (profile.preferredTheme) prefs.push(`Theme: ${profile.preferredTheme}`);
    if (profile.preferredOccasion) prefs.push(`Occasion: ${profile.preferredOccasion}`);
    parts.push(`Preferences: ${prefs.join(", ")}`);
  }

  if (profile.priceAffinity) parts.push(`Price Affinity: ${profile.priceAffinity}`);

  if (profile.region && profile.state) {
    parts.push(`Location: ${profile.region}, ${profile.state}`);
  }

  if (profile.lifetimeOrderCount !== undefined) {
    parts.push(`Lifetime Orders: ${profile.lifetimeOrderCount}`);
  }
  if (profile.lifetimeSpend !== undefined) {
    parts.push(`Lifetime Spend: $${profile.lifetimeSpend.toFixed(2)}`);
  }
  if (profile.avgOrderValue !== undefined) {
    parts.push(`Avg Order Value: $${profile.avgOrderValue.toFixed(2)}`);
  }
  if (profile.daysSinceLastOrder !== undefined) {
    parts.push(`Days Since Last Order: ${profile.daysSinceLastOrder}`);
  }

  return parts.join("\n");
}

/**
 * Combined RAG search across products and orders
 */
export async function ragSearch(
  query: string,
  topK: number = 5
): Promise<{ products: SearchResult[]; orders: SearchResult[] }> {
  const [products, orders] = await Promise.all([
    searchProducts(query, topK),
    searchOrders(query, topK),
  ]);

  return { products, orders };
}
