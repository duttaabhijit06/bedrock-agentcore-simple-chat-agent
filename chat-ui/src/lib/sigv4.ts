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
 *
 * `expiresAt` is an ISO8601 string (e.g. "2026-06-25T03:30:00Z") emitted
 * by `aws configure export-credentials`. When supplied we use it for
 * `areCredentialsExpired()`. When omitted (long-lived IAM user keys, or
 * the user just didn't paste it) we fall back to a 1-hour TTL from the
 * setAt timestamp - the STS default for temporary credentials.
 */
export function setCredentials(
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken?: string,
  expiresAt?: string
): void {
  localStorage.setItem("aws_access_key_id", accessKeyId);
  localStorage.setItem("aws_secret_access_key", secretAccessKey);
  if (sessionToken) {
    localStorage.setItem("aws_session_token", sessionToken);
  } else {
    localStorage.removeItem("aws_session_token");
  }
  localStorage.setItem("aws_credentials_set_at", String(Date.now()));
  if (expiresAt) {
    localStorage.setItem("aws_credentials_expires_at", expiresAt);
  } else {
    localStorage.removeItem("aws_credentials_expires_at");
  }
}

export function clearCredentials(): void {
  localStorage.removeItem("aws_access_key_id");
  localStorage.removeItem("aws_secret_access_key");
  localStorage.removeItem("aws_session_token");
  localStorage.removeItem("aws_credentials_set_at");
  localStorage.removeItem("aws_credentials_expires_at");
}

/**
 * Best-effort expiry check. Returns true only when we can prove the
 * stored credentials are no longer valid:
 *   - If an explicit `expiresAt` was stored, compare against it.
 *   - Else if a session token is present (= STS temporary creds), assume
 *     a 1h TTL from setAt. This is the STS default; if the user has
 *     a longer-lived role they should paste the Expiration field too.
 *   - Long-lived IAM user keys (no session token, no expiresAt) → never
 *     expire on the client side; the server will reject them if revoked.
 */
export function areCredentialsExpired(): boolean {
  const creds = getCredentials();
  if (!creds) return true;

  const expiresAt = localStorage.getItem("aws_credentials_expires_at");
  if (expiresAt) {
    const expiryMs = Date.parse(expiresAt);
    if (!isNaN(expiryMs)) return Date.now() >= expiryMs;
  }

  if (creds.sessionToken) {
    const setAt = Number(localStorage.getItem("aws_credentials_set_at") || 0);
    if (setAt > 0) {
      const ONE_HOUR_MS = 60 * 60 * 1000;
      return Date.now() - setAt >= ONE_HOUR_MS;
    }
  }

  return false;
}

/**
 * Heuristic for "this error came from expired/invalid credentials" so the
 * UI can route the user back to the credentials screen instead of surfacing
 * a wall of SigV4 noise. Matches the strings AWS returns for SigV4 auth
 * failures and STS token expiry.
 */
export function isAuthError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("expiredtoken") ||
    msg.includes("token has expired") ||
    msg.includes("signature") ||
    msg.includes("403") ||
    msg.includes("invalidsignature") ||
    msg.includes("notauthorized") ||
    msg.includes("unauthorized") ||
    msg.includes("invalid security token")
  );
}
