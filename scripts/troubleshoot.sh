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
echo "[1/9] Checking runtime status..."
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
echo "[2/9] Checking runtime environment variables..."
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
echo "[3/9] Checking S3 Vector bucket and data..."
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
echo "[4/9] Checking memory resource..."
MEMORY_INFO=$(echo "$RUNTIME_STATUS" | grep -A 1 "${MEMORY_NAME}:" | head -2 || echo "")
if echo "$MEMORY_INFO" | grep -q "Deployed"; then
  echo "  ✓ Memory deployed: ${MEMORY_NAME}"
else
  echo "  ❌ Memory not deployed: ${MEMORY_NAME}"
  PROBLEMS+=("Memory resource missing - run: ./scripts/deploy.sh --agent --suffix ${STACK_SUFFIX:-}")
fi
echo ""

# ─── 5. Find & Check Runtime Log Group ───────────────────────────────────────
echo "[5/9] Finding runtime log group..."
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
echo "[6/9] Checking recent logs (last 30 min)..."
if [ -n "$LOG_GROUP" ]; then
  RECENT_LOGS=$(aws logs tail "$LOG_GROUP" --region "${REGION}" --since 30m --format short 2>/dev/null | tail -50 || echo "")
  if [ -n "$RECENT_LOGS" ]; then
    echo "$RECENT_LOGS"

    # Detect HTTP 500s (statusCode pattern)
    HTTP_500S=$(echo "$RECENT_LOGS" | grep -c '"statusCode":500' || true)
    if [ "$HTTP_500S" -gt "0" ] 2>/dev/null; then
      PROBLEMS+=("Runtime returned ${HTTP_500S} HTTP 500 response(s) - check logs for [handler] / [agent] error lines")
    fi

    # Detect explicit error markers (added by our error logging in agent.ts)
    HANDLER_ERRORS=$(echo "$RECENT_LOGS" | grep -E "\[handler\] Unhandled|\[agent\] invoke failed|\[memory\]" | tail -5 || true)
    if [ -n "$HANDLER_ERRORS" ]; then
      echo ""
      echo "  ⚠️  Application errors detected:"
      echo "$HANDLER_ERRORS" | sed 's/^/    /'
      PROBLEMS+=("Application errors logged - see [handler]/[agent] lines above")
    fi

    # Generic error scan
    GENERIC_ERRORS=$(echo "$RECENT_LOGS" | grep -ciE "(ERROR|Exception|denied|throttl)" || true)
    if [ "$GENERIC_ERRORS" -gt "0" ] 2>/dev/null && [ -z "$HANDLER_ERRORS" ] && [ "$HTTP_500S" -eq "0" ]; then
      PROBLEMS+=("Generic errors found in runtime logs (${GENERIC_ERRORS} occurrences) - check CloudWatch")
    fi
  else
    echo "  No recent logs (runtime may not have been invoked yet)"
  fi
else
  echo "  ⚠️  Skipping - no log group"
fi
echo ""

# ─── 6b. Live Invocation Test ─────────────────────────────────────────────────
echo "[7/9] Live invocation test..."
if [ -n "$RUNTIME_ID" ]; then
  TEST_PAYLOAD='{"prompt":"ping"}'
  TEST_OUT=$(aws bedrock-agentcore invoke-agent-runtime \
    --agent-runtime-arn "arn:aws:bedrock-agentcore:${REGION}:$(aws sts get-caller-identity --query Account --output text 2>/dev/null):runtime/${RUNTIME_ID}" \
    --payload "$TEST_PAYLOAD" \
    --content-type "application/json" \
    --region "${REGION}" \
    /tmp/agent-test-response.json 2>&1 || true)

  if echo "$TEST_OUT" | grep -qi "error\|exception"; then
    echo "  ❌ Invocation returned error:"
    echo "$TEST_OUT" | head -5 | sed 's/^/    /'
    PROBLEMS+=("Live agent invocation failed")
  elif [ -f /tmp/agent-test-response.json ]; then
    RESP=$(cat /tmp/agent-test-response.json 2>/dev/null | head -c 300)
    if echo "$RESP" | grep -qi "error\|encountered"; then
      echo "  ⚠️  Agent returned error response:"
      echo "    $RESP"
      PROBLEMS+=("Agent invoked but returned error in response body")
    else
      echo "  ✓ Agent responded successfully"
      echo "    Response preview: ${RESP:0:150}..."
    fi
    rm -f /tmp/agent-test-response.json
  else
    echo "  ⚠️  Could not test invocation (CLI may not support invoke-agent-runtime)"
  fi
else
  echo "  ⚠️  Skipping - no runtime ID"
fi
echo ""

# ─── 8. Lambda & Gateway Wiring ──────────────────────────────────────────────
echo "[8/9] Checking Lambda & Gateway wiring..."
if aws lambda get-function --function-name "${LAMBDA_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  LAMBDA_STATE=$(aws lambda get-function --function-name "${LAMBDA_NAME}" --region "${REGION}" \
    --query "Configuration.State" --output text 2>/dev/null || echo "Unknown")
  echo "  ✓ Lambda: ${LAMBDA_NAME} (${LAMBDA_STATE})"
  if [ "$LAMBDA_STATE" != "Active" ]; then
    PROBLEMS+=("Lambda not Active (${LAMBDA_STATE}) - run: ./scripts/deploy.sh --lambda --suffix ${STACK_SUFFIX:-}")
  fi

  # Check Lambda recent error logs
  LAMBDA_LG="/aws/lambda/${LAMBDA_NAME}"
  LAMBDA_ERRORS=$(aws logs filter-log-events --log-group-name "$LAMBDA_LG" --region "${REGION}" \
    --start-time $(node -e "console.log(Date.now() - 30*60*1000)") \
    --filter-pattern "ERROR" --query "events[*].message" --output text 2>/dev/null | head -5 || true)
  if [ -n "$LAMBDA_ERRORS" ]; then
    echo "  ⚠️  Lambda errors found in last 30m:"
    echo "$LAMBDA_ERRORS" | head -3 | sed 's/^/    /'
    PROBLEMS+=("Lambda has errors in CloudWatch logs - check ${LAMBDA_LG}")
  else
    echo "  ✓ No recent Lambda errors"
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

# ─── 9. IAM Permissions & Bedrock Model Access ───────────────────────────────
echo "[9/9] Checking runtime IAM role and Bedrock model access..."
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

# Bedrock model access check
echo "  Checking Bedrock model access (Claude Sonnet 4.5)..."
MODEL_ID="us.anthropic.claude-sonnet-4-5-20250929-v1:0"
MODEL_TEST=$(aws bedrock-runtime invoke-model \
  --model-id "$MODEL_ID" \
  --content-type "application/json" \
  --accept "application/json" \
  --body "$(echo '{"anthropic_version":"bedrock-2023-05-31","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' | base64 -w 0 2>/dev/null || echo '{"anthropic_version":"bedrock-2023-05-31","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' | base64)" \
  --region "${REGION}" \
  /tmp/bedrock-test.json 2>&1 || true)

if echo "$MODEL_TEST" | grep -qi "AccessDenied\|not authorized\|not enabled"; then
  echo "    ❌ Cannot invoke ${MODEL_ID}"
  echo "    ${MODEL_TEST}" | head -2 | sed 's/^/      /'
  PROBLEMS+=("Bedrock model access denied for ${MODEL_ID} - enable in Bedrock console")
elif echo "$MODEL_TEST" | grep -qi "throttl"; then
  echo "    ⚠️  Throttled (model is accessible but rate-limited)"
elif [ -f /tmp/bedrock-test.json ]; then
  echo "    ✓ Model is accessible"
  rm -f /tmp/bedrock-test.json
else
  echo "    ⚠️  Could not verify model access"
fi

# Titan embedding model check
echo "  Checking Bedrock model access (Titan Embed V2)..."
EMBED_TEST=$(aws bedrock-runtime invoke-model \
  --model-id "amazon.titan-embed-text-v2:0" \
  --content-type "application/json" \
  --accept "application/json" \
  --body "$(echo '{"inputText":"test"}' | base64 -w 0 2>/dev/null || echo '{"inputText":"test"}' | base64)" \
  --region "${REGION}" \
  /tmp/embed-test.json 2>&1 || true)

if echo "$EMBED_TEST" | grep -qi "AccessDenied\|not authorized\|not enabled"; then
  echo "    ❌ Cannot invoke Titan Embed V2"
  PROBLEMS+=("Titan Embed V2 access denied - enable in Bedrock console (needed for seed data)")
elif [ -f /tmp/embed-test.json ]; then
  echo "    ✓ Titan Embed V2 accessible"
  rm -f /tmp/embed-test.json
else
  echo "    ⚠️  Could not verify Titan access"
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
