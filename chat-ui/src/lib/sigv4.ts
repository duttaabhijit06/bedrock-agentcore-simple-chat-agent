/**
 * SigV4 Request Signing for AgentCore Gateway
 *
 * Signs HTTP requests with AWS Signature Version 4 for IAM-based
 * inbound authorization to the AgentCore Gateway.
 */

import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";

const REGION = import.meta.env.VITE_AWS_REGION || "us-west-2";

/**
 * Create a SigV4 signed request to the AgentCore Gateway.
 * Uses credentials from environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN).
 */
export async function signRequest(
  url: string,
  method: string,
  body: string,
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  }
): Promise<Record<string, string>> {
  const parsedUrl = new URL(url);

  const request = new HttpRequest({
    method,
    protocol: parsedUrl.protocol,
    hostname: parsedUrl.hostname,
    port: parsedUrl.port ? Number(parsedUrl.port) : undefined,
    path: parsedUrl.pathname,
    headers: {
      host: parsedUrl.hostname,
      "content-type": "application/json",
    },
    body,
  });

  const signer = new SignatureV4({
    service: "bedrock-agentcore",
    region: REGION,
    credentials,
    sha256: Sha256,
  });

  const signedRequest = await signer.sign(request);
  return signedRequest.headers as Record<string, string>;
}

/**
 * Get AWS credentials from environment or local configuration.
 * In a production app, you'd use Cognito or another identity provider.
 */
export function getCredentials(): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
} | null {
  const accessKeyId = localStorage.getItem("aws_access_key_id");
  const secretAccessKey = localStorage.getItem("aws_secret_access_key");
  const sessionToken = localStorage.getItem("aws_session_token");

  if (!accessKeyId || !secretAccessKey) {
    return null;
  }

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: sessionToken || undefined,
  };
}

/**
 * Store AWS credentials in localStorage (for demo purposes).
 * In production, use a proper identity provider like Cognito.
 */
export function setCredentials(
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken?: string
): void {
  localStorage.setItem("aws_access_key_id", accessKeyId);
  localStorage.setItem("aws_secret_access_key", secretAccessKey);
  if (sessionToken) {
    localStorage.setItem("aws_session_token", sessionToken);
  }
}

export function clearCredentials(): void {
  localStorage.removeItem("aws_access_key_id");
  localStorage.removeItem("aws_secret_access_key");
  localStorage.removeItem("aws_session_token");
}
