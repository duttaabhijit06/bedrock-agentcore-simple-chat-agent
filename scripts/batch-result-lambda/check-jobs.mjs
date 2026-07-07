/**
 * Lambda: Check Bedrock Batch Job Status
 *
 * Called by Step Functions to poll batch job completion.
 *
 * Input:
 *   { jobs: [{ name, arn, outputPrefix }] }
 *
 * Output:
 *   { allComplete: boolean, anyFailed: boolean, status: { jobName: status } }
 */

import {
  BedrockClient,
  GetModelInvocationJobCommand,
} from "@aws-sdk/client-bedrock";

const REGION = process.env.AWS_REGION;
// Adaptive retry so GetModelInvocationJob polling doesn't fail on
// Bedrock throttling during high-load imports.
const bedrockClient = new BedrockClient({
  region: REGION,
  maxAttempts: 10,
  retryMode: "adaptive",
});

export const handler = async (event) => {
  const { jobs } = event;

  console.log(`Checking status of ${jobs.length} batch jobs`);

  const status = {};
  let allComplete = true;
  let anyFailed = false;

  for (const job of jobs) {
    try {
      const response = await bedrockClient.send(
        new GetModelInvocationJobCommand({ jobIdentifier: job.arn })
      );

      status[job.name] = response.status;

      if (response.status === "Failed" || response.status === "Stopped") {
        anyFailed = true;
        console.log(`  ${job.name}: ${response.status} - FAILED`);
      } else if (response.status !== "Completed") {
        allComplete = false;
        console.log(`  ${job.name}: ${response.status}`);
      } else {
        console.log(`  ${job.name}: Completed`);
      }
    } catch (error) {
      console.error(`  Error checking ${job.name}: ${error.message}`);
      allComplete = false;
      status[job.name] = "Error";
    }
  }

  console.log(`Result: allComplete=${allComplete}, anyFailed=${anyFailed}`);

  return {
    allComplete,
    anyFailed,
    status,
  };
};
