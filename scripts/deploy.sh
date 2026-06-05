#!/bin/bash
set -euo pipefail

# Disable AWS CLI pager globally
export AWS_PAGER=""

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
VECTOR_BUCKET_NAME="${VECTOR_BUCKET_NAME:-party-supply-vectors}"
LAMBDA_NAME="party-supply-gateway-handler"
LAMBDA_ROLE_NAME="party-supply-lambda-role"
ACCOUNT_ID=""

# ─── Flags ───────────────────────────────────────────────────────────────────

DO_ALL=false
DO_SEED=false
DO_VECTORS=false
DO_UPLOAD=false
DO_AGENT=false
DO_LAMBDA=false
DO_GATEWAY_TARGET=false
DO_BATCH_ASYNC=false
DO_GUARDRAIL=false
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
  echo "  --batch-async      Setup batch import async processing (EventBridge + Step Functions + Lambda)"
  echo "  --guardrail        Configure Bedrock Guardrail for the agent"
  echo "  --status           Show deployment status"
  echo "  --clean            Tear down all deployed resources"
  echo "  --region REGION    AWS region (default: us-west-2)"
  echo "  --help             Show this help message"
  echo ""
  echo "Examples:"
  echo "  ./scripts/deploy.sh --all                       # Full deployment"
  echo "  ./scripts/deploy.sh --seed --upload             # Regenerate and upload data"
  echo "  ./scripts/deploy.sh --lambda --gateway-target   # Deploy Lambda + wire to gateway"
  echo "  ./scripts/deploy.sh --clean                     # Tear down everything"
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
    --batch-async)     DO_BATCH_ASYNC=true; NO_FLAGS=false; shift ;;
    --guardrail)       DO_GUARDRAIL=true; NO_FLAGS=false; shift ;;
    --status)          DO_STATUS=true; NO_FLAGS=false; shift ;;
    --clean)           DO_CLEAN=true; NO_FLAGS=false; shift ;;
    --region)          REGION="$2"; shift 2 ;;
    --help|-h)         show_help; exit 0 ;;
    *)                 echo "Unknown option: $1"; show_help; exit 1 ;;
  esac
done

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

create_zip() {
  # Cross-platform zip creation (macOS/Linux zip, Windows 7-Zip)
  # Usage: create_zip <output.zip> <file1> <file2> ...
  local output="$1"
  shift
  local files=("$@")

  # Remove existing zip file to avoid appending
  rm -f "$output"

  # Detect if `zip` is actually 7-Zip in disguise (some Windows users alias/symlink).
  # Info-ZIP banner includes "Info-ZIP"; 7-Zip banner includes "7-Zip".
  # Calling with no args prints the banner for both tools.
  local zip_is_7z=false
  if command -v zip >/dev/null 2>&1; then
    if zip 2>&1 | head -3 | grep -qi "7-zip"; then
      zip_is_7z=true
    fi
  fi

  if command -v zip >/dev/null 2>&1 && [ "$zip_is_7z" = false ]; then
    zip -qr "$output" "${files[@]}"
  elif [ "$zip_is_7z" = true ]; then
    # `zip` resolves to 7-Zip - call it with 7z syntax
    zip a -tzip "$output" "${files[@]}" > /dev/null 2>&1
  elif command -v 7z >/dev/null 2>&1; then
    7z a -tzip "$output" "${files[@]}" > /dev/null 2>&1
  elif [[ -f "/c/Program Files/7-Zip/7z.exe" ]]; then
    "/c/Program Files/7-Zip/7z.exe" a -tzip "$output" "${files[@]}" > /dev/null 2>&1
  elif [[ -f "/c/Program Files (x86)/7-Zip/7z.exe" ]]; then
    "/c/Program Files (x86)/7-Zip/7z.exe" a -tzip "$output" "${files[@]}" > /dev/null 2>&1
  else
    echo "  ❌ Error: Neither zip nor 7z found."
    echo "  On Windows, install 7-Zip from https://7-zip.org/"
    echo "  On macOS/Linux, install zip via your package manager."
    return 1
  fi
}

print_banner() {
  resolve_account
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║   Party Supply Chat Agent - Deployment                      ║"
  echo "╠══════════════════════════════════════════════════════════════╣"
  echo "║  Region:         ${REGION}"
  echo "║  Account:        ${ACCOUNT_ID}"
  echo "║  Vector Bucket:  ${VECTOR_BUCKET_NAME}"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""

  # Bootstrap agentcore.json from the committed example if missing.
  # The real file is gitignored because deploy.sh rewrites it with
  # account-specific resource IDs after each deploy.
  if [ ! -f "agentcore/agentcore.json" ] && [ -f "agentcore/agentcore.json.example" ]; then
    echo "  Bootstrapping agentcore/agentcore.json from agentcore.json.example..."
    cp agentcore/agentcore.json.example agentcore/agentcore.json
  fi

  # Install root dependencies if missing
  if [ ! -d "node_modules" ]; then
    echo "  Installing root dependencies..."
    npm install
  fi

  # Auto-generate aws-targets.json from current credentials
  cat > agentcore/aws-targets.json <<EOF
[
  {
    "name": "default",
    "account": "${ACCOUNT_ID}",
    "region": "${REGION}"
  }
]
EOF
}

# ─── Step: Generate Seed Data ────────────────────────────────────────────────

step_seed() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "[seed] Generating seed data with Titan Text Embeddings V2..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  # Check if all vector files exist (products, orders, customers)
  if [ -f "seed-data/products-vectors.json" ] && \
     [ -f "seed-data/orders-vectors.json" ] && \
     [ -f "seed-data/customers-vectors.json" ]; then
    echo "  Seed data exists. Skipping. (Delete seed-data/*.json to regenerate)"
  else
    AWS_REGION="${REGION}" npx --yes tsx scripts/generate-seed-data.ts
  fi
  echo ""
}

# ─── Step: Create S3 Vector Bucket & Indexes ─────────────────────────────────

step_vectors() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "[vectors] Creating S3 Vector bucket and indexes..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Check if vectors already have data - skip if so to avoid data loss
  EXISTING_DATA=$(aws s3vectors get-vectors --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
    --index-name "products-index" --keys '["prod-1"]' \
    --region "${REGION}" --query "vectors | length(@)" --output text 2>/dev/null || echo "0")

  if [ "$EXISTING_DATA" != "0" ] && [ -n "$EXISTING_DATA" ]; then
    echo "  Vector indexes already contain data. Skipping to preserve existing data."
    echo "  (Use --clean first if you want to recreate indexes)"
    return 0
  fi

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

  echo "  Creating customers-index..."
  aws s3vectors create-index \
    --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
    --index-name "customers-index" \
    --dimension 1024 --distance-metric "cosine" --data-type "float32" \
    --region "${REGION}" 2>/dev/null || echo "  (already exists)"

  echo "  Waiting for indexes to become active..."
  for idx_name in "products-index" "orders-index" "customers-index"; do
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

  # Check if vectors already have data - skip upload if so
  EXISTING_DATA=$(aws s3vectors get-vectors --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
    --index-name "products-index" --keys '["prod-1"]' \
    --region "${REGION}" --query "vectors | length(@)" --output text 2>/dev/null || echo "0")

  if [ "$EXISTING_DATA" != "0" ] && [ -n "$EXISTING_DATA" ]; then
    echo "  Vector indexes already contain data. Skipping upload."
    echo "  (Use --clean first if you want to re-upload)"
    return 0
  fi

  echo "  Uploading product vectors..."
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

  # Upload customers if file exists
  if [ -f "seed-data/customers-vectors.json" ]; then
    echo "  Uploading customer vectors..."
    node --input-type=module -e "
import { readFileSync } from 'fs';
import { S3VectorsClient, PutVectorsCommand } from '@aws-sdk/client-s3vectors';
const client = new S3VectorsClient({ region: '${REGION}' });
const data = JSON.parse(readFileSync('seed-data/customers-vectors.json', 'utf-8'));
for (let i = 0; i < data.vectors.length; i += 10) {
  const batch = data.vectors.slice(i, i + 10);
  await client.send(new PutVectorsCommand({
    vectorBucketName: '${VECTOR_BUCKET_NAME}', indexName: 'customers-index',
    vectors: batch.map(v => ({ key: v.key, data: { float32: v.vector }, metadata: v.metadata })),
  }));
  console.log('    Uploaded customers batch ' + (Math.floor(i/10) + 1));
}
console.log('  Customers: done');
"
  else
    echo "  Skipping customers (no customers-vectors.json found)"
  fi
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
  echo "  Validating configuration..."
  npx agentcore validate
  echo "  Deploying (container build via CodeBuild, ~3-5 min)..."
  agentcore deploy --yes

  # Fetch actual Memory ID and update agentcore.json if needed
  echo "  Checking Memory ID..."
  MEMORY_ID=$(aws bedrock-agentcore-control list-memories --region "${REGION}" \
    --query "memories[?contains(id, 'PartySupply_PartySupplyMemory')].id | [0]" \
    --output text 2>/dev/null || echo "")
  if [ -n "$MEMORY_ID" ] && [ "$MEMORY_ID" != "None" ]; then
    # Check if agentcore.json needs updating
    CURRENT_MEMORY_ID=$(grep -o '"MEMORY_ID"[^}]*"value"[^"]*"[^"]*"' agentcore/agentcore.json 2>/dev/null | grep -o '"value"[^"]*"[^"]*"' | cut -d'"' -f4 || echo "")
    if [ "$CURRENT_MEMORY_ID" != "$MEMORY_ID" ]; then
      echo "  Memory ID changed: $CURRENT_MEMORY_ID -> $MEMORY_ID"
      if command -v jq >/dev/null 2>&1; then
        jq --arg mid "$MEMORY_ID" '.runtimes[0].envVars = [.runtimes[0].envVars[] | if .name == "MEMORY_ID" then .value = $mid else . end]' agentcore/agentcore.json > agentcore/agentcore.json.tmp && mv agentcore/agentcore.json.tmp agentcore/agentcore.json
        echo "  Updated agentcore.json with Memory ID: $MEMORY_ID"
        echo "  Re-deploying agent with updated Memory ID..."
        agentcore deploy --yes
      else
        echo "  WARNING: jq not installed. Please manually update MEMORY_ID in agentcore/agentcore.json to: $MEMORY_ID"
      fi
    else
      echo "  Memory ID is current: $MEMORY_ID"
    fi
  else
    echo "  Warning: Could not fetch Memory ID (memory may not be deployed yet)"
  fi

  # Add RAG + Memory + Guardrail permissions to the runtime execution role
  echo "  Adding RAG, Memory, and Guardrail permissions to runtime role..."
  RUNTIME_ROLE=$(aws cloudformation describe-stack-resources \
    --stack-name AgentCore-PartySupply-default --region "${REGION}" \
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
      }" 2>/dev/null && echo "  RAG/Memory permissions added." || echo "  (could not update RAG/Memory permissions)"

    # Add Guardrail permissions (required if using Bedrock Guardrails)
    aws iam put-role-policy --role-name "$RUNTIME_ROLE" --policy-name "GuardrailAccess" \
      --policy-document "{
        \"Version\": \"2012-10-17\",
        \"Statement\": [{
          \"Effect\": \"Allow\",
          \"Action\": [\"bedrock:ApplyGuardrail\", \"bedrock:GetGuardrail\"],
          \"Resource\": \"arn:aws:bedrock:${REGION}:${ACCOUNT_ID}:guardrail/*\"
        }]
      }" 2>/dev/null && echo "  Guardrail permissions added." || echo "  (could not update Guardrail permissions)"
  fi

  echo ""
}

# ─── Step: Deploy Guardrail (Separate CDK) ───────────────────────────────────

step_guardrail() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "[guardrail] Deploying Bedrock Guardrail via CDK..."
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  local CDK_DIR="guardrail-cdk"

  # Install CDK dependencies
  echo "  Installing CDK dependencies..."
  if [[ ! -d "${CDK_DIR}/node_modules" ]]; then
    (cd "$CDK_DIR" && npm install --quiet)
  fi

  # Deploy guardrail CDK stack
  echo "  Deploying guardrail stack..."
  (cd "$CDK_DIR" && npx cdk deploy --require-approval never)

  # Fetch Guardrail ID and Version from CDK stack outputs
  GUARDRAIL_ID=$(aws cloudformation describe-stacks \
    --stack-name PartySupply-Guardrail --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='GuardrailId'].OutputValue | [0]" \
    --output text 2>/dev/null || echo "")
  GUARDRAIL_VERSION=$(aws cloudformation describe-stacks \
    --stack-name PartySupply-Guardrail --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='GuardrailVersion'].OutputValue | [0]" \
    --output text 2>/dev/null || echo "")

  if [ -z "$GUARDRAIL_ID" ] || [ "$GUARDRAIL_ID" = "None" ]; then
    echo "  ❌ Failed to get guardrail ID from stack outputs."
    return 1
  fi

  echo "  Guardrail deployed: ${GUARDRAIL_ID} v${GUARDRAIL_VERSION}"

  # Check if jq is available
  if ! command -v jq >/dev/null 2>&1; then
    echo "  WARNING: jq not installed. Please manually add to agentcore/agentcore.json envVars:"
    echo "    {\"name\": \"GUARDRAIL_ID\", \"value\": \"${GUARDRAIL_ID}\"}"
    echo "    {\"name\": \"GUARDRAIL_VERSION\", \"value\": \"${GUARDRAIL_VERSION}\"}"
    return 0
  fi

  # Update agentcore.json with guardrail env vars
  CURRENT_GUARDRAIL_ID=$(grep -o '"GUARDRAIL_ID"' agentcore/agentcore.json 2>/dev/null || echo "")

  if [ -z "$CURRENT_GUARDRAIL_ID" ]; then
    # Add guardrail env vars
    jq --arg gid "$GUARDRAIL_ID" --arg gv "$GUARDRAIL_VERSION" \
      '.runtimes[0].envVars += [{"name": "GUARDRAIL_ID", "value": $gid}, {"name": "GUARDRAIL_VERSION", "value": $gv}]' \
      agentcore/agentcore.json > agentcore/agentcore.json.tmp && mv agentcore/agentcore.json.tmp agentcore/agentcore.json
    echo "  Added guardrail env vars to agentcore.json"
  else
    # Update existing guardrail env vars (check both ID and VERSION)
    EXISTING_GID=$(jq -r '.runtimes[0].envVars[] | select(.name == "GUARDRAIL_ID") | .value' agentcore/agentcore.json 2>/dev/null || echo "")
    EXISTING_GV=$(jq -r '.runtimes[0].envVars[] | select(.name == "GUARDRAIL_VERSION") | .value' agentcore/agentcore.json 2>/dev/null || echo "")
    if [ "$EXISTING_GID" != "$GUARDRAIL_ID" ] || [ "$EXISTING_GV" != "$GUARDRAIL_VERSION" ]; then
      jq --arg gid "$GUARDRAIL_ID" --arg gv "$GUARDRAIL_VERSION" \
        '.runtimes[0].envVars = [.runtimes[0].envVars[] | if .name == "GUARDRAIL_ID" then .value = $gid elif .name == "GUARDRAIL_VERSION" then .value = $gv else . end]' \
        agentcore/agentcore.json > agentcore/agentcore.json.tmp && mv agentcore/agentcore.json.tmp agentcore/agentcore.json
      echo "  Updated guardrail env vars in agentcore.json (ID: ${GUARDRAIL_ID}, Version: ${GUARDRAIL_VERSION})"
    else
      echo "  Guardrail env vars already up to date in agentcore.json"
    fi
  fi

  echo ""
  echo "  ════════════════════════════════════════════════════════════════"
  echo "  Guardrail deployed! Run --agent next to deploy with guardrails."
  echo "  ════════════════════════════════════════════════════════════════"
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
  # Verify files exist before zipping
  if [[ ! -f "package.json" ]]; then
    echo "  ❌ Error: lambda/package.json not found"
    exit 1
  fi
  if [[ ! -d "node_modules" ]]; then
    echo "  ❌ Error: lambda/node_modules not found. npm install may have failed."
    exit 1
  fi
  create_zip "../${LAMBDA_ZIP}" index.mjs node_modules package.json || exit 1
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

  # Grant the gateway's execution role permission to invoke the Lambda
  # Two permissions needed:
  # 1. Lambda resource policy (allows the role to call the Lambda)
  # 2. IAM policy on the gateway role (allows the role to invoke Lambda)
  GATEWAY_ID=$(get_gateway_id)
  if [ -n "$GATEWAY_ID" ] && [ "$GATEWAY_ID" != "None" ]; then
    GATEWAY_ROLE_ARN=$(aws bedrock-agentcore-control get-gateway \
      --gateway-identifier "${GATEWAY_ID}" \
      --region "${REGION}" --query "roleArn" --output text 2>/dev/null || echo "")
    if [ -n "$GATEWAY_ROLE_ARN" ] && [ "$GATEWAY_ROLE_ARN" != "None" ]; then
      # Extract role name from ARN
      GATEWAY_ROLE_NAME=$(echo "$GATEWAY_ROLE_ARN" | sed 's/.*role\///')

      # Add Lambda resource policy
      aws lambda add-permission \
        --function-name "${LAMBDA_NAME}" \
        --statement-id "AllowGatewayRole" \
        --action "lambda:InvokeFunction" \
        --principal "arn:aws:iam::${ACCOUNT_ID}:root" \
        --source-arn "${GATEWAY_ROLE_ARN}" \
        --region "${REGION}" 2>/dev/null || echo "  (Lambda resource policy exists)"

      # Add IAM policy to gateway role to invoke Lambda
      aws iam put-role-policy \
        --role-name "${GATEWAY_ROLE_NAME}" \
        --policy-name "InvokeLambda" \
        --policy-document "{
          \"Version\": \"2012-10-17\",
          \"Statement\": [{
            \"Effect\": \"Allow\",
            \"Action\": \"lambda:InvokeFunction\",
            \"Resource\": \"${LAMBDA_ARN}\"
          }]
        }" 2>/dev/null && {
          echo "  Gateway role policy added."
          echo "  Waiting for IAM policy propagation (10s)..."
          sleep 10
        } || echo "  (gateway role policy exists)"
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
    # Ensure gateway role has permission to invoke Lambda before creating target
    echo "  Adding Lambda invoke permission to gateway role..."
    GATEWAY_ROLE_ARN=$(aws bedrock-agentcore-control get-gateway \
      --gateway-identifier "${GATEWAY_ID}" \
      --region "${REGION}" --query "roleArn" --output text 2>/dev/null || echo "")
    if [ -n "$GATEWAY_ROLE_ARN" ] && [ "$GATEWAY_ROLE_ARN" != "None" ]; then
      GATEWAY_ROLE_NAME=$(echo "$GATEWAY_ROLE_ARN" | sed 's/.*role\///')
      aws iam put-role-policy \
        --role-name "${GATEWAY_ROLE_NAME}" \
        --policy-name "InvokeLambda" \
        --policy-document "{
          \"Version\": \"2012-10-17\",
          \"Statement\": [{
            \"Effect\": \"Allow\",
            \"Action\": \"lambda:InvokeFunction\",
            \"Resource\": \"${LAMBDA_ARN}\"
          }]
        }" 2>/dev/null && echo "  Gateway role policy added." || echo "  (gateway role policy exists)"
      echo "  Waiting for IAM policy propagation (10s)..."
      sleep 10
    fi

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
  echo "[status] Deployment status"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  npx agentcore status

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

# ─── Step: Batch Async Processing (CDK) ──────────────────────────────────────

step_batch_async() {
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║   Setting up Batch Async Processing (CDK)                   ║"
  echo "╚══════════════════════════════════════════════════════════════╝"

  local ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  local BUCKET_NAME="party-supply-batch-${ACCOUNT_ID}-${REGION}"
  local CDK_DIR="batch-cdk"

  # 1. Install CDK dependencies
  echo "  Installing CDK dependencies..."
  if [[ ! -d "${CDK_DIR}/node_modules" ]]; then
    (cd "$CDK_DIR" && npm install --quiet)
  fi

  # 2. Install Lambda dependencies
  echo "  Installing Lambda dependencies..."
  if [[ ! -d "scripts/batch-result-lambda/node_modules" ]]; then
    (cd scripts/batch-result-lambda && npm install --omit=dev --quiet)
  fi

  # 3. Create S3 bucket and upload Glue scripts (CDK needs scripts in S3)
  echo "  Preparing S3 bucket for Glue scripts..."
  if ! aws s3api head-bucket --bucket "$BUCKET_NAME" 2>/dev/null; then
    if [[ "$REGION" == "us-east-1" ]]; then
      aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION"
    else
      aws s3api create-bucket --bucket "$BUCKET_NAME" --region "$REGION" \
        --create-bucket-configuration LocationConstraint="$REGION"
    fi
  fi

  aws s3 cp glue-jobs/dedup-prepare.py "s3://${BUCKET_NAME}/glue-scripts/dedup-prepare.py" --quiet
  aws s3 cp glue-jobs/upload-vectors.py "s3://${BUCKET_NAME}/glue-scripts/upload-vectors.py" --quiet

  # 4. Bootstrap CDK if needed
  echo "  Checking CDK bootstrap..."
  if ! aws cloudformation describe-stacks --stack-name CDKToolkit --region "$REGION" 2>/dev/null; then
    echo "  Bootstrapping CDK..."
    (cd "$CDK_DIR" && npx cdk bootstrap "aws://${ACCOUNT_ID}/${REGION}")
  fi

  # 5. Deploy CDK stack
  echo "  Deploying batch processing stack via CDK..."
  (cd "$CDK_DIR" && npx cdk deploy --require-approval never)

  echo ""
  echo "  ════════════════════════════════════════════════════════════════"
  echo "  Batch async processing setup complete!"
  echo ""
  echo "  Flow (orchestrated by Step Functions):"
  echo "    1. Glue ETL (dedup CSV → JSONL)"
  echo "    2. Lambda (submit Bedrock Batch jobs)"
  echo "    3. Step Functions (poll until complete)"
  echo "    4. Lambda (flush index for replace mode)"
  echo "    5. Glue Python Shell (upload to S3 Vectors)"
  echo ""
  echo "  Usage:"
  echo "    ./scripts/batch-import.sh -p products.csv --mode replace"
  echo "    ./scripts/batch-status.sh   # Check progress"
  echo "  ════════════════════════════════════════════════════════════════"
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

# Guardrail must be deployed BEFORE agent so env vars are set in agentcore.json
if [ "$DO_ALL" = true ] || [ "$DO_GUARDRAIL" = true ]; then
  step_guardrail
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

if [ "$DO_BATCH_ASYNC" = true ]; then
  step_batch_async
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
