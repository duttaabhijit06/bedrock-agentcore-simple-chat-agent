#!/bin/bash
set -euo pipefail

# ─── Party Supply Chat Agent - Backend Deployment Script ─────────────────────
# Cross-platform (macOS & Linux) deployment script.
#
# Windows: Run this script using Git Bash, WSL, or similar bash environment.
#          PowerShell is NOT supported directly.
#
# Architecture:
#   UI → AgentCore Gateway (MCP, IAM auth) → Lambda Target → AgentCore Runtime (Strands Agent)
#
# Learnings baked in:
#   - Use public.ecr.aws base images in Dockerfile (Docker Hub rate limits on CodeBuild)
#   - UID 1001 in Dockerfile (node:20-slim already uses UID 1000)
#   - Model ID: us.anthropic.claude-sonnet-4-5-20250929-v1:0 (not the 20250514 variant)
#   - Lambda env var: AGENT_REGION not AWS_REGION (reserved in Lambda)
#   - S3 Vectors create-index requires --data-type float32
#   - Gateway Lambda target needs both service principal AND gateway role permissions
#   - SDK InvokeAgentRuntimeCommand param is agentRuntimeArn (not runtimeArn)
#   - SDK sends wrong content-type; needs middleware to force application/json
#   - agentcore CLI creates project in subdirectory; CDK deps need npm install
#   - macOS grep doesn't support -P; use grep -o with sed instead
#
# Usage:
#   ./scripts/deploy.sh [OPTIONS]
#
# Options:
#   --all              Run all steps (default if no flags given)
#   --seed             Generate seed data with embeddings
#   --vectors          Create S3 Vector bucket and indexes
#   --upload           Upload seed data to S3 Vectors
#   --agent            Deploy agent to AgentCore Runtime + Gateway
#   --lambda           Deploy the gateway Lambda function
#   --gateway-target   Add Lambda as gateway target
#   --status           Show deployment status
#   --clean            Tear down all deployed resources
#   --region REGION    AWS region (default: us-west-2)
#   --help             Show this help message

# ─── Configuration ───────────────────────────────────────────────────────────

REGION="${AWS_REGION:-us-west-2}"
STACK_SUFFIX="${STACK_SUFFIX:-}"
DEPLOYMENT_TARGET="default"
VECTOR_BUCKET_NAME="party-supply-vectors"
LAMBDA_NAME="party-supply-gateway-handler"
LAMBDA_ROLE_NAME="party-supply-lambda-role"
ACCOUNT_ID=""

# Apply suffix to resource names if provided
if [ -n "$STACK_SUFFIX" ]; then
  DEPLOYMENT_TARGET="$STACK_SUFFIX"
  VECTOR_BUCKET_NAME="party-supply-vectors-$STACK_SUFFIX"
  LAMBDA_NAME="party-supply-gateway-handler-$STACK_SUFFIX"
  LAMBDA_ROLE_NAME="party-supply-lambda-role-$STACK_SUFFIX"
fi

# ─── Flags ───────────────────────────────────────────────────────────────────

DO_ALL=false
DO_SEED=false
DO_VECTORS=false
DO_UPLOAD=false
DO_AGENT=false
DO_LAMBDA=false
DO_GATEWAY_TARGET=false
DO_STATUS=false
DO_CLEAN=false
NO_FLAGS=true

# ─── Parse Arguments ─────────────────────────────────────────────────────────

show_help() {
  echo "Usage: ./scripts/deploy.sh [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --all              Run all steps (default if no flags given)"
  echo "  --seed             Generate seed data with embeddings"
  echo "  --vectors          Create S3 Vector bucket and indexes"
  echo "  --upload           Upload seed data to S3 Vectors"
  echo "  --agent            Deploy agent and gateway to AgentCore Runtime"
  echo "  --lambda           Deploy the gateway Lambda function"
  echo "  --gateway-target   Add Lambda as a target on the gateway"
  echo "  --status           Show deployment status"
  echo "  --clean            Tear down all deployed resources"
  echo "  --region REGION    AWS region (default: us-west-2)"
  echo "  --suffix SUFFIX    Stack suffix for multiple deployments (e.g., dev, staging)"
  echo "  --help             Show this help message"
  echo ""
  echo "Examples:"
  echo "  ./scripts/deploy.sh --all                       # Full deployment"
  echo "  ./scripts/deploy.sh --all --suffix dev          # Deploy with 'dev' suffix"
  echo "  ./scripts/deploy.sh --seed --upload             # Regenerate and upload data"
  echo "  ./scripts/deploy.sh --lambda --gateway-target   # Deploy Lambda + wire to gateway"
  echo "  ./scripts/deploy.sh --clean --suffix dev        # Tear down 'dev' deployment"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)             DO_ALL=true; NO_FLAGS=false; shift ;;
    --seed)            DO_SEED=true; NO_FLAGS=false; shift ;;
    --vectors)         DO_VECTORS=true; NO_FLAGS=false; shift ;;
    --upload)          DO_UPLOAD=true; NO_FLAGS=false; shift ;;
    --agent)           DO_AGENT=true; NO_FLAGS=false; shift ;;
    --lambda)          DO_LAMBDA=true; NO_FLAGS=false; shift ;;
    --gateway-target)  DO_GATEWAY_TARGET=true; NO_FLAGS=false; shift ;;
    --status)          DO_STATUS=true; NO_FLAGS=false; shift ;;
    --clean)           DO_CLEAN=true; NO_FLAGS=false; shift ;;
    --region)          REGION="$2"; shift 2 ;;
    --suffix)          STACK_SUFFIX="$2"; shift 2 ;;
    --help|-h)         show_help; exit 0 ;;
    *)                 echo "Unknown option: $1"; show_help; exit 1 ;;
  esac
done

# Recalculate resource names after parsing arguments
if [ -n "$STACK_SUFFIX" ]; then
  DEPLOYMENT_TARGET="$STACK_SUFFIX"
  VECTOR_BUCKET_NAME="party-supply-vectors-$STACK_SUFFIX"
  LAMBDA_NAME="party-supply-gateway-handler-$STACK_SUFFIX"
  LAMBDA_ROLE_NAME="party-supply-lambda-role-$STACK_SUFFIX"
fi

if [ "$NO_FLAGS" = true ]; then
  DO_ALL=true
fi

# ─── Helpers ─────────────────────────────────────────────────────────────────

resolve_account() {
  ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")}"
  if [ -z "$ACCOUNT_ID" ]; then
    echo "❌ Could not determine AWS Account ID. Check your AWS credentials."
    exit 1
  fi
}

get_gateway_id() {
  # Response key is 'items' per AWS CLI docs
  local gw_id
  gw_id=$(aws bedrock-agentcore-control list-gateways --region "${REGION}" \
    --query "items[?contains(name, 'PartySupply')].gatewayId | [0]" \
    --output text 2>/dev/null || echo "None")
  if [ "$gw_id" = "None" ] || [ -z "$gw_id" ]; then
    # Fallback: parse agentcore status output
    gw_id=$(agentcore status 2>&1 | grep -o '([^)]*' | grep -i 'partysupply' | sed 's/(//' | head -1 || echo "")
  fi
  echo "$gw_id"
}

get_runtime_arn() {
  # Extract full runtime ARN from agentcore status (handles line wrapping)
  local arn
  arn=$(npx agentcore status 2>&1 | tr -d '\n' | grep -o 'arn:aws:bedrock-agentcore:[^)]*' | head -1 || echo "")
  echo "$arn"
}

print_banner() {
  resolve_account
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║   Party Supply Chat Agent - Deployment                      ║"
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║  Region:         ${REGION}"
  echo "║  Account:        ${ACCOUNT_ID}"
  echo "║  Target:         ${DEPLOYMENT_TARGET}"
  echo "║  Vector Bucket:  ${VECTOR_BUCKET_NAME}"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""

  # Install root dependencies if missing
  if [ ! -d "node_modules" ]; then
    echo "  Installing root dependencies..."
    npm install
  fi

  # Ensure AgentCore CLI has the required peer dependency
  if ! npm list -g @aws-sdk/region-config-resolver >/dev/null 2>&1; then
    echo "  Installing missing AgentCore CLI dependency..."
    npm install -g @aws-sdk/region-config-resolver 2>/dev/null || echo "  (install failed, but may not be needed)"
  fi

  # Auto-generate aws-targets.json including current target + any existing deployed targets
  # This prevents validation errors when switching between targets (e.g., dev/default)
  node -e "
    const fs = require('fs');
    const path = require('path');

    const currentTarget = '${DEPLOYMENT_TARGET}';
    const account = '${ACCOUNT_ID}';
    const region = '${REGION}';

    // Start with current target
    const targets = [{ name: currentTarget, account, region }];

    // Add any previously deployed targets from deployed-state.json
    const statePath = 'agentcore/.cli/deployed-state.json';
    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
        const deployedNames = Object.keys(state.targets || {});
        for (const name of deployedNames) {
          if (name !== currentTarget) {
            targets.push({ name, account, region });
          }
        }
      } catch(e) {}
    }

    fs.writeFileSync('agentcore/aws-targets.json', JSON.stringify(targets, null, 2));
  "
}

# ─── Step: Generate Seed Data ────────────────────────────────────────────────

step_seed() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "[seed] Generating seed data with Titan Text Embeddings V2..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  AWS_REGION="${REGION}" npx --yes tsx scripts/generate-seed-data.ts
  echo ""
}

# ─── Step: Create S3 Vector Bucket & Indexes ─────────────────────────────────

step_vectors() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "[vectors] Creating S3 Vector bucket and indexes..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Creating vector bucket: ${VECTOR_BUCKET_NAME}"
  aws s3vectors create-vector-bucket \
    --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
    --region "${REGION}" 2>/dev/null || echo "  (already exists)"

  # NOTE: --data-type float32 is required
  echo "  Creating products-index..."
  aws s3vectors create-index \
    --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
    --index-name "products-index" \
    --dimension 1024 --distance-metric "cosine" --data-type "float32" \
    --region "${REGION}" 2>/dev/null || echo "  (already exists)"

  echo "  Creating orders-index..."
  aws s3vectors create-index \
    --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
    --index-name "orders-index" \
    --dimension 1024 --distance-metric "cosine" --data-type "float32" \
    --region "${REGION}" 2>/dev/null || echo "  (already exists)"

  echo "  Waiting for indexes to become active..."
  for idx_name in "products-index" "orders-index"; do
    retries=0
    while [ $retries -lt 30 ]; do
      # Try get-index first (faster), fall back to list-indexes (broader CLI support)
      if aws s3vectors get-index \
        --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
        --index-name "${idx_name}" \
        --region "${REGION}" >/dev/null 2>&1; then
        echo "    ${idx_name}: ready"
        break
      elif aws s3vectors list-indexes \
        --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
        --region "${REGION}" 2>/dev/null | grep -q "\"indexName\": \"${idx_name}\""; then
        echo "    ${idx_name}: ready"
        break
      fi
      retries=$((retries + 1))
      sleep 2
    done
    if [ $retries -eq 30 ]; then
      echo "    ❌ ${idx_name}: timed out waiting (60s). Check AWS console."
      exit 1
    fi
  done
  echo ""
}

# ─── Step: Upload Seed Data ──────────────────────────────────────────────────

step_upload() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "[upload] Uploading seed data to S3 Vectors..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  if [ ! -f "seed-data/products-vectors.json" ]; then
    echo "  ❌ Seed data not found. Run with --seed first."; exit 1
  fi

  echo "  Uploading product vectors (will overwrite existing)..."
  node --input-type=module -e "
import { readFileSync } from 'fs';
import { S3VectorsClient, PutVectorsCommand } from '@aws-sdk/client-s3vectors';
const client = new S3VectorsClient({ region: '${REGION}' });
const data = JSON.parse(readFileSync('seed-data/products-vectors.json', 'utf-8'));
for (let i = 0; i < data.vectors.length; i += 10) {
  const batch = data.vectors.slice(i, i + 10);
  await client.send(new PutVectorsCommand({
    vectorBucketName: '${VECTOR_BUCKET_NAME}', indexName: 'products-index',
    vectors: batch.map(v => ({ key: v.key, data: { float32: v.vector }, metadata: v.metadata })),
  }));
  console.log('    Uploaded products batch ' + (Math.floor(i/10) + 1));
}
console.log('  Products: done');
"

  echo "  Uploading order vectors..."
  node --input-type=module -e "
import { readFileSync } from 'fs';
import { S3VectorsClient, PutVectorsCommand } from '@aws-sdk/client-s3vectors';
const client = new S3VectorsClient({ region: '${REGION}' });
const data = JSON.parse(readFileSync('seed-data/orders-vectors.json', 'utf-8'));
for (let i = 0; i < data.vectors.length; i += 10) {
  const batch = data.vectors.slice(i, i + 10);
  await client.send(new PutVectorsCommand({
    vectorBucketName: '${VECTOR_BUCKET_NAME}', indexName: 'orders-index',
    vectors: batch.map(v => ({ key: v.key, data: { float32: v.vector }, metadata: v.metadata })),
  }));
  console.log('    Uploaded orders batch ' + (Math.floor(i/10) + 1));
}
console.log('  Orders: done');
"
  echo ""
}

# ─── Step: Deploy Agent & Gateway (AgentCore CLI) ────────────────────────────

step_agent() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "[agent] Deploying agent and MCP gateway to AgentCore Runtime..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  if ! command -v agentcore >/dev/null 2>&1 && [ ! -f "node_modules/.bin/agentcore" ]; then
    echo "  Installing dependencies (includes AgentCore CLI)..."
    npm install
  fi
  # CDK deps must be installed before deploy
  if [ ! -d "agentcore/cdk/node_modules" ]; then
    echo "  Installing CDK dependencies..."
    npm install --prefix agentcore/cdk 2>/dev/null
  fi

  # Compute camelCase suffix for resource naming
  SUFFIX_CAMEL=""
  if [ -n "$STACK_SUFFIX" ]; then
    SUFFIX_CAMEL=$(echo "$STACK_SUFFIX" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')
  fi

  # Only pre-delete ECR repo if the stack does NOT exist (fresh deploy)
  # If stack exists, CDK manages the ECR repo and deleting would orphan the runtime image
  STACK_NAME_CHECK="AgentCore-PartySupply${SUFFIX_CAMEL}-${DEPLOYMENT_TARGET}"
  STACK_EXISTS=$(aws cloudformation describe-stacks --stack-name "${STACK_NAME_CHECK}" --region "${REGION}" \
    --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "DOES_NOT_EXIST")

  if [ "$STACK_EXISTS" = "DOES_NOT_EXIST" ]; then
    PROJECT_NAME_LC=$(echo "partysupply${SUFFIX_CAMEL}" | tr '[:upper:]' '[:lower:]')
    AGENT_NAME_LC=$(echo "partysupplyagent${SUFFIX_CAMEL}" | tr '[:upper:]' '[:lower:]')
    ECR_REPO_NAME="${PROJECT_NAME_LC}/${AGENT_NAME_LC}"
    echo "  Stack doesn't exist - pre-deleting orphaned ECR repository: ${ECR_REPO_NAME}"
    aws ecr delete-repository --repository-name "${ECR_REPO_NAME}" --force --region "${REGION}" >/dev/null 2>&1 \
      && echo "  ECR repository deleted." \
      || echo "  (ECR repo not found or already deleted)"
  else
    echo "  Stack exists (${STACK_EXISTS}) - leaving ECR repo intact for CDK to manage."
  fi

  # Update agentcore.json with current vector bucket name, region, and unique project/resource names
  # When using --suffix, project/agent/memory/gateway names get suffixed to avoid ECR/resource collisions
  echo "  Updating agentcore.json with target-specific config..."
  node -e "
    const fs = require('fs');
    const config = JSON.parse(fs.readFileSync('agentcore/agentcore.json', 'utf8'));
    const suffix = '${SUFFIX_CAMEL}';

    // Suffix project name for unique ECR/CFN resource names (only when --suffix is provided)
    config.name = 'PartySupply' + suffix;
    if (config.runtimes[0]) config.runtimes[0].name = 'PartySupplyAgent' + suffix;
    if (config.memories[0]) config.memories[0].name = 'PartySupplyMemory' + suffix;
    if (config.agentCoreGateways[0]) config.agentCoreGateways[0].name = 'PartySupplyGateway' + suffix;

    config.runtimes[0].envVars = config.runtimes[0].envVars.map(e => {
      if (e.name === 'VECTOR_BUCKET_NAME') return { name: 'VECTOR_BUCKET_NAME', value: '${VECTOR_BUCKET_NAME}' };
      if (e.name === 'AWS_REGION') return { name: 'AWS_REGION', value: '${REGION}' };
      if (e.name === 'MEMORY_NAME') return { name: 'MEMORY_NAME', value: 'PartySupplyMemory' + suffix };
      return e;
    });
    fs.writeFileSync('agentcore/agentcore.json', JSON.stringify(config, null, 2));
  "

  echo "  Validating configuration..."
  npx agentcore validate
  echo "  Deploying (container build via CodeBuild, ~3-5 min)..."
  agentcore deploy --target "${DEPLOYMENT_TARGET}" --yes

  # Add RAG + Memory permissions to the runtime execution role
  echo "  Adding RAG and Memory permissions to runtime role..."
  RUNTIME_ROLE=$(aws cloudformation describe-stack-resources \
    --stack-name "AgentCore-PartySupply-${DEPLOYMENT_TARGET}" --region "${REGION}" \
    --query "StackResources[?contains(LogicalResourceId, 'RuntimeExecutionRole')].PhysicalResourceId | [0]" \
    --output text 2>/dev/null || echo "")
  if [ -n "$RUNTIME_ROLE" ] && [ "$RUNTIME_ROLE" != "None" ]; then
    aws iam put-role-policy --role-name "$RUNTIME_ROLE" --policy-name "RAGAccess" \
      --policy-document "{
        \"Version\": \"2012-10-17\",
        \"Statement\": [
          {\"Effect\": \"Allow\", \"Action\": [\"s3vectors:QueryVectors\",\"s3vectors:GetVectors\",\"s3vectors:ListIndexes\"], \"Resource\": \"arn:aws:s3vectors:${REGION}:${ACCOUNT_ID}:bucket/${VECTOR_BUCKET_NAME}*\"},
          {\"Effect\": \"Allow\", \"Action\": [\"bedrock:InvokeModel\"], \"Resource\": [\"arn:aws:bedrock:${REGION}::foundation-model/*\",\"arn:aws:bedrock:us-*::foundation-model/*\"]},
          {\"Effect\": \"Allow\", \"Action\": [\"bedrock-agentcore:CreateEvent\",\"bedrock-agentcore:ListEvents\",\"bedrock-agentcore:RetrieveMemoryRecords\"], \"Resource\": \"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:*\"}
        ]
      }" 2>/dev/null && echo "  Runtime role updated." || echo "  (could not update runtime role)"
  fi

  # Update runtime MEMORY_NAME env var with actual memory ID (it has a random suffix)
  echo "  Updating runtime MEMORY_NAME with actual memory ID..."
  MEMORY_ID=$(node -e "
    try {
      const s = require('./agentcore/.cli/deployed-state.json');
      const t = s.targets['${DEPLOYMENT_TARGET}'];
      const m = t && t.resources && t.resources.memories;
      const key = Object.keys(m || {})[0];
      console.log(m[key].memoryId || '');
    } catch(e) {}
  " 2>/dev/null || echo "")

  RUNTIME_ID=$(node -e "
    try {
      const s = require('./agentcore/.cli/deployed-state.json');
      const t = s.targets['${DEPLOYMENT_TARGET}'];
      const r = t && t.resources && t.resources.runtimes;
      const key = Object.keys(r || {})[0];
      console.log(r[key].runtimeId || '');
    } catch(e) {}
  " 2>/dev/null || echo "")

  if [ -n "$MEMORY_ID" ] && [ -n "$RUNTIME_ID" ]; then
    echo "    Memory ID: ${MEMORY_ID}"
    aws bedrock-agentcore-control update-agent-runtime \
      --agent-runtime-id "${RUNTIME_ID}" \
      --region "${REGION}" \
      --environment-variables "AWS_REGION=${REGION},VECTOR_BUCKET_NAME=${VECTOR_BUCKET_NAME},MEMORY_NAME=${MEMORY_ID}" \
      >/dev/null 2>&1 && echo "    ✓ Runtime env vars updated" || echo "    (could not update runtime env vars - may need manual update)"
  else
    echo "    (could not find memory or runtime ID)"
  fi
  echo ""
}

# ─── Step: Deploy Lambda ─────────────────────────────────────────────────────

step_lambda() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "[lambda] Deploying gateway Lambda function..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  RUNTIME_ARN=$(get_runtime_arn)
  if [ -z "$RUNTIME_ARN" ]; then
    echo "  ❌ Could not find runtime ARN. Deploy agent first (--agent)."
    exit 1
  fi
  echo "  Runtime ARN: ${RUNTIME_ARN}"

  # Create IAM role for Lambda
  echo "  Creating Lambda execution role..."
  TRUST_POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
  aws iam create-role \
    --role-name "${LAMBDA_ROLE_NAME}" \
    --assume-role-policy-document "${TRUST_POLICY}" \
    --region "${REGION}" 2>/dev/null || echo "  (role already exists)"

  aws iam attach-role-policy \
    --role-name "${LAMBDA_ROLE_NAME}" \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" 2>/dev/null || true

  # Policy to invoke the AgentCore Runtime
  # NOTE: Resource must include wildcard for runtime-endpoint/DEFAULT suffix
  RUNTIME_POLICY="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"bedrock-agentcore:InvokeAgentRuntime\",\"Resource\":\"${RUNTIME_ARN}*\"}]}"
  aws iam put-role-policy \
    --role-name "${LAMBDA_ROLE_NAME}" \
    --policy-name "InvokeAgentCoreRuntime" \
    --policy-document "${RUNTIME_POLICY}" 2>/dev/null || true

  ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${LAMBDA_ROLE_NAME}"
  echo "  Role ARN: ${ROLE_ARN}"
  echo "  Waiting for IAM role propagation (10s)..."
  sleep 10

  # Package Lambda (install deps + zip)
  echo "  Packaging Lambda..."
  LAMBDA_ZIP="./party-supply-lambda.zip"
  pushd lambda > /dev/null
  npm install --omit=dev 2>/dev/null

  # Use 7z if zip is not available (common on Windows)
  if command -v zip &> /dev/null; then
    zip -qr "../${LAMBDA_ZIP}" index.mjs node_modules/ package.json
  elif [ -f "/c/ProgramData/chocolatey/bin/7z.exe" ]; then
    /c/ProgramData/chocolatey/bin/7z.exe a -tzip "../${LAMBDA_ZIP}" index.mjs node_modules package.json -r > /dev/null
  elif command -v 7z &> /dev/null; then
    7z a -tzip "../${LAMBDA_ZIP}" index.mjs node_modules package.json -r > /dev/null
  else
    echo "❌ Error: Neither 'zip' nor '7z' found. Install one of them to continue."
    popd > /dev/null
    exit 1
  fi

  popd > /dev/null

  # Create or update Lambda function
  # NOTE: Use AGENT_REGION not AWS_REGION (AWS_REGION is reserved in Lambda)
  echo "  Deploying Lambda: ${LAMBDA_NAME}"
  if aws lambda get-function --function-name "${LAMBDA_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    aws lambda update-function-code \
      --function-name "${LAMBDA_NAME}" \
      --zip-file "fileb://${LAMBDA_ZIP}" \
      --region "${REGION}" > /dev/null
    sleep 5
    aws lambda update-function-configuration \
      --function-name "${LAMBDA_NAME}" \
      --environment "Variables={AGENT_REGION=${REGION},RUNTIME_ARN=${RUNTIME_ARN}}" \
      --timeout 120 \
      --region "${REGION}" > /dev/null 2>&1 || true
  else
    aws lambda create-function \
      --function-name "${LAMBDA_NAME}" \
      --runtime "nodejs20.x" \
      --role "${ROLE_ARN}" \
      --handler "index.handler" \
      --zip-file "fileb://${LAMBDA_ZIP}" \
      --timeout 120 \
      --memory-size 256 \
      --environment "Variables={AGENT_REGION=${REGION},RUNTIME_ARN=${RUNTIME_ARN}}" \
      --region "${REGION}" > /dev/null
  fi

  LAMBDA_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${LAMBDA_NAME}"
  echo "  Lambda ARN: ${LAMBDA_ARN}"

  # Clean up zip file
  rm -f "${LAMBDA_ZIP}"

  # Grant gateway service principal permission to invoke Lambda
  echo "  Adding invoke permissions..."
  aws lambda add-permission \
    --function-name "${LAMBDA_NAME}" \
    --statement-id "AllowAgentCoreGateway" \
    --action "lambda:InvokeFunction" \
    --principal "bedrock-agentcore.amazonaws.com" \
    --region "${REGION}" 2>/dev/null || echo "  (service permission exists)"

  # Also grant the gateway's own execution role (required for create-gateway-target)
  GATEWAY_ID=$(get_gateway_id)
  if [ -n "$GATEWAY_ID" ] && [ "$GATEWAY_ID" != "None" ]; then
    GATEWAY_ROLE=$(aws bedrock-agentcore-control get-gateway \
      --gateway-identifier "${GATEWAY_ID}" \
      --region "${REGION}" --query "roleArn" --output text 2>/dev/null || echo "")
    if [ -n "$GATEWAY_ROLE" ] && [ "$GATEWAY_ROLE" != "None" ]; then
      aws lambda add-permission \
        --function-name "${LAMBDA_NAME}" \
        --statement-id "AllowGatewayRole" \
        --action "lambda:InvokeFunction" \
        --principal "${GATEWAY_ROLE}" \
        --region "${REGION}" 2>/dev/null || echo "  (gateway role permission exists)"
    fi
  fi

  echo "  Lambda deployed."
  echo ""
}

# ─── Step: Add Lambda as Gateway Target ──────────────────────────────────────

step_gateway_target() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "[gateway-target] Adding Lambda as gateway target..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  LAMBDA_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${LAMBDA_NAME}"
  GATEWAY_ID=$(get_gateway_id)

  if [ -z "$GATEWAY_ID" ] || [ "$GATEWAY_ID" = "None" ]; then
    echo "  ❌ Could not find gateway ID. Deploy agent first (--agent)."
    exit 1
  fi
  echo "  Gateway ID: ${GATEWAY_ID}"

  # Check if target already exists
  EXISTING=$(aws bedrock-agentcore-control list-gateway-targets \
    --gateway-identifier "${GATEWAY_ID}" \
    --region "${REGION}" \
    --query "items[?name=='PartySupplyTarget'].targetId | [0]" \
    --output text 2>/dev/null || echo "None")

  if [ "$EXISTING" != "None" ] && [ -n "$EXISTING" ]; then
    echo "  Target 'PartySupplyTarget' already exists. Skipping."
  else
    echo "  Creating Lambda target on gateway..."
    TOOL_SCHEMA=$(cat lambda/tools.json)

    aws bedrock-agentcore-control create-gateway-target \
      --gateway-identifier "${GATEWAY_ID}" \
      --name "PartySupplyTarget" \
      --description "Lambda target that invokes the Party Supply agent runtime" \
      --target-configuration "{
        \"mcp\": {
          \"lambda\": {
            \"lambdaArn\": \"${LAMBDA_ARN}\",
            \"toolSchema\": {
              \"inlinePayload\": ${TOOL_SCHEMA}
            }
          }
        }
      }" \
      --credential-provider-configurations '[{"credentialProviderType": "GATEWAY_IAM_ROLE"}]' \
      --region "${REGION}" > /dev/null

    echo "  Target created."
  fi
  echo ""
}

# ─── Step: Show Status ───────────────────────────────────────────────────────

step_status() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "[status] Deployment status (target: ${DEPLOYMENT_TARGET})"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  npx agentcore status --target "${DEPLOYMENT_TARGET}"

  GATEWAY_ID=$(get_gateway_id)
  if [ -n "$GATEWAY_ID" ] && [ "$GATEWAY_ID" != "None" ]; then
    GATEWAY_URL="https://${GATEWAY_ID}.gateway.bedrock-agentcore.${REGION}.amazonaws.com"
    echo ""
    echo "  Gateway URL: ${GATEWAY_URL}"
    echo "  MCP Endpoint: ${GATEWAY_URL}/mcp"
    echo ""
    echo "  Gateway targets:"
    aws bedrock-agentcore-control list-gateway-targets \
      --gateway-identifier "${GATEWAY_ID}" \
      --region "${REGION}" \
      --query "items[*].{Name:name,Status:status}" \
      --output table 2>/dev/null || echo "  (none)"

    # Update chat-ui .env.local with gateway URL
    echo ""
    echo "  Updating chat-ui/.env.local..."
    cat > chat-ui/.env.local <<EOF
VITE_GATEWAY_URL=${GATEWAY_URL}
VITE_AWS_REGION=${REGION}
EOF
    echo "  Done."
  fi
  echo ""
}

# ─── Step: Clean Up ──────────────────────────────────────────────────────────

step_clean() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "[clean] Tearing down all resources..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Delete gateway target
  GATEWAY_ID=$(get_gateway_id)
  if [ -n "$GATEWAY_ID" ] && [ "$GATEWAY_ID" != "None" ]; then
    echo "  Deleting gateway targets..."
    # Must use target-id to delete targets
    TARGET_IDS=$(aws bedrock-agentcore-control list-gateway-targets \
      --gateway-identifier "${GATEWAY_ID}" \
      --region "${REGION}" \
      --query "items[*].targetId" --output text 2>/dev/null || echo "")
    for tid in $TARGET_IDS; do
      aws bedrock-agentcore-control delete-gateway-target \
        --gateway-identifier "${GATEWAY_ID}" \
        --target-id "${tid}" \
        --region "${REGION}" 2>/dev/null || true
    done
    echo "  Waiting for target deletion..."
    sleep 10
    echo "  Deleting gateway..."
    aws bedrock-agentcore-control delete-gateway \
      --gateway-identifier "${GATEWAY_ID}" \
      --region "${REGION}" 2>/dev/null || echo "  (not found)"
    sleep 5
  fi

  # Delete Lambda
  echo "  Deleting Lambda..."
  aws lambda delete-function --function-name "${LAMBDA_NAME}" --region "${REGION}" 2>/dev/null || echo "  (not found)"

  # Delete Lambda role
  echo "  Deleting Lambda role..."
  aws iam delete-role-policy --role-name "${LAMBDA_ROLE_NAME}" --policy-name "InvokeAgentCoreRuntime" 2>/dev/null || true
  aws iam detach-role-policy --role-name "${LAMBDA_ROLE_NAME}" --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" 2>/dev/null || true
  aws iam delete-role --role-name "${LAMBDA_ROLE_NAME}" 2>/dev/null || echo "  (not found)"

  # Destroy AgentCore stack (gateway + runtime)
  echo "  Destroying AgentCore stack..."
  if command -v agentcore >/dev/null 2>&1 || [ -f "node_modules/.bin/agentcore" ]; then
    npx agentcore destroy 2>/dev/null || echo "  (no stack)"
  fi

  # Delete S3 Vectors
  echo "  Deleting S3 Vectors..."
  aws s3vectors delete-index --vector-bucket-name "${VECTOR_BUCKET_NAME}" --index-name "products-index" --region "${REGION}" 2>/dev/null || true
  aws s3vectors delete-index --vector-bucket-name "${VECTOR_BUCKET_NAME}" --index-name "orders-index" --region "${REGION}" 2>/dev/null || true
  aws s3vectors delete-vector-bucket --vector-bucket-name "${VECTOR_BUCKET_NAME}" --region "${REGION}" 2>/dev/null || true

  # Clean local artifacts
  echo "  Cleaning local files..."
  rm -f seed-data/*.json
  rm -rf agentcore/cdk/cdk.out
  rm -f /tmp/party-supply-lambda.zip
  rm -rf lambda/node_modules

  echo "  Cleanup complete."
  echo ""
}

# ─── Main ────────────────────────────────────────────────────────────────────

print_banner

if [ "$DO_CLEAN" = true ]; then
  step_clean
  exit 0
fi

if [ "$DO_ALL" = true ] || [ "$DO_SEED" = true ]; then
  step_seed
fi

if [ "$DO_ALL" = true ] || [ "$DO_VECTORS" = true ]; then
  step_vectors
fi

if [ "$DO_ALL" = true ] || [ "$DO_UPLOAD" = true ]; then
  step_upload
fi

if [ "$DO_ALL" = true ] || [ "$DO_AGENT" = true ]; then
  step_agent
fi

if [ "$DO_ALL" = true ] || [ "$DO_LAMBDA" = true ]; then
  step_lambda
fi

if [ "$DO_ALL" = true ] || [ "$DO_GATEWAY_TARGET" = true ]; then
  step_gateway_target
fi

if [ "$DO_ALL" = true ] || [ "$DO_STATUS" = true ]; then
  step_status
fi

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   Done!                                                      ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Run the UI:  cd chat-ui && npm run dev                     ║"
echo "║  Open:        http://localhost:5173                          ║"
echo "╚══════════════════════════════════════════════════════════════╝"
