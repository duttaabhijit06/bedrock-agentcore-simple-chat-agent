#!/bin/bash
#
# Batch Import for Large Datasets using Step Functions Orchestration
#
# Starts a Step Functions execution that orchestrates:
#   1. Glue ETL (dedup CSV → JSONL)
#   2. Lambda (submit Bedrock Batch jobs)
#   3. Poll loop (check job status)
#   4. Flush index (replace mode only)
#   5. Glue Python Shell (upload to S3 Vectors)
#
# Prerequisites:
#   Run ./scripts/deploy.sh --batch-async first to set up infrastructure.
#
# Usage:
#   ./scripts/batch-import.sh -p products.csv [options]
#
# Options:
#   -p, --products <file>    Path to products CSV file
#   -c, --customers <file>   Path to customers CSV file
#   --mode <mode>            Upload mode: upsert (default), replace, append
#   --region <region>        AWS region (default: us-west-2)
#   --help                   Show this help message
#
# Example:
#   ./scripts/batch-import.sh -p uploads/products.csv --mode replace
#

set -e
export AWS_PAGER=""

# ─── Configuration ───────────────────────────────────────────────────────────

REGION="${AWS_REGION:-us-west-2}"
PRODUCTS_FILE=""
CUSTOMERS_FILE=""
UPLOAD_MODE="upsert"

# ─── Parse Arguments ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case $1 in
    -p|--products)
      PRODUCTS_FILE="$2"
      shift 2
      ;;
    -c|--customers)
      CUSTOMERS_FILE="$2"
      shift 2
      ;;
    --mode)
      UPLOAD_MODE="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --help|-h)
      head -30 "$0" | tail -28
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$PRODUCTS_FILE" && -z "$CUSTOMERS_FILE" ]]; then
  echo "Error: At least one of --products or --customers must be specified"
  echo "Run with --help for usage"
  exit 1
fi

# ─── Helper Functions ────────────────────────────────────────────────────────

log() {
  echo "[$(date '+%H:%M:%S')] $1"
}

get_account_id() {
  aws sts get-caller-identity --query Account --output text
}

# ─── Start Step Function Execution ───────────────────────────────────────────

start_batch_import() {
  local data_type="$1"
  local csv_file="$2"

  local account_id=$(get_account_id)
  local bucket_name="party-supply-batch-${account_id}-${REGION}"
  local state_machine_arn="arn:aws:states:${REGION}:${account_id}:stateMachine:PartySupplyBatchImport"

  log "Processing ${data_type} from: ${csv_file}"
  log "  Bucket: ${bucket_name}"
  log "  Mode: ${UPLOAD_MODE}"

  # Upload CSV to S3
  local csv_key="uploads/${data_type}/$(basename "$csv_file")"
  log "  Uploading CSV to S3..."
  aws s3 cp "$csv_file" "s3://${bucket_name}/${csv_key}" --region "$REGION"

  # Generate job name with timestamp
  local timestamp=$(date +%Y%m%d-%H%M%S)
  local job_name="party-supply-${data_type}-${timestamp}"
  local output_path="s3://${bucket_name}/prepared/${job_name}/"

  # Build Step Function input
  local sfn_input=$(cat <<EOF
{
  "dataType": "${data_type}",
  "inputPath": "s3://${bucket_name}/${csv_key}",
  "outputPath": "${output_path}",
  "uploadMode": "${UPLOAD_MODE}",
  "jobName": "${job_name}"
}
EOF
)

  # Start Step Function execution
  log "  Starting Step Function execution..."
  local execution_arn=$(aws stepfunctions start-execution \
    --state-machine-arn "$state_machine_arn" \
    --name "${job_name}" \
    --input "$sfn_input" \
    --region "$REGION" \
    --query 'executionArn' \
    --output text)

  log "  Execution started: ${job_name}"
  log ""
  log "  Step Function ARN: ${execution_arn}"
  log ""
  log "  Monitor progress:"
  log "    Console: https://${REGION}.console.aws.amazon.com/states/home?region=${REGION}#/v2/executions/details/${execution_arn}"
  log "    CLI:     aws stepfunctions describe-execution --execution-arn '${execution_arn}' --region ${REGION}"
  log ""
  log "  Check status: ./scripts/batch-status.sh"
  log ""
}

# ─── Main ────────────────────────────────────────────────────────────────────

log "Starting Batch Import (Step Functions)"
log "Region: $REGION"
echo ""

# Process products
if [[ -n "$PRODUCTS_FILE" ]]; then
  if [[ ! -f "$PRODUCTS_FILE" ]]; then
    echo "Error: Products file not found: $PRODUCTS_FILE"
    exit 1
  fi
  start_batch_import "products" "$PRODUCTS_FILE"
fi

# Process customers
if [[ -n "$CUSTOMERS_FILE" ]]; then
  if [[ ! -f "$CUSTOMERS_FILE" ]]; then
    echo "Error: Customers file not found: $CUSTOMERS_FILE"
    exit 1
  fi
  start_batch_import "customers" "$CUSTOMERS_FILE"
fi

log "Batch import initiated!"
