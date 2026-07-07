/**
 * Lambda: Poll for completed batch jobs and trigger Glue upload
 *
 * Runs every minute via EventBridge Scheduler.
 * Checks S3 for manifests, polls job status, triggers Glue when all complete.
 *
 * Flow:
 * 1. List manifests in batch-jobs/
 * 2. Check status of all jobs in each manifest
 * 3. When all jobs complete → trigger Glue upload job
 */

import {
  BedrockClient,
  GetModelInvocationJobCommand,
} from "@aws-sdk/client-bedrock";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  GlueClient,
  StartJobRunCommand,
} from "@aws-sdk/client-glue";
import {
  S3VectorsClient,
  DeleteIndexCommand,
  CreateIndexCommand,
} from "@aws-sdk/client-s3vectors";

const REGION = process.env.AWS_REGION;
const VECTOR_BUCKET = process.env.VECTOR_BUCKET || "party-supply-vectors";
const BATCH_BUCKET = process.env.BATCH_BUCKET;

// Adaptive retry so ThrottlingException from Bedrock / S3 Vectors /
// Glue during high-load imports doesn't fail the poll step. The SDK's
// exponential backoff waits out most transient throttles automatically.
const RETRY_CONFIG = { maxAttempts: 10, retryMode: "adaptive" };
const bedrockClient = new BedrockClient({ region: REGION, ...RETRY_CONFIG });
const s3Client = new S3Client({ region: REGION, ...RETRY_CONFIG });
const glueClient = new GlueClient({ region: REGION, ...RETRY_CONFIG });
const s3VectorsClient = new S3VectorsClient({ region: REGION, ...RETRY_CONFIG });

export const handler = async (event) => {
  console.log("Polling for completed batch jobs...");

  // Get bucket name from environment or derive from account
  let bucket = BATCH_BUCKET;
  if (!bucket) {
    const accountId = await getAccountId();
    bucket = `party-supply-batch-${accountId}-${REGION}`;
  }

  console.log(`Checking bucket: ${bucket}`);

  // List all manifests
  const listResponse = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "batch-jobs/party-supply-",
    })
  );

  const manifestKeys = (listResponse.Contents || [])
    .map((obj) => obj.Key)
    .filter((key) => key.endsWith(".json"));

  console.log(`Found ${manifestKeys.length} manifests`);

  let triggered = 0;

  for (const manifestKey of manifestKeys) {
    try {
      // Get manifest
      const manifestResponse = await s3Client.send(
        new GetObjectCommand({ Bucket: bucket, Key: manifestKey })
      );
      const manifestContent = await manifestResponse.Body.transformToString();
      const manifest = JSON.parse(manifestContent);

      console.log(`Checking manifest: ${manifest.name}`);

      // Skip if already processing
      if (manifest.processing) {
        console.log(`  Already being processed, skipping`);
        continue;
      }

      // Check all job statuses
      const jobs = manifest.jobs || [];
      let allComplete = true;
      let anyFailed = false;

      for (const job of jobs) {
        try {
          const response = await bedrockClient.send(
            new GetModelInvocationJobCommand({ jobIdentifier: job.arn })
          );

          if (response.status === "Failed" || response.status === "Stopped") {
            anyFailed = true;
            console.log(`  Job ${job.name}: ${response.status}`);
          } else if (response.status !== "Completed") {
            allComplete = false;
            console.log(`  Job ${job.name}: ${response.status}`);
          } else {
            console.log(`  Job ${job.name}: Completed`);
          }
        } catch (error) {
          console.error(`  Failed to get status for ${job.name}: ${error.message}`);
          allComplete = false;
        }
      }

      if (!allComplete) {
        console.log(`  Jobs still in progress`);
        continue;
      }

      if (anyFailed) {
        console.log(`  Some jobs failed, marking manifest as failed`);
        manifest.status = "failed";
        manifest.failedAt = new Date().toISOString();
        await s3Client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: manifestKey,
            Body: JSON.stringify(manifest, null, 2),
            ContentType: "application/json",
          })
        );
        continue;
      }

      // Check for race condition: is there a newer import of same data type?
      const isLatest = await checkIfLatestManifest(bucket, manifest.dataType, manifest.name);
      if (!isLatest) {
        console.log(`  SKIPPING: Newer ${manifest.dataType} import exists. Cleaning up.`);
        await s3Client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: manifestKey })
        );
        continue;
      }

      // All jobs complete! Mark as processing
      console.log(`  All jobs complete! Processing...`);

      manifest.processing = true;
      manifest.processingStartedAt = new Date().toISOString();
      await s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: manifestKey,
          Body: JSON.stringify(manifest, null, 2),
          ContentType: "application/json",
        })
      );

      // Handle replace mode: flush index ONCE before any uploads
      const uploadMode = manifest.uploadMode || "upsert";
      if (uploadMode === "replace") {
        // Re-check if still latest right before destructive operation
        const stillLatest = await checkIfLatestManifest(bucket, manifest.dataType, manifest.name);
        if (!stillLatest) {
          console.log(`  SKIPPING FLUSH: Newer ${manifest.dataType} import appeared. Aborting.`);
          await s3Client.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: manifestKey })
          );
          continue;
        }

        console.log(`  Flushing index for replace mode...`);
        await flushIndex(manifest.dataType);
      }

      // Trigger Glue upload job for each chunk (always upsert - flush already done)
      for (const job of jobs) {
        const glueArgs = {
          "--data_type": manifest.dataType,
          "--batch_output_path": `s3://${bucket}/${job.outputPrefix}/`,
          "--raw_data_path": manifest.preparedPath ? `${manifest.preparedPath}raw/` : `s3://${bucket}/seed-data/`,
          "--vector_bucket": VECTOR_BUCKET,
          "--region": REGION,
          "--upload_mode": "upsert",  // Always upsert - flush handled above
        };

        console.log(`  Starting Glue job for ${job.name}`);
        await glueClient.send(
          new StartJobRunCommand({
            JobName: "PartySupplyUploadVectors",
            Arguments: glueArgs,
          })
        );
      }

      // Clean up manifest after triggering Glue
      await s3Client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: manifestKey })
      );

      triggered++;
      console.log(`  Triggered Glue processing for ${manifest.name}`);

    } catch (error) {
      console.error(`Error processing manifest ${manifestKey}: ${error.message}`);
    }
  }

  return {
    manifestsChecked: manifestKeys.length,
    glueJobsTriggered: triggered,
  };
};

async function getAccountId() {
  const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const sts = new STSClient({ region: REGION });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  return identity.Account;
}

async function checkIfLatestManifest(bucket, dataType, currentName) {
  try {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `batch-jobs/party-supply-${dataType}-`,
      })
    );

    const manifests = (response.Contents || [])
      .map((obj) => obj.Key)
      .filter((key) => key.endsWith(".json"));

    // Extract timestamp from current manifest name
    const currentMatch = currentName.match(/(\d{14})/);
    if (!currentMatch) return true;
    const currentTimestamp = currentMatch[1];

    for (const key of manifests) {
      if (key.includes(currentName)) continue;

      // Extract timestamp from other manifest
      const match = key.match(/(\d{14})/);
      if (match && match[1] > currentTimestamp) {
        console.log(`  Found newer manifest: ${key}`);
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error(`Error checking manifests: ${error.message}`);
    return true;
  }
}

async function flushIndex(dataType) {
  const indexName = `${dataType}-index`;
  console.log(`  Flushing index: ${indexName}`);

  try {
    // Delete existing index
    await s3VectorsClient.send(
      new DeleteIndexCommand({
        vectorBucketName: VECTOR_BUCKET,
        indexName: indexName,
      })
    );
    console.log(`    Deleted existing index`);
  } catch (error) {
    if (error.name === "ResourceNotFoundException" || error.message?.includes("not found")) {
      console.log(`    Index doesn't exist, creating new`);
    } else {
      throw error;
    }
  }

  // Wait for deletion to propagate
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Create new index. All four indexes share the same non-filterable
  // metadata config so schema evolution is free — if a future migration
  // adds long-text fields to any index, they land in the 40KB
  // non-filterable bucket instead of tripping the 2KB filterable cap.
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
  console.log(`    Created new index: ${indexName}`);
}
