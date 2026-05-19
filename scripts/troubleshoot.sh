#!/bin/bash
set -euo pipefail

# ─── Party Supply Chat Agent - Troubleshooting Script ────────────────────────
# Diagnoses common deployment issues and checks CloudWatch logs

REGION="${AWS_REGION:-us-west-2}"
STACK_SUFFIX="${STACK_SUFFIX:-}"
DEPLOYMENT_TARGET="default"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --suffix) STACK_SUFFIX="$2"; shift 2 ;;
    *)        shift ;;
  esac
done

# Apply suffix-aware naming
SUFFIX_CAMEL=""
VECTOR_BUCKET_NAME="party-supply-vectors"
LAMBDA_NAME="party-supply-gateway-handler"
PROJECT_NAME="PartySupply"
AGENT_NAME="PartySupplyAgent"
MEMORY_NAME="PartySupplyMemory"

if [ -n "$STACK_SUFFIX" ]; then
  DEPLOYMENT_TARGET="$STACK_SUFFIX"
  SUFFIX_CAMEL=$(echo "$STACK_SUFFIX" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')
  VECTOR_BUCKET_NAME="party-supply-vectors-$STACK_SUFFIX"
  LAMBDA_NAME="party-supply-gateway-handler-$STACK_SUFFIX"
  PROJECT_NAME="PartySupply${SUFFIX_CAMEL}"
  AGENT_NAME="PartySupplyAgent${SUFFIX_CAMEL}"
  MEMORY_NAME="PartySupplyMemory${SUFFIX_CAMEL}"
fi

STACK_NAME="AgentCore-${PROJECT_NAME}-${DEPLOYMENT_TARGET}"
export MSYS_NO_PATHCONV=1

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   Party Supply Chat Agent - Troubleshooting                 ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Region:        ${REGION}"
echo "║  Target:        ${DEPLOYMENT_TARGET}"
echo "║  Stack:         ${STACK_NAME}"
echo "║  Vector bucket: ${VECTOR_BUCKET_NAME}"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

PROBLEMS=()

# ─── 1. Runtime Status ───────────────────────────────────────────────────────
echo "[1/8] Checking runtime status..."
RUNTIME_STATUS=$(npx agentcore status --target "${DEPLOYMENT_TARGET}" 2>&1 || echo "")
echo "$RUNTIME_STATUS" | grep -E "(${AGENT_NAME}|status:|Status:)" || echo "  Could not get runtime status"

RUNTIME_ID=$(echo "$RUNTIME_STATUS" | grep -o "${PROJECT_NAME}_${AGENT_NAME}-[a-zA-Z0-9]*" | head -1)
if [ -n "$RUNTIME_ID" ]; then
  echo "  Runtime ID: $RUNTIME_ID"
else
  PROBLEMS+=("Runtime not deployed - run: ./scripts/deploy.sh --agent")
fi
echo ""

# ─── 2. Runtime Environment Variables ────────────────────────────────────────
echo "[2/8] Checking runtime environment variables..."
if [ -n "$RUNTIME_ID" ]; then
  RUNTIME_ARN=$(echo "$RUNTIME_STATUS" | grep -o 'arn:aws:bedrock-agentcore:[^)]*' | head -1)
  if [ -n "$RUNTIME_ARN" ]; then
    RUNTIME_ENV=$(aws bedrock-agentcore-control get-agent-runtime \
      --agent-runtime-id "${RUNTIME_ID}" --region "${REGION}" \
      --query "environmentVariables" --output json 2>/dev/null || echo "{}")

    CONFIGURED_BUCKET=$(echo "$RUNTIME_ENV" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{
        try{const e=JSON.parse(d);console.log(e.VECTOR_BUCKET_NAME||'NOT_SET');}catch(e){console.log('UNKNOWN');}
      });" 2>/dev/null || echo "UNKNOWN")

    CONFIGURED_MEMORY=$(echo "$RUNTIME_ENV" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{
        try{const e=JSON.parse(d);console.log(e.MEMORY_NAME||'NOT_SET');}catch(e){console.log('UNKNOWN');}
      });" 2>/dev/null || echo "UNKNOWN")

    echo "  VECTOR_BUCKET_NAME (runtime): $CONFIGURED_BUCKET"
    echo "  VECTOR_BUCKET_NAME (expected): $VECTOR_BUCKET_NAME"

    if [ "$CONFIGURED_BUCKET" != "$VECTOR_BUCKET_NAME" ] && [ "$CONFIGURED_BUCKET" != "UNKNOWN" ]; then
      echo "  ❌ MISMATCH! Runtime is looking at the wrong bucket."
      PROBLEMS+=("Runtime VECTOR_BUCKET_NAME mismatch (got '$CONFIGURED_BUCKET', expected '$VECTOR_BUCKET_NAME') - redeploy with: ./scripts/deploy.sh --agent --suffix ${STACK_SUFFIX:-}")
    else
      echo "  ✓ Bucket name matches"
    fi

    echo "  MEMORY_NAME (runtime): $CONFIGURED_MEMORY"
    # Memory ID must match pattern: <name>-<10 alphanumeric chars>
    if [[ ! "$CONFIGURED_MEMORY" =~ -[a-zA-Z0-9]{10}$ ]]; then
      echo "  ❌ MEMORY_NAME is not a valid memory ID (must end with -<10chars>)"
      PROBLEMS+=("MEMORY_NAME env var is friendly name not ID - redeploy with: ./scripts/deploy.sh --agent --suffix ${STACK_SUFFIX:-}")
    else
      echo "  ✓ Memory ID format valid"
    fi
  fi
else
  echo "  ⚠️  Skipping - no runtime found"
fi
echo ""

# ─── 3. S3 Vector Bucket & Data ──────────────────────────────────────────────
echo "[3/8] Checking S3 Vector bucket and data..."
if aws s3vectors get-vector-bucket --vector-bucket-name "${VECTOR_BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "  ✓ Bucket exists: ${VECTOR_BUCKET_NAME}"

  # Check if products-index has vectors
  PRODUCT_COUNT=$(node --input-type=module -e "
import { S3VectorsClient, ListVectorsCommand } from '@aws-sdk/client-s3vectors';
const c = new S3VectorsClient({ region: '${REGION}' });
try {
  const r = await c.send(new ListVectorsCommand({ vectorBucketName: '${VECTOR_BUCKET_NAME}', indexName: 'products-index', maxResults: 100 }));
  console.log(r.vectors?.length || 0);
} catch(e) { console.log('ERROR:' + e.name); }
" 2>/dev/null || echo "ERROR")

  ORDER_COUNT=$(node --input-type=module -e "
import { S3VectorsClient, ListVectorsCommand } from '@aws-sdk/client-s3vectors';
const c = new S3VectorsClient({ region: '${REGION}' });
try {
  const r = await c.send(new ListVectorsCommand({ vectorBucketName: '${VECTOR_BUCKET_NAME}', indexName: 'orders-index', maxResults: 100 }));
  console.log(r.vectors?.length || 0);
} catch(e) { console.log('ERROR:' + e.name); }
" 2>/dev/null || echo "ERROR")

  echo "  Products index: ${PRODUCT_COUNT} vectors"
  echo "  Orders index:   ${ORDER_COUNT} vectors"

  if [[ "$PRODUCT_COUNT" == "0" ]] || [[ "$PRODUCT_COUNT" == ERROR* ]]; then
    PROBLEMS+=("Products index empty/missing - run: ./scripts/deploy.sh --upload --suffix ${STACK_SUFFIX:-}")
  fi
  if [[ "$ORDER_COUNT" == "0" ]] || [[ "$ORDER_COUNT" == ERROR* ]]; then
    PROBLEMS+=("Orders index empty/missing - run: ./scripts/deploy.sh --upload --suffix ${STACK_SUFFIX:-}")
  fi
else
  echo "  ❌ Bucket not found: ${VECTOR_BUCKET_NAME}"
  PROBLEMS+=("Vector bucket missing - run: ./scripts/deploy.sh --vectors --upload --suffix ${STACK_SUFFIX:-}")
fi
echo ""

# ─── 4. Memory Resource ──────────────────────────────────────────────────────
echo "[4/8] Checking memory resource..."
MEMORY_INFO=$(echo "$RUNTIME_STATUS" | grep -A 1 "${MEMORY_NAME}:" | head -2 || echo "")
if echo "$MEMORY_INFO" | grep -q "Deployed"; then
  echo "  ✓ Memory deployed: ${MEMORY_NAME}"
else
  echo "  ❌ Memory not deployed: ${MEMORY_NAME}"
  PROBLEMS+=("Memory resource missing - run: ./scripts/deploy.sh --agent --suffix ${STACK_SUFFIX:-}")
fi
echo ""

# ─── 5. Find & Check Runtime Log Group ───────────────────────────────────────
echo "[5/8] Finding runtime log group..."
LOG_GROUP=""
if [ -n "$RUNTIME_ID" ]; then
  LOG_GROUP="/aws/bedrock-agentcore/runtimes/${RUNTIME_ID}-DEFAULT"
  if aws logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" --region "${REGION}" \
       --query "logGroups[0].logGroupName" --output text 2>/dev/null | grep -q "$RUNTIME_ID"; then
    echo "  ✓ Log group: $LOG_GROUP"
  else
    LOG_GROUP=""
  fi
fi
if [ -z "$LOG_GROUP" ]; then
  echo "  ⚠️  Log group not found yet (runtime may not have been invoked)"
fi
echo ""

# ─── 6. Recent Runtime Logs & Errors ─────────────────────────────────────────
echo "[6/8] Checking recent logs (last 30 min)..."
if [ -n "$LOG_GROUP" ]; then
  RECENT_LOGS=$(aws logs tail "$LOG_GROUP" --region "${REGION}" --since 30m --format short 2>/dev/null | tail -30 || echo "")
  if [ -n "$RECENT_LOGS" ]; then
    echo "$RECENT_LOGS"

    # Search for errors
    ERROR_COUNT=$(echo "$RECENT_LOGS" | grep -ci -E "(ERROR|Exception|failed|denied)" || echo "0")
    if [ "$ERROR_COUNT" -gt "0" ] 2>/dev/null; then
      PROBLEMS+=("Errors found in runtime logs - check CloudWatch")
    fi
  else
    echo "  No recent logs"
  fi
else
  echo "  ⚠️  Skipping - no log group"
fi
echo ""

# ─── 7. Lambda & Gateway Wiring ──────────────────────────────────────────────
echo "[7/8] Checking Lambda & Gateway wiring..."
if aws lambda get-function --function-name "${LAMBDA_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  LAMBDA_STATE=$(aws lambda get-function --function-name "${LAMBDA_NAME}" --region "${REGION}" \
    --query "Configuration.State" --output text 2>/dev/null || echo "Unknown")
  echo "  ✓ Lambda: ${LAMBDA_NAME} (${LAMBDA_STATE})"
  if [ "$LAMBDA_STATE" != "Active" ]; then
    PROBLEMS+=("Lambda not Active (${LAMBDA_STATE}) - run: ./scripts/deploy.sh --lambda --suffix ${STACK_SUFFIX:-}")
  fi
else
  echo "  ❌ Lambda not deployed: ${LAMBDA_NAME}"
  PROBLEMS+=("Lambda missing - run: ./scripts/deploy.sh --lambda --suffix ${STACK_SUFFIX:-}")
fi

GATEWAY_ID=$(aws bedrock-agentcore-control list-gateways --region "${REGION}" \
  --query "items[?contains(name, '${PROJECT_NAME}')].gatewayId | [0]" --output text 2>/dev/null || echo "None")

if [ -n "$GATEWAY_ID" ] && [ "$GATEWAY_ID" != "None" ]; then
  echo "  ✓ Gateway: $GATEWAY_ID"
  TARGET_COUNT=$(aws bedrock-agentcore-control list-gateway-targets \
    --gateway-identifier "${GATEWAY_ID}" --region "${REGION}" \
    --query "length(items)" --output text 2>/dev/null || echo "0")
  echo "  Gateway targets: ${TARGET_COUNT}"
  if [ "$TARGET_COUNT" = "0" ] || [ "$TARGET_COUNT" = "None" ]; then
    PROBLEMS+=("Gateway has no Lambda target - run: ./scripts/deploy.sh --gateway-target --suffix ${STACK_SUFFIX:-}")
  fi
else
  echo "  ❌ Gateway not found"
  PROBLEMS+=("Gateway missing - run: ./scripts/deploy.sh --agent --suffix ${STACK_SUFFIX:-}")
fi
echo ""

# ─── 8. IAM Permissions ──────────────────────────────────────────────────────
echo "[8/8] Checking runtime IAM role permissions..."
RUNTIME_ROLE=$(aws cloudformation describe-stack-resources \
  --stack-name "${STACK_NAME}" --region "${REGION}" \
  --query "StackResources[?contains(LogicalResourceId, 'RuntimeExecutionRole')].PhysicalResourceId | [0]" \
  --output text 2>/dev/null || echo "")

if [ -z "$RUNTIME_ROLE" ] || [ "$RUNTIME_ROLE" = "None" ]; then
  echo "  ❌ Could not find runtime execution role"
  PROBLEMS+=("Runtime IAM role missing - stack may have failed")
else
  echo "  ✓ Runtime role: $RUNTIME_ROLE"
  POLICIES=$(aws iam list-role-policies --role-name "$RUNTIME_ROLE" --region "${REGION}" \
    --query "PolicyNames" --output text 2>/dev/null || echo "")
  if echo "$POLICIES" | grep -q "RAGAccess"; then
    echo "    ✓ RAGAccess policy attached"
  else
    echo "    ❌ RAGAccess policy missing (needed for S3 Vectors & Memory)"
    PROBLEMS+=("RAGAccess policy missing - run: ./scripts/deploy.sh --agent --suffix ${STACK_SUFFIX:-}")
  fi
fi
echo ""

# ─── Summary ─────────────────────────────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════════════╗"
if [ ${#PROBLEMS[@]} -eq 0 ]; then
  echo "║   ✓ All checks passed                                        ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
else
  echo "║   ⚠️  ${#PROBLEMS[@]} issue(s) found                                       ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  for i in "${!PROBLEMS[@]}"; do
    echo "  $((i+1)). ${PROBLEMS[$i]}"
  done
fi
