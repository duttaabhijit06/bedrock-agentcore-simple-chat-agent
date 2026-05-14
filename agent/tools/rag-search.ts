/**
 * RAG Search Tool - Queries S3 Vectors for party supply product and order data
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
