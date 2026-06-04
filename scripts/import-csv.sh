#!/bin/bash
#
# Import CSV Data for Party Supply Agent
#
# Converts customer product and user profile CSV files into JSON format,
# generates embeddings, and optionally uploads to S3 Vectors.
#
# Usage:
#   ./scripts/import-csv.sh --products products.csv --customers customers.csv
#   ./scripts/import-csv.sh -p products.csv -c customers.csv -g -u
#   ./scripts/import-csv.sh -p products.csv -g -u --mode replace
#
# Options:
#   -p, --products <file>   Path to products CSV file
#   -c, --customers <file>  Path to customers CSV file
#   -o, --output <dir>      Output directory (default: ./seed-data)
#   -g, --generate          Generate embeddings after import
#   -u, --upload            Upload vectors to S3 Vectors (requires -g)
#   --mode <mode>           Upload mode: upsert (default), replace, append
#   --region <region>       AWS region (default: us-west-2)
#   -h, --help              Show this help message
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Default values
PRODUCTS_FILE=""
CUSTOMERS_FILE=""
OUTPUT_DIR="./seed-data"
GENERATE_EMBEDDINGS=false
UPLOAD_VECTORS=false
UPLOAD_MODE="upsert"
REGION="${AWS_REGION:-us-west-2}"
VECTOR_BUCKET_NAME="${VECTOR_BUCKET_NAME:-party-supply-vectors}"

# Print usage
print_usage() {
    echo ""
    echo -e "${BLUE}Import CSV Data for Party Supply Agent${NC}"
    echo ""
    echo "Converts customer product and user profile CSV files into JSON format,"
    echo "generates embeddings, and optionally uploads to S3 Vectors."
    echo ""
    echo -e "${YELLOW}Usage:${NC}"
    echo "  ./scripts/import-csv.sh [options]"
    echo ""
    echo -e "${YELLOW}Options:${NC}"
    echo "  -p, --products <file>   Path to products CSV file"
    echo "  -c, --customers <file>  Path to customers CSV file"
    echo "  -o, --output <dir>      Output directory (default: ./seed-data)"
    echo "  -g, --generate          Generate embeddings after import"
    echo "  -u, --upload            Upload vectors to S3 Vectors (requires -g)"
    echo "  --mode <mode>           Upload mode (default: upsert)"
    echo "                            upsert  - Update existing, add new, keep others"
    echo "                            replace - Delete ALL existing vectors, then insert fresh"
    echo "                            append  - Only insert new keys, skip existing ones"
    echo "  --region <region>       AWS region (default: us-west-2)"
    echo "  -h, --help              Show this help message"
    echo ""
    echo -e "${YELLOW}Examples:${NC}"
    echo "  # Import products only (CSV -> JSON)"
    echo "  ./scripts/import-csv.sh -p data/products.csv"
    echo ""
    echo "  # Import and generate embeddings"
    echo "  ./scripts/import-csv.sh -p products.csv -c customers.csv -g"
    echo ""
    echo "  # Full pipeline: import, generate embeddings, upload to S3 Vectors"
    echo "  ./scripts/import-csv.sh -p products.csv -c customers.csv -g -u"
    echo ""
    echo "  # Replace all existing data with new CSV data"
    echo "  ./scripts/import-csv.sh -p products.csv -c customers.csv -g -u --mode replace"
    echo ""
    echo "  # Append only new records (skip existing)"
    echo "  ./scripts/import-csv.sh -p products.csv -g -u --mode append"
    echo ""
    echo "  # Import to custom output directory"
    echo "  ./scripts/import-csv.sh -p products.csv -o ./my-data"
    echo ""
    echo -e "${YELLOW}CSV Format:${NC}"
    echo "  Products CSV should have headers like:"
    echo "    ITEM_ID, TITLE, DESCRIPTION, PRICE, AVAILABILITY, CATEGORY_L1, ..."
    echo ""
    echo "  Customers CSV should have headers like:"
    echo "    USER_ID, CUSTOMER_TYPE, PREFERRED_THEME, LIFETIME_SPEND, ..."
    echo ""
    echo -e "${YELLOW}Environment Variables:${NC}"
    echo "  AWS_REGION            AWS region (default: us-west-2)"
    echo "  VECTOR_BUCKET_NAME    S3 Vectors bucket name (default: party-supply-vectors)"
    echo ""
}

# Parse arguments
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
        -o|--output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        -g|--generate)
            GENERATE_EMBEDDINGS=true
            shift
            ;;
        -u|--upload)
            UPLOAD_VECTORS=true
            shift
            ;;
        --mode)
            UPLOAD_MODE="$2"
            if [[ "$UPLOAD_MODE" != "upsert" && "$UPLOAD_MODE" != "replace" && "$UPLOAD_MODE" != "append" ]]; then
                echo -e "${RED}Error: Invalid mode '$UPLOAD_MODE'. Must be: upsert, replace, or append${NC}"
                exit 1
            fi
            shift 2
            ;;
        --region)
            REGION="$2"
            shift 2
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        *)
            echo -e "${RED}Error: Unknown option $1${NC}"
            print_usage
            exit 1
            ;;
    esac
done

# Validate inputs
if [[ -z "$PRODUCTS_FILE" && -z "$CUSTOMERS_FILE" ]]; then
    echo -e "${RED}Error: At least one of --products or --customers must be specified${NC}"
    print_usage
    exit 1
fi

# Upload requires generate
if [[ "$UPLOAD_VECTORS" == true && "$GENERATE_EMBEDDINGS" != true ]]; then
    echo -e "${RED}Error: --upload requires --generate (-g) flag${NC}"
    exit 1
fi

# Check if files exist
if [[ -n "$PRODUCTS_FILE" && ! -f "$PRODUCTS_FILE" ]]; then
    echo -e "${RED}Error: Products file not found: $PRODUCTS_FILE${NC}"
    exit 1
fi

if [[ -n "$CUSTOMERS_FILE" && ! -f "$CUSTOMERS_FILE" ]]; then
    echo -e "${RED}Error: Customers file not found: $CUSTOMERS_FILE${NC}"
    exit 1
fi

# Change to project directory
cd "$PROJECT_DIR"

# Check if dependencies are installed
if [[ ! -d "node_modules" ]]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    npm install
fi

# Build the command arguments
CMD_ARGS=""
if [[ -n "$PRODUCTS_FILE" ]]; then
    # Convert to absolute path if relative
    if [[ "$PRODUCTS_FILE" != /* ]]; then
        PRODUCTS_FILE="$(pwd)/$PRODUCTS_FILE"
    fi
    CMD_ARGS="$CMD_ARGS --products $PRODUCTS_FILE"
fi

if [[ -n "$CUSTOMERS_FILE" ]]; then
    # Convert to absolute path if relative
    if [[ "$CUSTOMERS_FILE" != /* ]]; then
        CUSTOMERS_FILE="$(pwd)/$CUSTOMERS_FILE"
    fi
    CMD_ARGS="$CMD_ARGS --customers $CUSTOMERS_FILE"
fi

CMD_ARGS="$CMD_ARGS --output $OUTPUT_DIR"

# Run the import script
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Step 1: CSV Data Import${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

if [[ -n "$PRODUCTS_FILE" ]]; then
    echo -e "Products file:  ${GREEN}$PRODUCTS_FILE${NC}"
fi
if [[ -n "$CUSTOMERS_FILE" ]]; then
    echo -e "Customers file: ${GREEN}$CUSTOMERS_FILE${NC}"
fi
echo -e "Output dir:     ${GREEN}$OUTPUT_DIR${NC}"
echo ""

npx tsx scripts/import-csv-data.ts $CMD_ARGS

# Generate embeddings
if [[ "$GENERATE_EMBEDDINGS" == true ]]; then
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}  Step 2: Generating Embeddings${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo ""
    echo -e "Region: ${GREEN}$REGION${NC}"
    echo -e "${YELLOW}Note: This requires AWS credentials with Bedrock access${NC}"
    echo ""

    # Build flags to only generate embeddings for the data types we imported
    GENERATE_FLAGS="--use-imported"
    if [[ -n "$PRODUCTS_FILE" ]]; then
        GENERATE_FLAGS="$GENERATE_FLAGS --only-products"
    fi
    if [[ -n "$CUSTOMERS_FILE" ]]; then
        GENERATE_FLAGS="$GENERATE_FLAGS --only-customers"
    fi

    AWS_REGION="$REGION" npx tsx scripts/generate-seed-data.ts $GENERATE_FLAGS
fi

# Upload to S3 Vectors
if [[ "$UPLOAD_VECTORS" == true ]]; then
    echo ""
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}  Step 3: Uploading to S3 Vectors${NC}"
    echo -e "${BLUE}========================================${NC}"
    echo ""
    echo -e "Region:        ${GREEN}$REGION${NC}"
    echo -e "Vector Bucket: ${GREEN}$VECTOR_BUCKET_NAME${NC}"
    echo -e "Upload Mode:   ${GREEN}$UPLOAD_MODE${NC}"
    echo ""

    # Helper function to flush an index (delete and recreate)
    flush_index() {
        local index_name=$1
        echo -e "  ${YELLOW}Flushing $index_name (delete + recreate)...${NC}"

        # Delete the index
        aws s3vectors delete-index \
            --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
            --index-name "$index_name" \
            --region "${REGION}" 2>/dev/null || true

        # Wait a moment for deletion to propagate
        sleep 2

        # Recreate the index
        aws s3vectors create-index \
            --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
            --index-name "$index_name" \
            --dimension 1024 --distance-metric "cosine" --data-type "float32" \
            --region "${REGION}" 2>/dev/null || echo "    (index may already exist)"

        # Wait for index to become active
        local retries=0
        while [ $retries -lt 30 ]; do
            if aws s3vectors get-index \
                --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
                --index-name "$index_name" \
                --region "${REGION}" >/dev/null 2>&1; then
                echo "    $index_name: ready"
                break
            fi
            retries=$((retries + 1))
            sleep 2
        done
    }

    # If replace mode, flush the indexes first (only for data types we imported)
    if [[ "$UPLOAD_MODE" == "replace" ]]; then
        echo -e "${YELLOW}Replace mode: Flushing existing indexes...${NC}"
        echo ""
        if [[ -n "$PRODUCTS_FILE" ]]; then
            flush_index "products-index"
        fi
        if [[ -n "$CUSTOMERS_FILE" ]]; then
            flush_index "customers-index"
        fi
        echo ""
    fi

    # Upload products (only if products CSV was provided)
    if [[ -n "$PRODUCTS_FILE" && -f "$OUTPUT_DIR/products-vectors.json" ]]; then
        echo "  Uploading product vectors..."
        node --input-type=module -e "
import { readFileSync } from 'fs';
import { S3VectorsClient, PutVectorsCommand, GetVectorsCommand } from '@aws-sdk/client-s3vectors';
const client = new S3VectorsClient({ region: '${REGION}' });
const data = JSON.parse(readFileSync('${OUTPUT_DIR}/products-vectors.json', 'utf-8'));
const mode = '${UPLOAD_MODE}';
let uploaded = 0;
let skipped = 0;

for (let i = 0; i < data.vectors.length; i += 10) {
  const batch = data.vectors.slice(i, i + 10);
  let toUpload = batch;

  // In append mode, check which keys already exist
  if (mode === 'append') {
    try {
      const existing = await client.send(new GetVectorsCommand({
        vectorBucketName: '${VECTOR_BUCKET_NAME}', indexName: 'products-index',
        keys: batch.map(v => v.key), returnMetadata: false,
      }));
      const existingKeys = new Set((existing.vectors || []).map(v => v.key));
      toUpload = batch.filter(v => !existingKeys.has(v.key));
      skipped += batch.length - toUpload.length;
    } catch (e) {
      // If GetVectors fails, proceed with upload
    }
  }

  if (toUpload.length > 0) {
    await client.send(new PutVectorsCommand({
      vectorBucketName: '${VECTOR_BUCKET_NAME}', indexName: 'products-index',
      vectors: toUpload.map(v => ({ key: v.key, data: { float32: v.vector }, metadata: v.metadata })),
    }));
    uploaded += toUpload.length;
  }
  process.stdout.write('    Processed ' + (i + batch.length) + '/' + data.vectors.length + ' products\r');
}
const msg = mode === 'append' && skipped > 0
  ? '    Uploaded ' + uploaded + ', skipped ' + skipped + ' existing - done'
  : '    Uploaded ' + uploaded + '/' + data.vectors.length + ' products - done';
console.log(msg);
"
    fi

    # Upload customers (only if customers CSV was provided)
    if [[ -n "$CUSTOMERS_FILE" && -f "$OUTPUT_DIR/customers-vectors.json" ]]; then
        echo "  Uploading customer vectors..."
        node --input-type=module -e "
import { readFileSync } from 'fs';
import { S3VectorsClient, PutVectorsCommand, GetVectorsCommand } from '@aws-sdk/client-s3vectors';
const client = new S3VectorsClient({ region: '${REGION}' });
const data = JSON.parse(readFileSync('${OUTPUT_DIR}/customers-vectors.json', 'utf-8'));
const mode = '${UPLOAD_MODE}';
let uploaded = 0;
let skipped = 0;

for (let i = 0; i < data.vectors.length; i += 10) {
  const batch = data.vectors.slice(i, i + 10);
  let toUpload = batch;

  if (mode === 'append') {
    try {
      const existing = await client.send(new GetVectorsCommand({
        vectorBucketName: '${VECTOR_BUCKET_NAME}', indexName: 'customers-index',
        keys: batch.map(v => v.key), returnMetadata: false,
      }));
      const existingKeys = new Set((existing.vectors || []).map(v => v.key));
      toUpload = batch.filter(v => !existingKeys.has(v.key));
      skipped += batch.length - toUpload.length;
    } catch (e) {}
  }

  if (toUpload.length > 0) {
    await client.send(new PutVectorsCommand({
      vectorBucketName: '${VECTOR_BUCKET_NAME}', indexName: 'customers-index',
      vectors: toUpload.map(v => ({ key: v.key, data: { float32: v.vector }, metadata: v.metadata })),
    }));
    uploaded += toUpload.length;
  }
  process.stdout.write('    Processed ' + (i + batch.length) + '/' + data.vectors.length + ' customers\r');
}
const msg = mode === 'append' && skipped > 0
  ? '    Uploaded ' + uploaded + ', skipped ' + skipped + ' existing - done'
  : '    Uploaded ' + uploaded + '/' + data.vectors.length + ' customers - done';
console.log(msg);
"
    fi
fi

# Summary
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Import Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

echo "Output files:"
if [[ -n "$PRODUCTS_FILE" ]]; then
    echo -e "  - ${GREEN}$OUTPUT_DIR/products-raw.json${NC}"
fi
if [[ -n "$CUSTOMERS_FILE" ]]; then
    echo -e "  - ${GREEN}$OUTPUT_DIR/customers-raw.json${NC}"
fi

if [[ "$GENERATE_EMBEDDINGS" == true ]]; then
    echo ""
    echo "Vector files:"
    if [[ -n "$PRODUCTS_FILE" ]]; then
        echo -e "  - ${GREEN}$OUTPUT_DIR/products-vectors.json${NC}"
    fi
    if [[ -n "$CUSTOMERS_FILE" ]]; then
        echo -e "  - ${GREEN}$OUTPUT_DIR/customers-vectors.json${NC}"
    fi
fi

if [[ "$UPLOAD_VECTORS" == true ]]; then
    echo ""
    echo -e "Vectors uploaded to S3 Vectors bucket: ${GREEN}$VECTOR_BUCKET_NAME${NC}"
    echo -e "Upload mode: ${GREEN}$UPLOAD_MODE${NC}"
    echo ""
    echo -e "${GREEN}Your RAG indexes are now updated and ready to use!${NC}"
fi

if [[ "$GENERATE_EMBEDDINGS" != true ]]; then
    echo ""
    echo -e "${YELLOW}Next steps:${NC}"
    echo "  1. Review the generated JSON files in $OUTPUT_DIR"
    echo "  2. Generate embeddings and upload with:"
    echo "     ./scripts/import-csv.sh -p products.csv -c customers.csv -g -u"
fi
echo ""
