#!/bin/bash
#
# Check Batch Import Job Status
#
# Shows status of Step Function executions and S3 Vectors indexes.
#
# Usage:
#   ./scripts/batch-status.sh              Show recent Step Function executions
#   ./scripts/batch-status.sh --vectors    Show vector index counts
#
# Options:
#   --vectors        Show S3 Vectors index info
#   --region <r>     AWS region (default: us-west-2)
#

set -e
export AWS_PAGER=""

REGION="${AWS_REGION:-us-west-2}"
VECTOR_BUCKET="party-supply-vectors"
STATE_MACHINE_NAME="PartySupplyBatchImport"

# ─── Parse Arguments ─────────────────────────────────────────────────────────

SHOW_VECTORS=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --vectors)
      SHOW_VECTORS=true
      shift
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --help|-h)
      echo "Check Batch Import Status"
      echo ""
      echo "Usage:"
      echo "  ./scripts/batch-status.sh              Show Step Function executions"
      echo "  ./scripts/batch-status.sh --vectors    Show S3 Vectors index info"
      echo ""
      echo "Options:"
      echo "  --vectors        Show S3 Vectors index details"
      echo "  --region <r>     AWS region (default: us-west-2)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# ─── Functions ───────────────────────────────────────────────────────────────

status_emoji() {
  case "$1" in
    "SUCCEEDED") echo "✅" ;;
    "FAILED"|"TIMED_OUT"|"ABORTED") echo "❌" ;;
    "RUNNING") echo "🔄" ;;
    *) echo "❓" ;;
  esac
}

get_account_id() {
  aws sts get-caller-identity --query Account --output text
}

# ─── Show Vectors ────────────────────────────────────────────────────────────

if [[ "$SHOW_VECTORS" == "true" ]]; then
  echo "═══════════════════════════════════════════════════════════════════════════════"
  echo "                        S3 Vectors Index Status"
  echo "═══════════════════════════════════════════════════════════════════════════════"
  echo ""

  for index_name in "products-index" "customers-index"; do
    # Check if index exists and get a sample
    result=$(aws s3vectors list-vectors \
      --vector-bucket-name "$VECTOR_BUCKET" \
      --index-name "$index_name" \
      --region "$REGION" \
      --max-results 1 2>/dev/null || echo "")

    if [[ -n "$result" ]]; then
      has_vectors=$(echo "$result" | jq '.vectors | length')

      # Get index metadata
      index_info=$(aws s3vectors get-index \
        --vector-bucket-name "$VECTOR_BUCKET" \
        --index-name "$index_name" \
        --region "$REGION" 2>/dev/null || echo "{}")

      dimension=$(echo "$index_info" | jq -r '.dimension // "unknown"')

      echo "┌─────────────────────────────────────────────────────────────────────────────"
      echo "│ 📊 ${index_name}"
      echo "├─────────────────────────────────────────────────────────────────────────────"
      if [[ "$has_vectors" == "1" ]]; then
        echo "│   Status:     ✅ Active (contains vectors)"
      else
        echo "│   Status:     ⚠️  Empty (no vectors)"
      fi
      echo "│   Dimension:  ${dimension}"
      echo "│   Bucket:     ${VECTOR_BUCKET}"
      echo "└─────────────────────────────────────────────────────────────────────────────"
    else
      echo "┌─────────────────────────────────────────────────────────────────────────────"
      echo "│ ❓ ${index_name} - Not found"
      echo "└─────────────────────────────────────────────────────────────────────────────"
    fi
    echo ""
  done

  exit 0
fi

# ─── Show Step Function Executions ───────────────────────────────────────────

echo "═══════════════════════════════════════════════════════════════════════════════"
echo "                        Batch Import Status (Step Functions)"
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""

ACCOUNT_ID=$(get_account_id)
STATE_MACHINE_ARN="arn:aws:states:${REGION}:${ACCOUNT_ID}:stateMachine:${STATE_MACHINE_NAME}"

# List recent executions
executions=$(aws stepfunctions list-executions \
  --state-machine-arn "$STATE_MACHINE_ARN" \
  --max-results 10 \
  --region "$REGION" \
  --query 'executions[].{name:name,status:status,startDate:startDate,stopDate:stopDate}' \
  --output json 2>/dev/null || echo "[]")

exec_count=$(echo "$executions" | jq 'length')

if [[ "$exec_count" == "0" ]]; then
  echo "No batch import executions found."
  echo ""
  echo "To start an import, run:"
  echo "  ./scripts/batch-import.sh -p <products.csv> --mode replace"
  exit 0
fi

echo "$executions" | jq -c '.[]' | while read -r exec; do
  name=$(echo "$exec" | jq -r '.name')
  status=$(echo "$exec" | jq -r '.status')
  start_date=$(echo "$exec" | jq -r '.startDate')
  stop_date=$(echo "$exec" | jq -r '.stopDate')

  emoji=$(status_emoji "$status")

  # Extract data type from name (party-supply-products-YYYYMMDD-HHMMSS)
  if [[ "$name" == *"products"* ]]; then
    data_type="Products"
  elif [[ "$name" == *"customers"* ]]; then
    data_type="Customers"
  else
    data_type="Unknown"
  fi

  echo "┌─────────────────────────────────────────────────────────────────────────────"
  echo "│ ${emoji} ${data_type} Import: ${name}"
  echo "├─────────────────────────────────────────────────────────────────────────────"
  echo "│   Status:    ${status}"
  echo "│   Started:   ${start_date}"
  if [[ "$stop_date" != "null" ]]; then
    echo "│   Ended:     ${stop_date}"
  fi

  # If running, show current state
  if [[ "$status" == "RUNNING" ]]; then
    exec_arn="arn:aws:states:${REGION}:${ACCOUNT_ID}:execution:${STATE_MACHINE_NAME}:${name}"

    # Get latest events to determine current step
    latest_event=$(aws stepfunctions get-execution-history \
      --execution-arn "$exec_arn" \
      --reverse-order \
      --max-items 5 \
      --region "$REGION" \
      --query 'events[?type==`TaskStateEntered` || type==`WaitStateEntered` || type==`MapStateEntered`].stateEnteredEventDetails.name' \
      --output text 2>/dev/null | head -1)

    if [[ -n "$latest_event" ]]; then
      echo "│   Current:   ${latest_event}"
    fi
  fi

  echo "└─────────────────────────────────────────────────────────────────────────────"
  echo ""
done

# Show batch job status for running executions
running_count=$(echo "$executions" | jq '[.[] | select(.status == "RUNNING")] | length')
if [[ "$running_count" -gt 0 ]]; then
  echo "───────────────────────────────────────────────────────────────────────────────"
  echo "Active Bedrock Batch Jobs:"
  echo ""

  aws bedrock list-model-invocation-jobs \
    --region "$REGION" \
    --status-equals InProgress \
    --max-results 10 \
    --query 'invocationJobSummaries[].{Name:jobName,Status:status}' \
    --output table 2>/dev/null || echo "  (none)"
  echo ""
fi

echo "───────────────────────────────────────────────────────────────────────────────"
echo "To view vector indexes: ./scripts/batch-status.sh --vectors"
