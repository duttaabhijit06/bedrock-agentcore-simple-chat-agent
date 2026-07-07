/**
 * SSM-backed Model Configuration
 *
 * Reads the active Bedrock model ID from AWS Systems Manager Parameter
 * Store so operators can hot-swap between Claude, Nova, or any other
 * Bedrock model **without redeploying the agent container**.
 *
 * Usage from AWS CLI:
 *
 *   # Switch to Nova Pro:
 *   aws ssm put-parameter --region us-west-2 \
 *     --name /partysupply/agent/model-id \
 *     --value us.amazon.nova-pro-v1:0 --overwrite
 *
 *   # Switch back to Claude Sonnet 4.5:
 *   aws ssm put-parameter --region us-west-2 \
 *     --name /partysupply/agent/model-id \
 *     --value us.anthropic.claude-sonnet-4-5-20250929-v1:0 --overwrite
 *
 * Cache behavior: the value is cached in-memory for 60s. That means:
 *   - New conversations pick up a model change within ~1 minute.
 *   - In-flight requests keep using whatever value they read at the top
 *     of the turn - no mid-turn model swaps (which would produce weird
 *     tool-call artifacts).
 *
 * Failure modes:
 *   - Parameter missing / SSM unreachable → fall back to the hardcoded
 *     default so the agent stays up. We log a warning; you'll see it in
 *     CloudWatch under the runtime log group.
 *   - IAM role missing ssm:GetParameter → same fallback; check the
 *     runtime role has the parameter ARN in its policy.
 */

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const REGION = process.env.AWS_REGION || "us-west-2";
const PARAM_NAME =
  process.env.BEDROCK_MODEL_ID_PARAM || "/partysupply/agent/model-id";
// Fallback model when SSM is unreachable or the param hasn't been
// created yet. Nova Pro is the current project default; operators can
// override at runtime via the SSM parameter above.
const DEFAULT_MODEL_ID = "us.amazon.nova-pro-v1:0";
const CACHE_TTL_MS = 60_000;

const ssm = new SSMClient({
  region: REGION,
  maxAttempts: 10,
  retryMode: "adaptive",
});
let cached: string | null = null;
let lastFetchMs = 0;

export async function getModelId(): Promise<string> {
  const now = Date.now();
  if (cached && now - lastFetchMs < CACHE_TTL_MS) {
    return cached;
  }
  try {
    const out = await ssm.send(
      new GetParameterCommand({ Name: PARAM_NAME })
    );
    const value = out.Parameter?.Value?.trim();
    if (!value) {
      throw new Error(`SSM parameter ${PARAM_NAME} returned empty value`);
    }
    if (value !== cached) {
      console.log(`[model-config] Model ID updated: ${cached ?? "(cold)"} → ${value}`);
    }
    cached = value;
    lastFetchMs = now;
    return cached;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // First-time failure with no cache → return the hardcoded default so
    // the agent still boots. Later failures keep the last-known-good so
    // we don't flap when SSM has a transient issue.
    if (!cached) {
      console.warn(
        `[model-config] SSM fetch failed for ${PARAM_NAME}: ${msg}. Falling back to default ${DEFAULT_MODEL_ID}.`
      );
      return DEFAULT_MODEL_ID;
    }
    console.warn(
      `[model-config] SSM fetch failed for ${PARAM_NAME}: ${msg}. Keeping cached value ${cached}.`
    );
    return cached;
  }
}
