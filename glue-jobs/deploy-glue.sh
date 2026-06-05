#!/bin/bash
#
# Deploy Glue Jobs for Batch Processing
#
# Creates:
#   - Glue ETL Job: Deduplication and JSONL preparation
#   - Glue Python Shell Job: Upload vectors to S3 Vectors
#   - IAM Role for Glue jobs
#
# Usage:
#   ./glue-jobs/deploy-glue.sh [--region <region>]
#

set -e
export AWS_PAGER=""

REGION="${AWS_REGION:-us-west-2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUCKET_NAME="party-supply-batch"
ROLE_NAME="PartySupplyGlueRole"

# ─── Parse Arguments ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case $1 in
    --region)
      REGION="$2"
      shift 2
      ;;
    --help|-h)
      echo "Deploy Glue Jobs for Batch Processing"
      echo ""
      echo "Usage:"
      echo "  ./glue-jobs/deploy-glue.sh [--region <region>]"
      echo ""
      echo "Options:"
      echo "  --region <region>   AWS region (default: us-west-2)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "Deploying Glue jobs to account $ACCOUNT_ID in $REGION"

# ─── Create IAM Role ─────────────────────────────────────────────────────────

echo ""
echo "Creating IAM role for Glue..."

# Check if role exists
if aws iam get-role --role-name "$ROLE_NAME" 2>/dev/null; then
  echo "  Role $ROLE_NAME already exists"
else
  # Create trust policy
  cat > /tmp/glue-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "glue.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document file:///tmp/glue-trust-policy.json \
    --description "Role for Party Supply Glue jobs"

  echo "  Created role $ROLE_NAME"
fi

# Attach policies
echo "  Attaching policies..."

# Glue service role policy
aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole" 2>/dev/null || true

# Create custom policy for S3 and S3 Vectors access
cat > /tmp/glue-custom-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::${BUCKET_NAME}",
        "arn:aws:s3:::${BUCKET_NAME}/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3vectors:PutVectors",
        "s3vectors:GetVectors",
        "s3vectors:DeleteVectors",
        "s3vectors:ListVectors",
        "s3vectors:QueryVectors",
        "s3vectors:GetIndex",
        "s3vectors:ListIndexes"
      ],
      "Resource": [
        "arn:aws:s3vectors:${REGION}:${ACCOUNT_ID}:bucket/party-supply-vectors",
        "arn:aws:s3vectors:${REGION}:${ACCOUNT_ID}:bucket/party-supply-vectors/index/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws-glue/*"
    }
  ]
}
EOF

POLICY_NAME="PartySupplyGluePolicy"

# Delete existing policy if it exists (to update it)
existing_policy_arn="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"
if aws iam get-policy --policy-arn "$existing_policy_arn" 2>/dev/null; then
  # Detach from role first
  aws iam detach-role-policy --role-name "$ROLE_NAME" --policy-arn "$existing_policy_arn" 2>/dev/null || true
  # Delete all versions except default
  versions=$(aws iam list-policy-versions --policy-arn "$existing_policy_arn" --query 'Versions[?!IsDefaultVersion].VersionId' --output text)
  for v in $versions; do
    aws iam delete-policy-version --policy-arn "$existing_policy_arn" --version-id "$v" 2>/dev/null || true
  done
  aws iam delete-policy --policy-arn "$existing_policy_arn" 2>/dev/null || true
fi

aws iam create-policy \
  --policy-name "$POLICY_NAME" \
  --policy-document file:///tmp/glue-custom-policy.json > /dev/null

aws iam attach-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-arn "arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"

echo "  Policies attached"

# Wait for role to propagate
echo "  Waiting for role propagation..."
sleep 10

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

# ─── Upload Scripts to S3 ────────────────────────────────────────────────────

echo ""
echo "Uploading Glue scripts to S3..."

# Create bucket if needed
if ! aws s3api head-bucket --bucket "$BUCKET_NAME" 2>/dev/null; then
  aws s3api create-bucket \
    --bucket "$BUCKET_NAME" \
    --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION"
  echo "  Created bucket $BUCKET_NAME"
fi

# Upload scripts
aws s3 cp "$SCRIPT_DIR/dedup-prepare.py" "s3://${BUCKET_NAME}/glue-scripts/dedup-prepare.py"
aws s3 cp "$SCRIPT_DIR/upload-vectors.py" "s3://${BUCKET_NAME}/glue-scripts/upload-vectors.py"
echo "  Scripts uploaded"

# ─── Create Glue ETL Job ─────────────────────────────────────────────────────

echo ""
echo "Creating Glue ETL job (dedup-prepare)..."

ETL_JOB_NAME="PartySupplyDedupPrepare"

# Delete existing job if exists
aws glue delete-job --job-name "$ETL_JOB_NAME" 2>/dev/null || true

aws glue create-job \
  --name "$ETL_JOB_NAME" \
  --role "$ROLE_ARN" \
  --command '{
    "Name": "glueetl",
    "ScriptLocation": "s3://'"$BUCKET_NAME"'/glue-scripts/dedup-prepare.py",
    "PythonVersion": "3"
  }' \
  --default-arguments '{
    "--job-language": "python",
    "--enable-metrics": "true",
    "--enable-continuous-cloudwatch-log": "true",
    "--TempDir": "s3://'"$BUCKET_NAME"'/glue-temp/"
  }' \
  --glue-version "4.0" \
  --number-of-workers 2 \
  --worker-type "G.1X" \
  --region "$REGION"

echo "  Created ETL job $ETL_JOB_NAME"

# ─── Create Glue Python Shell Job ────────────────────────────────────────────

echo ""
echo "Creating Glue Python Shell job (upload-vectors)..."

PYTHON_JOB_NAME="PartySupplyUploadVectors"

# Delete existing job if exists
aws glue delete-job --job-name "$PYTHON_JOB_NAME" 2>/dev/null || true

aws glue create-job \
  --name "$PYTHON_JOB_NAME" \
  --role "$ROLE_ARN" \
  --command '{
    "Name": "pythonshell",
    "ScriptLocation": "s3://'"$BUCKET_NAME"'/glue-scripts/upload-vectors.py",
    "PythonVersion": "3.9"
  }' \
  --default-arguments '{
    "--job-language": "python",
    "--enable-continuous-cloudwatch-log": "true",
    "--additional-python-modules": "boto3>=1.28.0"
  }' \
  --max-capacity 1.0 \
  --timeout 120 \
  --region "$REGION"

echo "  Created Python Shell job $PYTHON_JOB_NAME"

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "                        Glue Jobs Deployed Successfully"
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""
echo "Jobs created:"
echo "  1. $ETL_JOB_NAME (Spark ETL - deduplication)"
echo "  2. $PYTHON_JOB_NAME (Python Shell - vector upload)"
echo ""
echo "IAM Role: $ROLE_ARN"
echo "Scripts:  s3://${BUCKET_NAME}/glue-scripts/"
echo ""
echo "Example usage:"
echo ""
echo "  # Run deduplication job"
echo "  aws glue start-job-run --job-name $ETL_JOB_NAME \\"
echo "    --arguments '{\"--data_type\":\"products\",\"--input_path\":\"s3://${BUCKET_NAME}/uploads/products.csv\",\"--output_path\":\"s3://${BUCKET_NAME}/prepared/products\",\"--chunk_size\":\"50000\"}'"
echo ""
echo "  # Run vector upload job (after Bedrock Batch completes)"
echo "  aws glue start-job-run --job-name $PYTHON_JOB_NAME \\"
echo "    --arguments '{\"--data_type\":\"products\",\"--batch_output_path\":\"s3://${BUCKET_NAME}/batch-output/job-xxx/\",\"--raw_data_path\":\"s3://${BUCKET_NAME}/prepared/products/raw/\",\"--vector_bucket\":\"party-supply-vectors\",\"--region\":\"${REGION}\"}'"
echo ""
