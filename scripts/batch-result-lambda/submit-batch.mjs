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
  ListModelInvocationJobsCommand,
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
// Cap concurrent Bedrock Batch jobs in-flight from this pipeline. AWS's
// per-account/region quota is 20 by default; leaving 5 headroom for
// other workloads is a safe default. Override with MAX_CONCURRENT_JOBS
// env var if the account has a raised quota or you know nothing else
// is using it.
const MAX_CONCURRENT_JOBS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_JOBS || "15", 10)
);
// How often to poll for freed slots when we're at the cap.
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000", 10);

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
 * Wrapper around `bedrockClient.send()` that retries on both
 * ThrottlingException (rate-limit) and ServiceQuotaExceededException
 * (concurrent-jobs cap). Two distinct error classes, both transient
 * from our perspective, both worth waiting for:
 *
 *   - ThrottlingException: API rate limit hit. Clears in seconds.
 *     Handled with 1s -> 30s exponential backoff.
 *
 *   - ServiceQuotaExceededException: "reached the quota for number of
 *     concurrent invoke-model jobs in progress." AWS's default cap is
 *     20 concurrent batch jobs per account per region. This clears
 *     only when other batch jobs FINISH - typically 5-20 minutes.
 *     We wait 60s -> 5min so we don't burn the Lambda's 15-min timeout
 *     on tight retries that can't possibly succeed.
 *
 * Lambda max execution time is 15 minutes. We cap total wait time at
 * ~13 minutes so we return control before the Lambda timeout, which
 * would surface as an ambiguous "task timed out" instead of a clear
 * "quota still exceeded" error the operator can act on.
 */
/**
 * Count active (Submitted / InProgress / Scheduled / Validating / Stopping)
 * Bedrock Batch jobs in the account+region. These states count against
 * the concurrent-invoke-model-jobs quota.
 *
 * Returns a best-effort count; if the ListModelInvocationJobs call
 * fails we return the max so the caller waits (safer than proceeding
 * blindly and getting ServiceQuotaExceededException).
 */
const ACTIVE_STATES = ["Submitted", "InProgress", "Scheduled", "Validating", "Stopping"];

async function countActiveJobs() {
  try {
    let active = 0;
    let nextToken;
    do {
      const out = await bedrockClient.send(
        new ListModelInvocationJobsCommand({
          maxResults: 100,
          ...(nextToken ? { nextToken } : {}),
        })
      );
      const items = out.invocationJobSummaries || [];
      active += items.filter((j) => ACTIVE_STATES.includes(j.status)).length;
      nextToken = out.nextToken;
    } while (nextToken);
    return active;
  } catch (err) {
    console.warn(
      `  countActiveJobs failed (${err?.name || "unknown"}): ${err?.message}. ` +
        `Assuming quota is full so we back off.`
    );
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Wait until the number of active Bedrock Batch jobs is below the
 * configured cap so we can submit another one without tripping the
 * ServiceQuotaExceededException.
 *
 * `deadlineMs` is epoch-ms; if we hit it while still waiting, we
 * return `false` so the caller can bail out and let Step Functions
 * re-invoke the Lambda with the remaining chunks.
 */
async function waitForSlot(deadlineMs) {
  while (Date.now() < deadlineMs) {
    const active = await countActiveJobs();
    if (active < MAX_CONCURRENT_JOBS) {
      console.log(
        `  Slot available: ${active}/${MAX_CONCURRENT_JOBS} active`
      );
      return true;
    }
    const remainingMs = deadlineMs - Date.now();
    console.log(
      `  At cap (${active} active >= ${MAX_CONCURRENT_JOBS}). ` +
        `Sleeping ${(POLL_INTERVAL_MS / 1000).toFixed(0)}s ` +
        `(deadline in ${(remainingMs / 1000).toFixed(0)}s)`
    );
    if (remainingMs <= POLL_INTERVAL_MS) return false;
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

async function submitJobWithRetry(command) {
  const MAX_WAIT_MS = 13 * 60 * 1000; // ~13 min budget
  let totalWaitedMs = 0;
  let attempt = 0;
  let throttleDelayMs = 1000;
  let quotaDelayMs = 60_000;
  while (true) {
    try {
      return await bedrockClient.send(command);
    } catch (err) {
      const name = err?.name || "";
      const isThrottle =
        name === "ThrottlingException" ||
        name === "TooManyRequestsException" ||
        err?.$metadata?.httpStatusCode === 429;
      const isQuota = name === "ServiceQuotaExceededException";
      const retriable = isThrottle || isQuota;
      attempt += 1;
      if (!retriable || totalWaitedMs >= MAX_WAIT_MS) throw err;

      const jitter = Math.floor(Math.random() * 500);
      let wait;
      if (isQuota) {
        // Concurrent-jobs cap: wait for other jobs to finish (long).
        wait = quotaDelayMs + jitter;
        console.warn(
          `  Bedrock concurrent-jobs quota hit (attempt ${attempt}, total wait ${(totalWaitedMs/1000).toFixed(0)}s). ` +
            `Sleeping ${(wait/1000).toFixed(0)}s before retry: ${err.message}`
        );
        quotaDelayMs = Math.min(quotaDelayMs * 1.5, 300_000); // cap 5 min
      } else {
        // Rate-limit: short backoff.
        wait = throttleDelayMs + jitter;
        console.warn(
          `  Throttled by Bedrock (attempt ${attempt}, total wait ${(totalWaitedMs/1000).toFixed(0)}s). ` +
            `Sleeping ${wait}ms before retry: ${err.message}`
        );
        throttleDelayMs = Math.min(throttleDelayMs * 2, 30_000);
      }
      await sleep(wait);
      totalWaitedMs += wait;
    }
  }
}

export const handler = async (event, context) => {
  const {
    dataType,
    preparedPath,
    uploadMode = "upsert",
    // Optional continuation state from a prior invocation. When Step
    // Functions re-invokes us to finish submitting the remaining chunks
    // (because the Lambda ran out of time on the previous pass), these
    // fields tell us where to pick up. See `continuationPayload` below.
    baseJobName: prevBaseJobName,
    submittedChunkKeys = [],
    submittedJobs = [],
    chunkNumStart = 0,
  } = event;

  console.log(`Submitting batch jobs for ${dataType}`);
  console.log(`  Prepared path: ${preparedPath}`);
  console.log(`  Upload mode: ${uploadMode}`);
  console.log(`  Concurrency cap: ${MAX_CONCURRENT_JOBS}`);
  if (submittedChunkKeys.length > 0) {
    console.log(`  Resuming: ${submittedChunkKeys.length} chunks already submitted`);
  }

  // Reserve budget for the manifest write + response marshaling. The
  // Lambda gets its remaining time from context.getRemainingTimeInMillis().
  const RESERVE_MS = 30_000; // 30s for post-loop bookkeeping

  // Parse S3 path
  const pathMatch = preparedPath.match(/s3:\/\/([^/]+)\/(.+)/);
  if (!pathMatch) {
    throw new Error(`Invalid S3 path: ${preparedPath}`);
  }
  const [, bucket, prefix] = pathMatch;

  // List JSONL chunk files.
  //
  // Spark's .write.text() produces:
  //   - part-<NNNNN>-<uuid>.txt         <- real chunk (SUBMIT)
  //   - _SUCCESS                         <- write marker (SKIP)
  //   - .part-<NNNNN>-<uuid>.txt.crc     <- Hadoop checksum (SKIP)
  //   - _temporary/... (interrupted writes) <- staging (SKIP)
  //
  // The old filter `.endsWith(".txt") || .includes("part-")` accepted
  // .crc files (they contain "part-") and any leftover under _temporary/,
  // which over-counted chunk files dramatically at scale. Match strictly.
  const chunksPrefix = `${prefix.replace(/\/$/, "")}/chunks/`;
  const listResponse = await s3Client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: chunksPrefix,
    })
  );

  const CHUNK_RE = /(^|\/)part-\d{5}-[^/]+\.txt$/;
  const allObjects = listResponse.Contents || [];
  const chunkFiles = allObjects
    .filter((obj) => {
      if (!obj.Key) return false;
      if (obj.Key.includes("/_temporary/")) return false;
      const basename = obj.Key.split("/").pop() || "";
      if (basename.startsWith(".")) return false; // .crc, hidden files
      return CHUNK_RE.test(obj.Key);
    })
    .map((obj) => obj.Key);

  console.log(
    `  Found ${chunkFiles.length} chunk files (from ${allObjects.length} total S3 objects)`
  );

  if (chunkFiles.length === 0) {
    throw new Error(`No chunk files found at ${chunksPrefix}`);
  }

  // Generate job name with timestamp (reuse if this is a continuation).
  const timestamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const baseJobName = prevBaseJobName || `party-supply-${dataType}-${timestamp}`;

  // Filter out already-submitted chunks so a re-invocation only handles
  // the remainder. We match on the input chunk key rather than counting
  // so out-of-order retries stay correct.
  const alreadySubmitted = new Set(submittedChunkKeys);
  const remainingChunks = chunkFiles.filter((k) => !alreadySubmitted.has(k));

  console.log(
    `  Total chunks: ${chunkFiles.length}, already submitted: ` +
      `${submittedChunkKeys.length}, remaining: ${remainingChunks.length}`
  );

  const jobs = [...submittedJobs];
  const submittedThisRun = [];
  let chunkNum = chunkNumStart;

  for (const chunkKey of remainingChunks) {
    // Bail early if we're within RESERVE_MS of the Lambda timeout so
    // we have time to persist the manifest + return a continuation
    // payload. Step Functions will re-invoke us to pick up where we
    // left off.
    const remainingMs = context?.getRemainingTimeInMillis?.() ?? Infinity;
    if (remainingMs <= RESERVE_MS) {
      console.warn(
        `  Lambda deadline approaching (${(remainingMs / 1000).toFixed(0)}s left). ` +
          `Stopping submission at chunk ${chunkNum}. Step Functions will re-invoke ` +
          `with remaining ${remainingChunks.length - submittedThisRun.length} chunks.`
      );
      break;
    }

    // Wait for a concurrent-job slot to free up so we don't hit
    // ServiceQuotaExceededException. Deadline = now + (remainingMs - RESERVE_MS).
    const slotDeadline = Date.now() + remainingMs - RESERVE_MS;
    const gotSlot = await waitForSlot(slotDeadline);
    if (!gotSlot) {
      console.warn(
        `  Timed out waiting for a concurrent-job slot. ` +
          `Stopping at chunk ${chunkNum}. Step Functions will re-invoke.`
      );
      break;
    }

    chunkNum++;
    const jobName = `${baseJobName}-part${chunkNum}`;
    const inputKey = `batch-input/${jobName}.jsonl`;
    const outputPrefix = `batch-output/${jobName}`;

    // Copy the .txt file to .jsonl for Bedrock Batch (requires that ext).
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

      const jobRecord = {
        name: jobName,
        arn: response.jobArn,
        outputPrefix: outputPrefix,
        inputKey: chunkKey,
      };
      jobs.push(jobRecord);
      submittedThisRun.push(chunkKey);

      console.log(`    ARN: ${response.jobArn}`);
    } catch (error) {
      console.error(`    Failed to submit job: ${error.message}`);
      throw error;
    }

    // Space out submissions so we don't burst-hit the Bedrock quota.
    await sleep(SUBMIT_DELAY_MS);
  }

  const allSubmittedKeys = [...submittedChunkKeys, ...submittedThisRun];
  const isComplete = allSubmittedKeys.length >= chunkFiles.length;

  // Save (or overwrite) manifest with everything submitted so far.
  // We write on every invocation so the manifest is always current,
  // even if the Lambda is re-invoked several times to finish a large
  // batch. The final invocation's write is authoritative.
  const manifest = {
    name: baseJobName,
    dataType: dataType,
    bucket: bucket,
    uploadMode: uploadMode,
    preparedPath: preparedPath,
    submittedAt: new Date().toISOString(),
    totalChunks: chunkFiles.length,
    submittedChunks: allSubmittedKeys.length,
    complete: isComplete,
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

  console.log(
    `  Manifest saved: s3://${bucket}/${manifestKey} ` +
      `(${allSubmittedKeys.length}/${chunkFiles.length} chunks, ` +
      `complete=${isComplete})`
  );
  console.log(`  Submitted ${submittedThisRun.length} new jobs this invocation (${jobs.length} total)`);

  // Continuation payload. `complete: false` tells Step Functions to
  // re-invoke this Lambda (via a Choice state) with the same event
  // shape plus the fields below, so we pick up where we stopped.
  return {
    complete: isComplete,
    manifestName: baseJobName,
    manifestPath: `s3://${bucket}/${manifestKey}`,
    jobCount: jobs.length,
    totalChunks: chunkFiles.length,
    submittedChunks: allSubmittedKeys.length,
    jobs: jobs.map((j) => ({ name: j.name, arn: j.arn, outputPrefix: j.outputPrefix })),
    // Fields the state machine passes back on the next invocation:
    baseJobName,
    submittedChunkKeys: allSubmittedKeys,
    submittedJobs: jobs,
    chunkNumStart: chunkNum,
  };
};
