#!/bin/bash
set -euo pipefail
export AWS_PAGER=""

# ─── Lambda MCP Client - Deployment Script ───────────────────────────────────
# Deploys this example Lambda to your AWS account.
#
# Prerequisites:
#   - AWS CLI v2, configured with credentials (`aws sts get-caller-identity`)
#   - `zip` or `7z` available on PATH (Git Bash: choco install 7zip)
#   - The Party Supply gateway already deployed (so we know the gateway URL)
#
# What it does (idempotent — re-run any time):
#   1. Creates IAM role `agentcore-lambda-example-role` with:
#        - AWSLambdaBasicExecutionRole (managed)
#        - InvokeAgentCoreGateway inline policy (bedrock-agentcore:InvokeAgent)
#   2. Packages index.mjs + node_modules into /tmp/agentcore-lambda-example.zip
#   3. Creates or updates Lambda `agentcore-lambda-example` on nodejs24.x
#   4. Prints sample `aws lambda invoke` commands for each MCP tool
#
# Usage:
#   ./deploy.sh                                  # uses defaults + auto-detects gateway URL
#   AWS_REGION=us-west-2 ./deploy.sh             # override region
#   AGENTCORE_GATEWAY_URL=https://... ./deploy.sh
#   LAMBDA_NAME=my-fn ./deploy.sh                # override function name

REGION="${AWS_REGION:-us-west-2}"
LAMBDA_NAME="${LAMBDA_NAME:-agentcore-lambda-example}"
ROLE_NAME="${ROLE_NAME:-agentcore-lambda-example-role}"
RUNTIME="nodejs24.x"
HANDLER="index.handler"
TIMEOUT="${TIMEOUT:-60}"
MEMORY="${MEMORY:-256}"
ZIP_PATH="/tmp/${LAMBDA_NAME}.zip"
TARGET_PREFIX="${MCP_TARGET_PREFIX:-PartySupplyTarget}"

cd "$(dirname "$0")"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   AgentCore Lambda MCP Client - Deploy                       ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Region:    ${REGION}"
echo "║  Function:  ${LAMBDA_NAME}"
echo "║  Runtime:   ${RUNTIME}"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Resolve Gateway URL ────────────────────────────────────────────
if [ -z "${AGENTCORE_GATEWAY_URL:-}" ]; then
  echo "[1/5] Auto-detecting gateway URL..."
  GATEWAY_ID=$(aws bedrock-agentcore-control list-gateways --region "${REGION}" \
    --query "items[?contains(name, 'PartySupply')].gatewayId | [0]" \
    --output text 2>/dev/null || echo "None")
  if [ -z "$GATEWAY_ID" ] || [ "$GATEWAY_ID" = "None" ]; then
    echo "❌ Could not find a PartySupply gateway in ${REGION}."
    echo "   Either export AGENTCORE_GATEWAY_URL or run the main"
    echo "   ./scripts/deploy.sh first to create the gateway."
    exit 1
  fi
  AGENTCORE_GATEWAY_URL="https://${GATEWAY_ID}.gateway.bedrock-agentcore.${REGION}.amazonaws.com"
  echo "  Gateway URL: ${AGENTCORE_GATEWAY_URL}"
else
  echo "[1/5] Using provided gateway URL: ${AGENTCORE_GATEWAY_URL}"
fi

# ─── Step 2: IAM role ───────────────────────────────────────────────────────
echo "[2/5] Ensuring IAM role: ${ROLE_NAME}..."
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
TRUST_POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  echo "  (role already exists)"
else
  aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "${TRUST_POLICY}" \
    --description "Execution role for the AgentCore Lambda MCP client example" >/dev/null
  echo "  Role created."
fi

aws iam attach-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" 2>/dev/null || true

# Inline policy: allow invoking the AgentCore gateway. In production scope
# Resource down to the specific gateway ARN; we use "*" here to keep the
# example portable across gateway deletions/recreates.
GW_POLICY="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"bedrock-agentcore:InvokeAgent\",\"bedrock-agentcore:InvokeAgentRuntime\"],\"Resource\":\"*\"}]}"
aws iam put-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name "InvokeAgentCoreGateway" \
  --policy-document "${GW_POLICY}" >/dev/null

ROLE_ARN=$(aws iam get-role --role-name "${ROLE_NAME}" --query Role.Arn --output text)
echo "  Role ARN: ${ROLE_ARN}"
echo "  Waiting 10s for IAM propagation..."
sleep 10

# ─── Step 3: Install deps + package zip ─────────────────────────────────────
echo "[3/5] Installing deps + packaging Lambda..."
npm install --silent --no-fund --no-audit

rm -f "${ZIP_PATH}"
if command -v zip >/dev/null 2>&1; then
  zip -qr "${ZIP_PATH}" index.mjs package.json node_modules
elif command -v 7z >/dev/null 2>&1; then
  7z a -tzip "${ZIP_PATH}" index.mjs package.json node_modules >/dev/null
else
  echo "❌ Neither 'zip' nor '7z' is available. Install one and re-run."
  exit 1
fi
echo "  Package: ${ZIP_PATH} ($(du -h "${ZIP_PATH}" | cut -f1))"

# ─── Step 4: Create / update Lambda ─────────────────────────────────────────
echo "[4/5] Deploying Lambda function: ${LAMBDA_NAME}..."
ENV_VARS="Variables={AGENTCORE_GATEWAY_URL=${AGENTCORE_GATEWAY_URL},MCP_TARGET_PREFIX=${TARGET_PREFIX}}"

if aws lambda get-function --function-name "${LAMBDA_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  aws lambda update-function-code \
    --function-name "${LAMBDA_NAME}" \
    --zip-file "fileb://${ZIP_PATH}" \
    --region "${REGION}" >/dev/null
  aws lambda wait function-updated \
    --function-name "${LAMBDA_NAME}" \
    --region "${REGION}"
  aws lambda update-function-configuration \
    --function-name "${LAMBDA_NAME}" \
    --runtime "${RUNTIME}" \
    --handler "${HANDLER}" \
    --timeout "${TIMEOUT}" \
    --memory-size "${MEMORY}" \
    --environment "${ENV_VARS}" \
    --region "${REGION}" >/dev/null
  echo "  Function updated."
else
  aws lambda create-function \
    --function-name "${LAMBDA_NAME}" \
    --runtime "${RUNTIME}" \
    --role "${ROLE_ARN}" \
    --handler "${HANDLER}" \
    --zip-file "fileb://${ZIP_PATH}" \
    --timeout "${TIMEOUT}" \
    --memory-size "${MEMORY}" \
    --environment "${ENV_VARS}" \
    --region "${REGION}" >/dev/null
  echo "  Function created."
fi

LAMBDA_ARN=$(aws lambda get-function --function-name "${LAMBDA_NAME}" --region "${REGION}" \
  --query "Configuration.FunctionArn" --output text)
echo "  Lambda ARN: ${LAMBDA_ARN}"

# ─── Step 5: Print quick-test commands ──────────────────────────────────────
echo "[5/5] Done. Try it out:"
cat <<EOF

  # Chat
  aws lambda invoke --function-name ${LAMBDA_NAME} --region ${REGION} \\
    --cli-binary-format raw-in-base64-out \\
    --payload '{"action":"chat","prompt":"Show me birthday party supplies","actorId":"CUST-100005"}' \\
    /tmp/chat.json && cat /tmp/chat.json

  # List recent sessions (48h)
  aws lambda invoke --function-name ${LAMBDA_NAME} --region ${REGION} \\
    --cli-binary-format raw-in-base64-out \\
    --payload '{"action":"list_sessions","actorId":"CUST-100005"}' \\
    /tmp/sessions.json && cat /tmp/sessions.json

  # Get full timeline of a specific session
  aws lambda invoke --function-name ${LAMBDA_NAME} --region ${REGION} \\
    --cli-binary-format raw-in-base64-out \\
    --payload '{"action":"get_session_history","actorId":"CUST-100005","sessionId":"<session-id>"}' \\
    /tmp/history.json && cat /tmp/history.json

EOF
