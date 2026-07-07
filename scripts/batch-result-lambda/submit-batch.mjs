/**
 * Lambda: Submit Bedrock Batch Inference Jobs
 *
 * Called after Glue ETL completes. Reads JSONL chunks from S3 and submits
 * batch inference jobs for each chunk.
 *
 * Input:
 *   {
 *     dataType: "products" | "customers" | "interactions",
 *     preparedPath: "s3://bucket/prepared/job-name/",
 *     uploadMode: "replace" | "upsert" | "append"
 *   }
 */

import {
  BedrockClient,
  CreateModelInvocationJobCommand,
} from "@aws-sdk/client-bedrock";
import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";

const REGION = process.env.AWS_REGION;
const BATCH_BUCKET = process.env.BATCH_BUCKET;
const BATCH_ROLE_ARN = process.env.BATCH_ROLE_ARN;
const MODEL_ID = process.env.MODEL_ID || "amazon.titan-embed-text-v2:0";

// Bedrock's CreateModelInvocationJob has a low concurrent-submission
// quota (~20/account/region). When products+customers+interactions run
// in parallel from Step Functions we can easily submit 10+ jobs in a
// few seconds and get ThrottlingException. Use the SDK's "adaptive"
// retry mode with a high attempt cap so throttled calls back off and
// retry rather than surfacing as a Lambda failure.
const bedrockClient = new BedrockClient({
  region: REGION,
  maxAttempts: 10,
  retryMode: "adaptive",
});
const s3Client = new S3Client({ region: REGION });

// Delay between successive CreateModelInvocationJob calls to keep us
// under the burst quota. 500ms means we submit at most ~2 jobs/sec,
// which stays well below Bedrock's throttle threshold even when three
// Step Functions imports run in parallel.
const SUBMIT_DELAY_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wrapper around `bedrockClient.send()` that retries on
 * ThrottlingException / TooManyRequests with exponential backoff.
 *
 * The SDK's built-in adaptive retry handles most cases, but for
 * multi-minute quota resets (Bedrock Batch enforces a
 * concurrent-jobs-per-account cap) we need to keep retrying longer
 * than the SDK's default retry window.
 */
async function submitJobWithRetry(command) {
  const MAX_TRIES = 8;
  let attempt = 0;
  let delayMs = 1000;
  while (true) {
    try {
      return await bedrockClient.send(command);
    } catch (err) {
      const throttled =
        err?.name === "ThrottlingException" ||
        err?.name === "TooManyRequestsException" ||
        err?.$metadata?.httpStatusCode === 429;
      attempt += 1;
      if (!throttled || attempt >= MAX_TRIES) throw err;
      const jitter = Math.floor(Math.random() * 500);
      const wait = delayMs + jitter;
      console.warn(
        `  Throttled by Bedrock (attempt ${attempt}/${MAX_TRIES}). ` +
          `Sleeping ${wait}ms before retry: ${err.message}`
      );
      await sleep(wait);
      delayMs = Math.min(delayMs * 2, 30_000); // cap at 30s
    }
  }
}

export const handler = async (event) => {
  const { dataType, preparedPath, uploadMode = "upsert" } = event;

  console.log(`Submitting batch jobs for ${dataType}`);
  console.log(`  Prepared path: ${preparedPath}`);
  console.log(`  Upload mode: ${uploadMode}`);

  // Parse S3 path
  const pathMatch = preparedPath.match(/s3:\/\/([^/]+)\/(.+)/);
  if (!pathMatch) {
    throw new Error(`Invalid S3 path: ${preparedPath}`);
  }
  const [, bucket, prefix] = pathMatch;

  // List JSONL chunk files
  const chunksPrefix = `${prefix.replace(/\/$/, "")}/chunks/`;
  const listResponse = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: chunksPrefix,
    })
  );

  const chunkFiles = (listResponse.Contents || [])
    .filter((obj) => obj.Key && (obj.Key.endsWith(".txt") || obj.Key.includes("part-")))
    .map((obj) => obj.Key);

  console.log(`  Found ${chunkFiles.length} chunk files`);

  if (chunkFiles.length === 0) {
    throw new Error(`No chunk files found at ${chunksPrefix}`);
  }

  // Generate job name with timestamp
  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const baseJobName = `party-supply-${dataType}-${timestamp}`;

  // Submit batch job for each chunk
  const jobs = [];
  let chunkNum = 0;

  for (const chunkKey of chunkFiles) {
    chunkNum++;
    const jobName = `${baseJobName}-part${chunkNum}`;

    // Copy chunk to batch-input with proper naming (.jsonl extension)
    // Bedrock Batch requires .jsonl extension
    const inputKey = `batch-input/${jobName}.jsonl`;
    const outputPrefix = `batch-output/${jobName}`;

    // Copy the .txt file to .jsonl for Bedrock Batch
    console.log(`  Copying chunk to ${inputKey}`);
    await s3Client.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${chunkKey}`,
        Key: inputKey,
      })
    );

    console.log(`  Submitting job: ${jobName}`);
    console.log(`    Input: s3://${bucket}/${inputKey}`);

    try {
      const response = await submitJobWithRetry(
        new CreateModelInvocationJobCommand({
          jobName: jobName,
          roleArn: BATCH_ROLE_ARN,
          modelId: MODEL_ID,
          inputDataConfig: {
            s3InputDataConfig: {
              s3Uri: `s3://${bucket}/${inputKey}`,
            },
          },
          outputDataConfig: {
            s3OutputDataConfig: {
              s3Uri: `s3://${bucket}/${outputPrefix}/`,
            },
          },
        })
      );

      jobs.push({
        name: jobName,
        arn: response.jobArn,
        outputPrefix: outputPrefix,
        inputKey: chunkKey,
      });

      console.log(`    ARN: ${response.jobArn}`);
    } catch (error) {
      console.error(`    Failed to submit job: ${error.message}`);
      throw error;
    }

    // Space out submissions so we don't burst-hit the Bedrock quota.
    // Skip the final delay since we've already submitted the last chunk.
    await sleep(SUBMIT_DELAY_MS);
  }

  // Save manifest for poll-jobs Lambda
  const manifest = {
    name: baseJobName,
    dataType: dataType,
    bucket: bucket,
    uploadMode: uploadMode,
    preparedPath: preparedPath,
    submittedAt: new Date().toISOString(),
    totalChunks: chunkFiles.length,
    jobs: jobs,
  };

  const manifestKey = `batch-jobs/${baseJobName}.json`;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: manifestKey,
      Body: JSON.stringify(manifest, null, 2),
      ContentType: "application/json",
    })
  );

  console.log(`  Manifest saved: s3://${bucket}/${manifestKey}`);
  console.log(`  Submitted ${jobs.length} batch jobs`);

  return {
    manifestName: baseJobName,
    manifestPath: `s3://${bucket}/${manifestKey}`,
    jobCount: jobs.length,
    jobs: jobs.map((j) => ({ name: j.name, arn: j.arn, outputPrefix: j.outputPrefix })),
  };
};
