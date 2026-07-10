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
#   -p, --products <file>      Path to products CSV file
#   -c, --customers <file>     Path to customers CSV file
#   -i, --interactions <file>  Path to interactions CSV file (USER_ID, ITEM_ID,
#                              TIMESTAMP, EVENT_TYPE, EVENT_VALUE, QUANTITY,
#                              PRICE, RECOMMENDATION_ID columns)
#   --mode <mode>              Upload mode: upsert (default), replace, append
#   --region <region>          AWS region (default: us-west-2)
#   --sequential               Wait for each import to finish before starting
#                              the next. Use this when Bedrock's concurrent
#                              invoke-model-jobs quota is tight (default 20/
#                              account/region) - parallel imports otherwise
#                              trigger ServiceQuotaExceededException.
#   --sample-rate <0.0-1.0>    Interactions only: keep a random fraction of
#                              rows (deterministic per USER_ID+ITEM_ID+TS).
#                              Useful for 10M+ event datasets where a
#                              smaller sample still gives strong signal.
#   --since-days <N>           Interactions only: keep rows with TIMESTAMP
#                              (epoch seconds) newer than N days ago.
#                              Recent activity carries most recommender
#                              value; drop older tail.
#   --help                     Show this help message
#
# Example:
#   ./scripts/batch-import.sh -p uploads/products.csv --mode replace
#   ./scripts/batch-import.sh -i uploads/interactions.csv
#   # Serialize imports (safer for tight quotas, ~3x slower):
#   ./scripts/batch-import.sh -p products.csv -c customers.csv -i interactions.csv --sequential
#   # Downsample a 15M-row interactions file to last 90 days + 10% sample:
#   ./scripts/batch-import.sh -i interactions.csv --since-days 90 --sample-rate 0.1
#

set -e
export AWS_PAGER=""

# ─── Configuration ───────────────────────────────────────────────────────────

REGION="${AWS_REGION:-us-west-2}"
PRODUCTS_FILE=""
CUSTOMERS_FILE=""
INTERACTIONS_FILE=""
UPLOAD_MODE="upsert"
# --sequential waits for each Step Functions execution to finish before
# starting the next. Useful when Bedrock's concurrent-invoke-model-jobs
# quota (default 20/account/region) is tight and parallel imports would
# collide with each other or with other batch workloads in the account.
SEQUENTIAL=false
# --sample-rate 0.1 keeps a random 10% of interaction rows.
# --since-days 90 keeps rows with TIMESTAMP (epoch seconds) newer than N days ago.
# Both apply only to the interactions file - product/customer catalogs are
# small enough that full imports are always fine.
SAMPLE_RATE=""
SINCE_DAYS=""

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
    -i|--interactions)
      INTERACTIONS_FILE="$2"
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
    --sequential)
      SEQUENTIAL=true
      shift
      ;;
    --sample-rate)
      SAMPLE_RATE="$2"
      shift 2
      ;;
    --since-days)
      SINCE_DAYS="$2"
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

if [[ -z "$PRODUCTS_FILE" && -z "$CUSTOMERS_FILE" && -z "$INTERACTIONS_FILE" ]]; then
  echo "Error: At least one of --products, --customers, or --interactions must be specified"
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

# ─── Interactions Downsampling ───────────────────────────────────────────────

# Filter an interactions CSV to a smaller row count via --sample-rate
# and/or --since-days. Writes the filtered CSV to a temp file and echoes
# the temp path so the caller can upload it. Returns the original path
# unchanged when neither filter is specified.
#
# --sample-rate FLOAT (0.0 - 1.0): keep rows via a stable pseudo-random
#   hash on USER_ID+ITEM_ID+TIMESTAMP so re-runs are reproducible.
# --since-days N: keep rows whose TIMESTAMP (epoch seconds) is within
#   the last N days.
downsample_interactions() {
  local input_csv="$1"
  if [[ -z "$SAMPLE_RATE" && -z "$SINCE_DAYS" ]]; then
    echo "$input_csv"
    return 0
  fi

  local tmp_csv
  tmp_csv="$(mktemp -t interactions-downsampled.XXXXXX.csv 2>/dev/null || echo "/tmp/interactions-downsampled-$$.csv")"

  local cutoff_epoch=""
  if [[ -n "$SINCE_DAYS" ]]; then
    local now_epoch
    now_epoch=$(date +%s)
    cutoff_epoch=$(( now_epoch - SINCE_DAYS * 86400 ))
  fi

  log "  Downsampling interactions: sample-rate=${SAMPLE_RATE:-1.0} since-days=${SINCE_DAYS:-all}"

  # awk pass: locate USER_ID, ITEM_ID, TIMESTAMP columns from the header,
  # then apply the two filters. Uses awk's srand+rand for sampling but
  # seeds from a stable hash on the composite key so the same input row
  # is always kept or dropped across re-runs. Since awk lacks a hash
  # function, we approximate with sum-of-chars mod 100000 - good enough
  # for a coarse sample.
  awk -F',' -v OFS=',' \
    -v rate="${SAMPLE_RATE:-1.0}" \
    -v cutoff="${cutoff_epoch}" '
    NR == 1 {
      for (i = 1; i <= NF; i++) {
        h = $i; gsub(/[\r"]/, "", h)
        if (h == "USER_ID") uc = i
        else if (h == "ITEM_ID") ic = i
        else if (h == "TIMESTAMP") tc = i
      }
      print
      next
    }
    {
      keep = 1
      # since-days filter
      if (cutoff != "") {
        ts = $tc + 0
        if (ts < cutoff) keep = 0
      }
      # sample-rate filter
      if (keep && rate + 0 < 1.0) {
        key = $uc $ic $tc
        s = 0
        for (i = 1; i <= length(key); i++) s += (i * 31) % 100003
        bucket = (s % 100000) / 100000.0
        if (bucket >= rate + 0) keep = 0
      }
      if (keep) print
    }
  ' "$input_csv" > "$tmp_csv"

  local original_rows filtered_rows
  original_rows=$(( $(wc -l < "$input_csv") - 1 ))
  filtered_rows=$(( $(wc -l < "$tmp_csv") - 1 ))
  log "  Downsampled: ${original_rows} → ${filtered_rows} rows"

  echo "$tmp_csv"
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

  # In sequential mode, block on this execution before returning so the
  # caller (main loop below) only starts the next data type after this
  # one finishes. Keeps concurrent Bedrock Batch job count as low as
  # possible for accounts with tight invoke-model quotas.
  if [[ "$SEQUENTIAL" == true ]]; then
    log "  --sequential: waiting for this execution to finish..."
    local status="RUNNING"
    while [[ "$status" == "RUNNING" ]]; do
      sleep 60
      status=$(aws stepfunctions describe-execution \
        --execution-arn "$execution_arn" \
        --region "$REGION" \
        --query 'status' --output text 2>/dev/null || echo "RUNNING")
      log "    status: $status"
    done
    if [[ "$status" != "SUCCEEDED" ]]; then
      log "  Execution finished with status: $status - aborting remaining imports"
      exit 1
    fi
    log "  ${data_type} import complete."
    log ""
  fi
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

# Process interactions
if [[ -n "$INTERACTIONS_FILE" ]]; then
  if [[ ! -f "$INTERACTIONS_FILE" ]]; then
    echo "Error: Interactions file not found: $INTERACTIONS_FILE"
    exit 1
  fi
  # Apply optional --sample-rate / --since-days filters. Produces a
  # temp CSV if either flag is set; otherwise returns the input path.
  INTERACTIONS_UPLOAD=$(downsample_interactions "$INTERACTIONS_FILE")
  start_batch_import "interactions" "$INTERACTIONS_UPLOAD"
fi

log "Batch import initiated!"
