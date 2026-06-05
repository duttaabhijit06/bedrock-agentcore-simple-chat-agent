#!/bin/bash
set -euo pipefail

# ─── Party Supply Chat Agent - Cleanup Script ────────────────────────────────
# Tears down ALL deployed resources in the correct order.
#
# Order matters:
#   1. Delete gateway targets (gateway won't delete with targets attached)
#   2. Wait for target deletion to propagate
#   3. Delete the gateway itself
#   4. Delete Lambda function
#   5. Delete Lambda IAM role + policies
#   6. Delete AgentCore CloudFormation stack (runtime + remaining resources)
#   7. Delete S3 Vectors indexes and bucket
#   8. Clean local artifacts
#
# Usage:
#   ./scripts/cleanup.sh
#   AWS_REGION=us-west-2 ./scripts/cleanup.sh

REGION="${AWS_REGION:-us-west-2}"
VECTOR_BUCKET_NAME="${VECTOR_BUCKET_NAME:-party-supply-vectors}"
LAMBDA_NAME="party-supply-gateway-handler"
LAMBDA_ROLE_NAME="party-supply-lambda-role"
STACK_NAME="AgentCore-PartySupply-default"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   Party Supply Chat Agent - Cleanup                         ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Region: ${REGION}"
echo "║  This will delete ALL deployed resources."
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Delete Gateway Targets ─────────────────────────────────────────
echo "[1/11] Deleting gateway targets..."

GATEWAY_ID=$(aws bedrock-agentcore-control list-gateways --region "${REGION}" \
  --query "items[?contains(name, 'PartySupply')].gatewayId | [0]" \
  --output text 2>/dev/null || echo "None")

if [ -n "$GATEWAY_ID" ] && [ "$GATEWAY_ID" != "None" ]; then
  # List all target IDs and delete each one
  TARGET_IDS=$(aws bedrock-agentcore-control list-gateway-targets \
    --gateway-identifier "${GATEWAY_ID}" \
    --region "${REGION}" \
    --query "items[*].targetId" --output text 2>/dev/null || echo "")

  if [ -n "$TARGET_IDS" ] && [ "$TARGET_IDS" != "None" ]; then
    for tid in $TARGET_IDS; do
      echo "  Deleting target: ${tid}"
      aws bedrock-agentcore-control delete-gateway-target \
        --gateway-identifier "${GATEWAY_ID}" \
        --target-id "${tid}" \
        --region "${REGION}" 2>/dev/null || echo "  (failed or already deleted)"
    done

    # ─── Step 2: Wait for target deletion ────────────────────────────────────
    echo "[2/11] Waiting for target deletion to propagate (15s)..."
    sleep 15

    # Verify targets are gone
    REMAINING=$(aws bedrock-agentcore-control list-gateway-targets \
      --gateway-identifier "${GATEWAY_ID}" \
      --region "${REGION}" \
      --query "length(items)" --output text 2>/dev/null || echo "0")
    if [ "$REMAINING" != "0" ] && [ "$REMAINING" != "None" ]; then
      echo "  ⚠️  ${REMAINING} target(s) still deleting. Waiting another 15s..."
      sleep 15
    fi
  else
    echo "  No targets found."
    echo "[2/11] Skipping wait (no targets)."
  fi

  # ─── Step 3: Delete Gateway ────────────────────────────────────────────────
  echo "[3/11] Deleting gateway: ${GATEWAY_ID}"
  aws bedrock-agentcore-control delete-gateway \
    --gateway-identifier "${GATEWAY_ID}" \
    --region "${REGION}" 2>/dev/null || echo "  (failed or already deleted)"
  echo "  Waiting for gateway deletion (10s)..."
  sleep 10
else
  echo "  No gateway found."
  echo "[2/11] Skipping (no gateway)."
  echo "[3/11] Skipping (no gateway)."
fi

# ─── Step 4: Delete Lambda ───────────────────────────────────────────────────
echo "[4/11] Deleting Lambda function: ${LAMBDA_NAME}"
aws lambda delete-function \
  --function-name "${LAMBDA_NAME}" \
  --region "${REGION}" 2>/dev/null || echo "  (not found)"

# ─── Step 5: Delete Lambda IAM Role ─────────────────────────────────────────
echo "[5/11] Deleting Lambda IAM role: ${LAMBDA_ROLE_NAME}"
# Must delete inline policies and detach managed policies before deleting role
aws iam delete-role-policy \
  --role-name "${LAMBDA_ROLE_NAME}" \
  --policy-name "InvokeAgentCoreRuntime" 2>/dev/null || true
aws iam detach-role-policy \
  --role-name "${LAMBDA_ROLE_NAME}" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole" 2>/dev/null || true
aws iam delete-role \
  --role-name "${LAMBDA_ROLE_NAME}" 2>/dev/null || echo "  (not found)"

# ─── Step 6: Delete CloudFormation Stack ─────────────────────────────────────
echo "[6/11] Deleting CloudFormation stack: ${STACK_NAME}"

# Pre-delete Memory resource (can block stack deletion)
echo "  Pre-deleting Memory resource..."
MEMORY_ID=$(aws bedrock-agentcore-control list-memories --region "${REGION}" \
  --query "items[?contains(name, 'PartySupply')].memoryId | [0]" \
  --output text 2>/dev/null || echo "None")
if [ -n "$MEMORY_ID" ] && [ "$MEMORY_ID" != "None" ]; then
  aws bedrock-agentcore-control delete-memory \
    --memory-id "${MEMORY_ID}" \
    --region "${REGION}" 2>/dev/null || echo "  (memory not found or already deleting)"
  echo "  Memory deletion initiated: ${MEMORY_ID}"
  sleep 5
else
  echo "  No memory resource found."
fi

# Pre-delete ECR repository (images can block deletion)
echo "  Pre-deleting ECR repository..."
aws ecr delete-repository \
  --repository-name "partysupply/partysupplyagent" \
  --force \
  --region "${REGION}" 2>/dev/null || echo "  (ECR repo not found)"

STACK_STATUS=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --region "${REGION}" \
  --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "DOES_NOT_EXIST")

if [ "$STACK_STATUS" != "DOES_NOT_EXIST" ]; then
  aws cloudformation delete-stack \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" 2>/dev/null || true

  echo "  Waiting for stack deletion (this may take 1-2 minutes)..."
  aws cloudformation wait stack-delete-complete \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" 2>/dev/null || echo "  ⚠️  Stack deletion may have failed. Check the AWS Console."
  echo "  Stack deleted."
else
  echo "  Stack does not exist."
fi

# ─── Step 7: Delete Guardrail Stack ─────────────────────────────────────────
echo "[7/11] Deleting Guardrail stack: PartySupply-Guardrail"
GUARDRAIL_STACK_STATUS=$(aws cloudformation describe-stacks \
  --stack-name "PartySupply-Guardrail" \
  --region "${REGION}" \
  --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "DOES_NOT_EXIST")

if [ "$GUARDRAIL_STACK_STATUS" != "DOES_NOT_EXIST" ]; then
  aws cloudformation delete-stack \
    --stack-name "PartySupply-Guardrail" \
    --region "${REGION}" 2>/dev/null || true
  echo "  Waiting for guardrail stack deletion..."
  aws cloudformation wait stack-delete-complete \
    --stack-name "PartySupply-Guardrail" \
    --region "${REGION}" 2>/dev/null || echo "  ⚠️  Stack deletion may have failed."
  echo "  Guardrail stack deleted."
else
  echo "  Guardrail stack does not exist."
fi

# ─── Step 8: Delete Batch Async Stack ────────────────────────────────────────
echo "[8/11] Deleting Batch Async stack: PartySupply-BatchAsync"
BATCH_STACK_STATUS=$(aws cloudformation describe-stacks \
  --stack-name "PartySupply-BatchAsync" \
  --region "${REGION}" \
  --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "DOES_NOT_EXIST")

if [ "$BATCH_STACK_STATUS" != "DOES_NOT_EXIST" ]; then
  aws cloudformation delete-stack \
    --stack-name "PartySupply-BatchAsync" \
    --region "${REGION}" 2>/dev/null || true
  echo "  Waiting for batch async stack deletion..."
  aws cloudformation wait stack-delete-complete \
    --stack-name "PartySupply-BatchAsync" \
    --region "${REGION}" 2>/dev/null || echo "  ⚠️  Stack deletion may have failed."
  echo "  Batch async stack deleted."
else
  echo "  Batch async stack does not exist."
fi

# ─── Step 9: Delete S3 Vectors ───────────────────────────────────────────────
echo "[9/11] Deleting S3 Vectors..."

# Check if bucket exists using list and grep (avoids JMESPath quoting issues across platforms)
BUCKET_EXISTS=$(aws s3vectors list-vector-buckets --region "${REGION}" \
  --output json 2>/dev/null | grep -q "\"vectorBucketName\": \"${VECTOR_BUCKET_NAME}\"" && echo "yes" || echo "no")

if [ "$BUCKET_EXISTS" = "yes" ]; then
  echo "  Deleting indexes..."
  aws s3vectors delete-index \
    --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
    --index-name "products-index" \
    --region "${REGION}" 2>/dev/null || echo "  (products-index not found)"
  aws s3vectors delete-index \
    --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
    --index-name "orders-index" \
    --region "${REGION}" 2>/dev/null || echo "  (orders-index not found)"

  echo "  Deleting vector bucket: ${VECTOR_BUCKET_NAME}"
  aws s3vectors delete-vector-bucket \
    --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
    --region "${REGION}" 2>/dev/null || echo "  (bucket not found or not empty)"
else
  echo "  Vector bucket does not exist."
fi

# ─── Step 10: Delete Batch S3 Bucket ─────────────────────────────────────────
echo "[10/11] Deleting Batch S3 bucket..."
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")
BATCH_BUCKET_NAME="party-supply-batch-${ACCOUNT_ID}-${REGION}"
if aws s3api head-bucket --bucket "$BATCH_BUCKET_NAME" 2>/dev/null; then
  echo "  Emptying bucket: ${BATCH_BUCKET_NAME}"
  aws s3 rm "s3://${BATCH_BUCKET_NAME}" --recursive 2>/dev/null || true
  echo "  Deleting bucket: ${BATCH_BUCKET_NAME}"
  aws s3api delete-bucket --bucket "$BATCH_BUCKET_NAME" --region "${REGION}" 2>/dev/null || echo "  (could not delete)"
else
  echo "  Batch bucket does not exist."
fi

# ─── Step 11: Clean Local Artifacts ──────────────────────────────────────────
echo "[11/11] Cleaning local artifacts..."
rm -f seed-data/*.json
rm -rf agentcore/cdk/cdk.out
rm -rf agentcore/.cli
rm -f chat-ui/.env.local
rm -f /tmp/party-supply-lambda.zip
rm -rf lambda/node_modules
rm -rf node_modules
rm -rf agent/node_modules
rm -rf chat-ui/node_modules
rm -rf agentcore/cdk/node_modules
rm -rf guardrail-cdk/node_modules
rm -rf guardrail-cdk/cdk.out
rm -rf batch-cdk/node_modules
rm -rf batch-cdk/cdk.out
rm -rf scripts/batch-result-lambda/node_modules

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   ✅ Cleanup complete!                                       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
