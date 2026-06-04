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
 * Generate embeddings using Amazon Titan Text Embeddings V2
 */
async function generateEmbedding(text: string): Promise<number[]> {
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
  return responseBody.embedding;
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
