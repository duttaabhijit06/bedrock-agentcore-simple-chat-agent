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

if [ -n "$STACK_SUFFIX" ]; then
  DEPLOYMENT_TARGET="$STACK_SUFFIX"
fi

STACK_NAME="AgentCore-PartySupply-${DEPLOYMENT_TARGET}"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   Party Supply Chat Agent - Troubleshooting                 ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Region: ${REGION}"
echo "║  Target: ${DEPLOYMENT_TARGET}"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ─── 1. Check Runtime Status ─────────────────────────────────────────────────
echo "[1/5] Checking runtime status..."
RUNTIME_STATUS=$(npx agentcore status --target "${DEPLOYMENT_TARGET}" 2>&1)
echo "$RUNTIME_STATUS" | grep -E "(PartySupplyAgent|status:|Status:)" || echo "  Could not get runtime status"

# Extract runtime ID from the ARN
RUNTIME_ID=$(echo "$RUNTIME_STATUS" | grep -o 'PartySupply_PartySupplyAgent-[a-zA-Z0-9]*' | head -1)
if [ -n "$RUNTIME_ID" ]; then
  echo "  Runtime ID: $RUNTIME_ID"
fi
echo ""

# ─── 2. Find Runtime Log Group ───────────────────────────────────────────────
echo "[2/5] Finding runtime log group..."
export MSYS_NO_PATHCONV=1

if [ -n "$RUNTIME_ID" ]; then
  # Try to find log group matching the runtime ID
  LOG_GROUP="/aws/bedrock-agentcore/runtimes/${RUNTIME_ID}-DEFAULT"

  # Verify it exists
  if aws logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" --region "${REGION}" --query "logGroups[0].logGroupName" --output text 2>/dev/null | grep -q "$RUNTIME_ID"; then
    echo "  ✓ Log group: $LOG_GROUP"
  else
    echo "  ⚠️  Expected log group not found, searching for most recent..."
    LOG_GROUP=$(aws logs describe-log-groups --region "${REGION}" \
      --log-group-name-prefix "/aws/bedrock-agentcore/runtimes/PartySupply_PartySupplyAgent" \
      --query "sort_by(logGroups[?contains(logGroupName, 'DEFAULT')], &creationTime)[-1].logGroupName" \
      --output text 2>/dev/null | tr -d '\n' | grep -v "None" || echo "")

    if [ -z "$LOG_GROUP" ] || [ "$LOG_GROUP" = "None" ]; then
      echo "  ❌ No runtime log group found"
    else
      echo "  ✓ Log group: $LOG_GROUP"
    fi
  fi
else
  echo "  ❌ Could not determine runtime ID"
  LOG_GROUP=""
fi
echo ""

# ─── 3. Check Recent Runtime Logs ────────────────────────────────────────────
echo "[3/5] Checking recent runtime logs (last 30 minutes)..."
if [ -n "$LOG_GROUP" ] && [ "$LOG_GROUP" != "None" ]; then
  echo "  Fetching logs..."
  aws logs tail "$LOG_GROUP" --region "${REGION}" --since 30m --format short 2>&1 | tail -50 || echo "  No recent logs found"
else
  echo "  ⚠️  Skipping - no log group found"
fi
echo ""

# ─── 4. Check for Runtime Errors ─────────────────────────────────────────────
echo "[4/5] Searching for errors in logs (last 1 hour)..."
if [ -n "$LOG_GROUP" ] && [ "$LOG_GROUP" != "None" ]; then
  ERROR_LOGS=$(aws logs filter-log-events --log-group-name "$LOG_GROUP" --region "${REGION}" \
    --start-time $(date -u -d '1 hour ago' +%s)000 \
    --filter-pattern "ERROR" \
    --query "events[*].[timestamp,message]" \
    --output text 2>/dev/null || echo "")

  if [ -z "$ERROR_LOGS" ]; then
    echo "  ✓ No ERROR level logs found"
  else
    echo "  ❌ Found errors:"
    echo "$ERROR_LOGS" | head -20
  fi
else
  echo "  ⚠️  Skipping - no log group found"
fi
echo ""

# ─── 5. Check Runtime IAM Permissions ────────────────────────────────────────
echo "[5/5] Checking runtime IAM role permissions..."
RUNTIME_ROLE=$(aws cloudformation describe-stack-resources \
  --stack-name "${STACK_NAME}" --region "${REGION}" \
  --query "StackResources[?contains(LogicalResourceId, 'RuntimeExecutionRole')].PhysicalResourceId | [0]" \
  --output text 2>/dev/null || echo "")

if [ -z "$RUNTIME_ROLE" ] || [ "$RUNTIME_ROLE" = "None" ]; then
  echo "  ❌ Could not find runtime execution role"
else
  echo "  ✓ Runtime role: $RUNTIME_ROLE"

  # Check for required policies
  echo "  Checking inline policies..."
  POLICIES=$(aws iam list-role-policies --role-name "$RUNTIME_ROLE" --region "${REGION}" \
    --query "PolicyNames" --output text 2>/dev/null || echo "")

  if echo "$POLICIES" | grep -q "RAGAccess"; then
    echo "    ✓ RAGAccess policy attached"
  else
    echo "    ❌ RAGAccess policy missing (needed for S3 Vectors & Memory)"
  fi
fi
echo ""

# ─── Summary ─────────────────────────────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   Troubleshooting Complete                                   ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  If you see 500 errors:                                      ║"
echo "║  1. Check the runtime logs above for error details           ║"
echo "║  2. Verify RAGAccess policy is attached                      ║"
echo "║  3. Try redeploying: ./scripts/deploy.sh --agent             ║"
echo "╚══════════════════════════════════════════════════════════════╝"
