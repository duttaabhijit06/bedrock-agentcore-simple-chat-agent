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
# Keep the zip in CWD (a relative path) rather than /tmp - on Windows the
# AWS CLI is a native binary and won't resolve POSIX /tmp paths emitted
# by Git Bash. The main scripts/deploy.sh uses the same trick.
ZIP_PATH="./${LAMBDA_NAME}.zip"
TARGET_PREFIX="${MCP_TARGET_PREFIX:-PartySupplyTarget}"
API_NAME="${API_NAME:-agentcore-lambda-example-api}"
API_STAGE="${API_STAGE:-prod}"
# Set DEPLOY_API=0 to skip the API Gateway step (Lambda-only deploy).
DEPLOY_API="${DEPLOY_API:-1}"

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

# Inline policy: allow invoking the AgentCore gateway. The action that
# actually authorizes POST /mcp is `bedrock-agentcore:InvokeGateway` -
# this is what the gateway checks against the SigV4-signed caller's
# principal. In production scope Resource down to the specific gateway
# ARN; we use "*" here to keep the example portable across gateway
# deletions/recreates.
GW_POLICY="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"bedrock-agentcore:InvokeGateway\",\"bedrock-agentcore:InvokeAgentRuntime\"],\"Resource\":\"*\"}]}"
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

# Cross-platform zipping (same trick the main scripts/deploy.sh uses):
# on Windows, `zip` is commonly a 7-Zip alias which uses different flags.
# Detect by running it with no args - Info-ZIP and 7-Zip print distinct
# banners.
ZIP_IS_7Z=false
if command -v zip >/dev/null 2>&1; then
  if zip 2>&1 | head -3 | grep -qi "7-zip"; then
    ZIP_IS_7Z=true
  fi
fi

if command -v zip >/dev/null 2>&1 && [ "$ZIP_IS_7Z" = false ]; then
  zip -qr "${ZIP_PATH}" index.mjs package.json node_modules
elif [ "$ZIP_IS_7Z" = true ]; then
  zip a -tzip "${ZIP_PATH}" index.mjs package.json node_modules >/dev/null 2>&1
elif command -v 7z >/dev/null 2>&1; then
  7z a -tzip "${ZIP_PATH}" index.mjs package.json node_modules >/dev/null 2>&1
elif [ -f "/c/Program Files/7-Zip/7z.exe" ]; then
  "/c/Program Files/7-Zip/7z.exe" a -tzip "${ZIP_PATH}" index.mjs package.json node_modules >/dev/null 2>&1
elif [ -f "/c/Program Files (x86)/7-Zip/7z.exe" ]; then
  "/c/Program Files (x86)/7-Zip/7z.exe" a -tzip "${ZIP_PATH}" index.mjs package.json node_modules >/dev/null 2>&1
else
  echo "❌ Neither zip nor 7z found."
  echo "   On Windows install 7-Zip (choco install 7zip)."
  echo "   On macOS/Linux install zip via your package manager."
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

# Lambda is uploaded and live now; remove the interim zip so re-runs of
# the script see a clean working directory (and so it doesn't get
# committed by mistake - it's gitignored, but belt + suspenders).
rm -f "${ZIP_PATH}"
echo "  Cleaned up local zip: ${ZIP_PATH}"

# ─── Step 5: API Gateway HTTP API (v2) ──────────────────────────────────────
# Exposes the Lambda over `POST /mcp` with AWS_IAM authorization, so
# callers SigV4-sign against service=execute-api and the API GW checks
# whether their principal has execute-api:Invoke on the route ARN.
#
# Why v2 (HTTP API) instead of v1 (REST API):
#   - Cheaper ($1/M calls vs $3.50/M)
#   - Built-in Lambda proxy integration
#   - AWS_IAM authorizer is a single flag (not an authorizer resource)
INVOKE_URL=""
if [ "${DEPLOY_API}" = "1" ]; then
  echo "[5/6] Provisioning API Gateway HTTP API: ${API_NAME}..."

  # Find or create the API. Names are not unique; we match on the name we
  # set so re-running this script doesn't keep stacking new APIs.
  API_ID=$(aws apigatewayv2 get-apis --region "${REGION}" \
    --query "Items[?Name=='${API_NAME}'].ApiId | [0]" --output text 2>/dev/null || echo "None")

  if [ -z "${API_ID}" ] || [ "${API_ID}" = "None" ]; then
    API_ID=$(aws apigatewayv2 create-api \
      --name "${API_NAME}" \
      --protocol-type HTTP \
      --description "AgentCore Lambda MCP client example - IAM-authenticated" \
      --region "${REGION}" \
      --query "ApiId" --output text)
    echo "  API created: ${API_ID}"
  else
    echo "  API exists: ${API_ID}"
  fi

  # Integration to the Lambda. apigatewayv2_integrate via AWS_PROXY uses
  # Lambda proxy format (event has requestContext.http, body is JSON
  # string, response must be {statusCode, headers, body}).
  INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id "${API_ID}" --region "${REGION}" \
    --query "Items[?IntegrationUri=='${LAMBDA_ARN}'].IntegrationId | [0]" --output text 2>/dev/null || echo "None")
  if [ -z "${INTEGRATION_ID}" ] || [ "${INTEGRATION_ID}" = "None" ]; then
    INTEGRATION_ID=$(aws apigatewayv2 create-integration \
      --api-id "${API_ID}" \
      --integration-type AWS_PROXY \
      --integration-uri "${LAMBDA_ARN}" \
      --payload-format-version "2.0" \
      --region "${REGION}" \
      --query "IntegrationId" --output text)
    echo "  Integration created: ${INTEGRATION_ID}"
  else
    echo "  Integration exists: ${INTEGRATION_ID}"
  fi

  # Route: POST /mcp with AWS_IAM auth. We delete-and-recreate when the
  # route exists to make AuthorizationType changes idempotent.
  ROUTE_ID=$(aws apigatewayv2 get-routes --api-id "${API_ID}" --region "${REGION}" \
    --query "Items[?RouteKey=='POST /mcp'].RouteId | [0]" --output text 2>/dev/null || echo "None")
  if [ -z "${ROUTE_ID}" ] || [ "${ROUTE_ID}" = "None" ]; then
    ROUTE_ID=$(aws apigatewayv2 create-route \
      --api-id "${API_ID}" \
      --route-key "POST /mcp" \
      --target "integrations/${INTEGRATION_ID}" \
      --authorization-type AWS_IAM \
      --region "${REGION}" \
      --query "RouteId" --output text)
    echo "  Route created: POST /mcp (AWS_IAM auth)"
  else
    aws apigatewayv2 update-route \
      --api-id "${API_ID}" \
      --route-id "${ROUTE_ID}" \
      --target "integrations/${INTEGRATION_ID}" \
      --authorization-type AWS_IAM \
      --region "${REGION}" >/dev/null
    echo "  Route updated: POST /mcp (AWS_IAM auth)"
  fi

  # Auto-deploy stage so changes go live immediately. AutoDeploy=true is
  # idempotent - safe to re-apply.
  STAGE_EXISTS=$(aws apigatewayv2 get-stages --api-id "${API_ID}" --region "${REGION}" \
    --query "Items[?StageName=='${API_STAGE}'].StageName | [0]" --output text 2>/dev/null || echo "None")
  if [ -z "${STAGE_EXISTS}" ] || [ "${STAGE_EXISTS}" = "None" ]; then
    aws apigatewayv2 create-stage \
      --api-id "${API_ID}" \
      --stage-name "${API_STAGE}" \
      --auto-deploy \
      --region "${REGION}" >/dev/null
    echo "  Stage created: ${API_STAGE} (auto-deploy)"
  else
    aws apigatewayv2 update-stage \
      --api-id "${API_ID}" \
      --stage-name "${API_STAGE}" \
      --auto-deploy \
      --region "${REGION}" >/dev/null
    echo "  Stage updated: ${API_STAGE} (auto-deploy)"
  fi

  # Grant API Gateway permission to invoke the Lambda. add-permission is
  # not idempotent (errors if the statement-id already exists) so we
  # swallow that case.
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  SOURCE_ARN="arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*/mcp"
  aws lambda add-permission \
    --function-name "${LAMBDA_NAME}" \
    --statement-id "apigw-invoke-mcp" \
    --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "${SOURCE_ARN}" \
    --region "${REGION}" 2>/dev/null \
    && echo "  Lambda invoke permission granted to API Gateway." \
    || echo "  (invoke permission already exists)"

  INVOKE_URL="https://${API_ID}.execute-api.${REGION}.amazonaws.com/${API_STAGE}/mcp"
  echo "  Invoke URL: ${INVOKE_URL}"
else
  echo "[5/6] Skipping API Gateway (DEPLOY_API=0)."
fi

# ─── Step 6: Print quick-test commands ──────────────────────────────────────
echo "[6/6] Done. Try it out:"
cat <<EOF

  # ── Direct Lambda invoke (always available) ──────────────────────────

  # Chat
  aws lambda invoke --function-name ${LAMBDA_NAME} --region ${REGION} \\
    --cli-binary-format raw-in-base64-out \\
    --payload '{"action":"chat","prompt":"Show me birthday party supplies","actorId":"CUST-100005"}' \\
    ./chat.json && cat ./chat.json

  # List recent sessions (48h)
  aws lambda invoke --function-name ${LAMBDA_NAME} --region ${REGION} \\
    --cli-binary-format raw-in-base64-out \\
    --payload '{"action":"list_sessions","actorId":"CUST-100005"}' \\
    ./sessions.json && cat ./sessions.json

  # Get full timeline of a specific session
  aws lambda invoke --function-name ${LAMBDA_NAME} --region ${REGION} \\
    --cli-binary-format raw-in-base64-out \\
    --payload '{"action":"get_session_history","actorId":"CUST-100005","sessionId":"<session-id>"}' \\
    ./history.json && cat ./history.json
EOF

if [ -n "${INVOKE_URL}" ]; then
  cat <<EOF

  # ── HTTP API (SigV4 signed against service=execute-api) ──────────────
  # Quick curl test using awscurl (pip install awscurl):
  awscurl --service execute-api --region ${REGION} -X POST \\
    -d '{"action":"list_sessions","actorId":"CUST-100005"}' \\
    ${INVOKE_URL}

  # Or use the bundled Node client:
  AGENTCORE_HTTP_API_URL=${INVOKE_URL} node http-client.mjs list_sessions CUST-100005

EOF
fi
