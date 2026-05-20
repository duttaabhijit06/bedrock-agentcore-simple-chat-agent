#!/bin/bash
set -euo pipefail

# ─── Enable Bedrock Model Access ─────────────────────────────────────────────
# Subscribes the AWS account to Claude Sonnet 4.5 and Titan Embed V2.
# Required once per account before deploying the Party Supply Chat Agent.
#
# Prerequisites:
#   - AWS CLI v2.27.42+ (run: aws --version)
#   - IAM permissions: aws-marketplace:Subscribe, ViewSubscriptions
#     (or attach the AWS managed policy: AmazonBedrockFullAccess)
#
# Usage:
#   ./scripts/enable-model-access.sh
#   AWS_REGION=us-west-2 ./scripts/enable-model-access.sh

REGION="${AWS_REGION:-us-west-2}"
CLAUDE_MODEL="anthropic.claude-sonnet-4-5-20250929-v1:0"
TITAN_MODEL="amazon.titan-embed-text-v2:0"

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   Enable Bedrock Model Access                                ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Region: ${REGION}"
echo "║  Models: Claude Sonnet 4.5, Titan Embed V2"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ─── Helper: check if model is already accessible ────────────────────────────
check_model_status() {
  local model_id="$1"
  aws bedrock get-foundation-model-availability \
    --model-id "$model_id" \
    --region "$REGION" \
    --query "agreementAvailability.status" \
    --output text 2>/dev/null || echo "NOT_AVAILABLE"
}

# ─── Helper: subscribe to a model ────────────────────────────────────────────
subscribe_model() {
  local model_id="$1"
  local model_name="$2"

  echo "[${model_name}]"

  STATUS=$(check_model_status "$model_id")
  if [ "$STATUS" = "AVAILABLE" ]; then
    echo "  ✓ Already subscribed"
    return 0
  fi

  echo "  Status: ${STATUS} - subscribing..."

  # Get offer token
  OFFER_TOKEN=$(aws bedrock list-foundation-model-agreement-offers \
    --model-id "$model_id" \
    --region "$REGION" \
    --query "offers[0].offerToken" \
    --output text 2>/dev/null || echo "")

  if [ -z "$OFFER_TOKEN" ] || [ "$OFFER_TOKEN" = "None" ]; then
    echo "  ❌ Could not get offer token. Check AWS CLI version (need v2.27.42+) and permissions."
    return 1
  fi

  # Create the agreement
  if aws bedrock create-foundation-model-agreement \
    --model-id "$model_id" \
    --offer-token "$OFFER_TOKEN" \
    --region "$REGION" >/dev/null 2>&1; then
    echo "  ✓ Subscription request submitted"
  else
    echo "  ❌ Subscription failed. May need first-time-use form for Anthropic models (see below)."
    return 1
  fi
}

# ─── 1. Anthropic First-Time-Use Form ────────────────────────────────────────
echo "[1/4] Anthropic First-Time-Use Form"
echo "  This is required once per AWS account for Anthropic models."

CLAUDE_STATUS=$(check_model_status "$CLAUDE_MODEL")
if [ "$CLAUDE_STATUS" = "AVAILABLE" ]; then
  echo "  ✓ Already submitted (Claude is accessible)"
else
  echo ""
  read -p "  Enter your company/organization name: " COMPANY_NAME
  read -p "  Enter company website (or GitHub/portfolio URL): " COMPANY_WEBSITE
  read -p "  Industry (e.g., Technology, Retail, Education): " INDUSTRY
  echo "  Briefly describe your use case (one line):"
  read -p "  > " USE_CASES

  FORM_JSON=$(cat <<EOF
{"companyName":"${COMPANY_NAME}","companyWebsite":"${COMPANY_WEBSITE}","intendedUsers":"0","industryOption":"${INDUSTRY}","useCases":"${USE_CASES}"}
EOF
)

  # Base64 encode (handle both Linux and Mac)
  FORM_DATA=$(echo -n "$FORM_JSON" | base64 -w 0 2>/dev/null || echo -n "$FORM_JSON" | base64)

  echo "  Submitting form..."
  if aws bedrock put-use-case-for-model-access \
    --form-data "$FORM_DATA" \
    --region "$REGION" >/dev/null 2>&1; then
    echo "  ✓ Form submitted successfully"
  else
    echo "  ⚠️  Form submission failed - may already be on file (continuing)"
  fi
fi
echo ""

# ─── 2. Subscribe to Claude Sonnet 4.5 ───────────────────────────────────────
echo "[2/4] Subscribe to Claude Sonnet 4.5"
subscribe_model "$CLAUDE_MODEL" "Claude Sonnet 4.5" || true
echo ""

# ─── 3. Subscribe to Titan Embed V2 ──────────────────────────────────────────
echo "[3/4] Subscribe to Titan Embed V2"
subscribe_model "$TITAN_MODEL" "Titan Embed V2" || true
echo ""

# ─── 4. Wait for subscriptions to finalize ───────────────────────────────────
echo "[4/4] Waiting for subscriptions to finalize (up to 2 minutes)..."

for model_pair in "${CLAUDE_MODEL}|Claude Sonnet 4.5" "${TITAN_MODEL}|Titan Embed V2"; do
  IFS='|' read -r model_id model_name <<< "$model_pair"

  echo "  Checking ${model_name}..."
  retries=0
  while [ $retries -lt 24 ]; do
    STATUS=$(check_model_status "$model_id")
    if [ "$STATUS" = "AVAILABLE" ]; then
      echo "    ✓ ${model_name} is AVAILABLE"
      break
    fi
    retries=$((retries + 1))
    sleep 5
  done

  if [ $retries -eq 24 ]; then
    echo "    ⚠️  ${model_name} still not AVAILABLE after 2 minutes - may need more time or manual intervention"
  fi
done
echo ""

# ─── Summary ─────────────────────────────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   Done!                                                      ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Next: ./scripts/deploy.sh --all                             ║"
echo "╚══════════════════════════════════════════════════════════════╝"
