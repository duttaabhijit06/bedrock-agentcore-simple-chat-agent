/**
 * Lambda: Submit Bedrock Batch Inference Jobs
 *
 * Called after Glue ETL completes. Reads JSONL chunks from S3 and submits
 * batch inference jobs for each chunk.
 *
 * Input:
 *   {
 *     dataType: "products" | "customers",
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

const bedrockClient = new BedrockClient({ region: REGION });
const s3Client = new S3Client({ region: REGION });

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
      const response = await bedrockClient.send(
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
