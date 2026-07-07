/**
 * Lambda: Flush S3 Vectors Index (for replace mode)
 *
 * Deletes and recreates the index before uploading new vectors.
 *
 * Input:
 *   { dataType: "products" | "customers" | "interactions" }
 *
 * Output:
 *   { success: boolean, indexName: string }
 */

import {
  S3VectorsClient,
  DeleteIndexCommand,
  CreateIndexCommand,
} from "@aws-sdk/client-s3vectors";

const REGION = process.env.AWS_REGION;
const VECTOR_BUCKET = process.env.VECTOR_BUCKET || "party-supply-vectors";

// Adaptive retry so a transient ThrottlingException on DeleteIndex or
// CreateIndex doesn't fail the Step Functions run - the flush is
// idempotent, so retries are safe.
const s3VectorsClient = new S3VectorsClient({
  region: REGION,
  maxAttempts: 10,
  retryMode: "adaptive",
});

export const handler = async (event) => {
  const { dataType } = event;
  const indexName = `${dataType}-index`;

  console.log(`Flushing index: ${indexName} in bucket: ${VECTOR_BUCKET}`);

  try {
    // Delete existing index
    console.log("  Deleting existing index...");
    await s3VectorsClient.send(
      new DeleteIndexCommand({
        vectorBucketName: VECTOR_BUCKET,
        indexName: indexName,
      })
    );
    console.log("  Index deleted");
  } catch (error) {
    if (error.name === "ResourceNotFoundException" || error.message?.includes("not found")) {
      console.log("  Index doesn't exist, creating new");
    } else {
      console.error(`  Error deleting index: ${error.message}`);
      throw error;
    }
  }

  // Wait for deletion to propagate
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Create new index. All four indexes share the same non-filterable
  // metadata config so schema changes don't require per-index code
  // updates - if a future migration adds a `description` field to any
  // index, it lands in the 40KB non-filterable bucket automatically
  // instead of tripping the 2KB filterable cap.
  console.log("  Creating new index...");
  await s3VectorsClient.send(
    new CreateIndexCommand({
      vectorBucketName: VECTOR_BUCKET,
      indexName: indexName,
      dimension: 1024,
      distanceMetric: "cosine",
      dataType: "float32",
      metadataConfiguration: {
        nonFilterableMetadataKeys: ["name", "description", "link", "image"],
      },
    })
  );
  console.log("  Index created successfully");

  return {
    success: true,
    indexName: indexName,
  };
};
