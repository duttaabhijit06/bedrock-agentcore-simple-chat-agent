#!/bin/bash
#
# Flush S3 Vector Indexes
#
# Deletes and recreates S3 Vector indexes to clear all data.
#
# Usage:
#   ./scripts/flush-indexes.sh --all                    # Flush all indexes
#   ./scripts/flush-indexes.sh --products               # Flush products only
#   ./scripts/flush-indexes.sh --products --customers   # Flush products and customers
#
# Options:
#   --all           Flush all indexes (products, orders, customers, interactions)
#   --products      Flush products-index
#   --orders        Flush orders-index
#   --customers     Flush customers-index
#   --interactions  Flush interactions-index
#   --region        AWS region (default: us-west-2)
#   -h, --help      Show this help message
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
REGION="${AWS_REGION:-us-west-2}"
VECTOR_BUCKET_NAME="${VECTOR_BUCKET_NAME:-party-supply-vectors}"
FLUSH_PRODUCTS=false
FLUSH_ORDERS=false
FLUSH_CUSTOMERS=false
FLUSH_INTERACTIONS=false
FLUSH_ALL=false

# Print usage
print_usage() {
    echo ""
    echo -e "${BLUE}Flush S3 Vector Indexes${NC}"
    echo ""
    echo "Deletes and recreates S3 Vector indexes to clear all data."
    echo ""
    echo -e "${YELLOW}Usage:${NC}"
    echo "  ./scripts/flush-indexes.sh [options]"
    echo ""
    echo -e "${YELLOW}Options:${NC}"
    echo "  --all           Flush all indexes (products, orders, customers, interactions)"
    echo "  --products      Flush products-index"
    echo "  --orders        Flush orders-index"
    echo "  --customers     Flush customers-index"
    echo "  --interactions  Flush interactions-index"
    echo "  --region        AWS region (default: us-west-2)"
    echo "  -h, --help      Show this help message"
    echo ""
    echo -e "${YELLOW}Examples:${NC}"
    echo "  # Flush all indexes"
    echo "  ./scripts/flush-indexes.sh --all"
    echo ""
    echo "  # Flush only products"
    echo "  ./scripts/flush-indexes.sh --products"
    echo ""
    echo "  # Flush products and customers"
    echo "  ./scripts/flush-indexes.sh --products --customers"
    echo ""
    echo -e "${YELLOW}Environment Variables:${NC}"
    echo "  AWS_REGION            AWS region (default: us-west-2)"
    echo "  VECTOR_BUCKET_NAME    S3 Vectors bucket name (default: party-supply-vectors)"
    echo ""
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --all)
            FLUSH_ALL=true
            shift
            ;;
        --products)
            FLUSH_PRODUCTS=true
            shift
            ;;
        --orders)
            FLUSH_ORDERS=true
            shift
            ;;
        --customers)
            FLUSH_CUSTOMERS=true
            shift
            ;;
        --interactions)
            FLUSH_INTERACTIONS=true
            shift
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

# If --all, set all flags
if [[ "$FLUSH_ALL" == true ]]; then
    FLUSH_PRODUCTS=true
    FLUSH_ORDERS=true
    FLUSH_CUSTOMERS=true
    FLUSH_INTERACTIONS=true
fi

# Validate at least one index selected
if [[ "$FLUSH_PRODUCTS" != true && "$FLUSH_ORDERS" != true && "$FLUSH_CUSTOMERS" != true && "$FLUSH_INTERACTIONS" != true ]]; then
    echo -e "${RED}Error: At least one index must be specified${NC}"
    print_usage
    exit 1
fi

# Function to flush an index
flush_index() {
    local index_name=$1
    echo -e "  ${YELLOW}Flushing $index_name...${NC}"

    # Delete the index
    echo "    Deleting index..."
    aws s3vectors delete-index \
        --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
        --index-name "$index_name" \
        --region "${REGION}" 2>/dev/null || echo "    (index did not exist)"

    # Wait for deletion to propagate
    echo "    Waiting for deletion..."
    sleep 3

    # Recreate the index with the standard non-filterable metadata split.
    # name/description/link/image go into the 40KB non-filterable bucket
    # to avoid the 2KB filterable-metadata cap. All four indexes share
    # this config for uniformity (see scripts/deploy.sh).
    echo "    Recreating index..."
    aws s3vectors create-index \
        --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
        --index-name "$index_name" \
        --dimension 1024 --distance-metric "cosine" --data-type "float32" \
        --metadata-configuration '{"nonFilterableMetadataKeys":["name","description","link","image"]}' \
        --region "${REGION}" 2>/dev/null || echo "    (index may already exist)"

    # Wait for index to become active
    echo "    Waiting for index to become active..."
    local retries=0
    while [ $retries -lt 30 ]; do
        if aws s3vectors get-index \
            --vector-bucket-name "${VECTOR_BUCKET_NAME}" \
            --index-name "$index_name" \
            --region "${REGION}" >/dev/null 2>&1; then
            echo -e "    ${GREEN}$index_name: ready${NC}"
            return 0
        fi
        retries=$((retries + 1))
        sleep 2
    done

    echo -e "    ${RED}$index_name: timed out waiting (60s)${NC}"
    return 1
}

# Main
echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Flush S3 Vector Indexes${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo -e "Region:        ${GREEN}$REGION${NC}"
echo -e "Vector Bucket: ${GREEN}$VECTOR_BUCKET_NAME${NC}"
echo ""

# Build list of indexes to flush
INDEXES_TO_FLUSH=""
if [[ "$FLUSH_PRODUCTS" == true ]]; then
    INDEXES_TO_FLUSH="$INDEXES_TO_FLUSH products-index"
fi
if [[ "$FLUSH_ORDERS" == true ]]; then
    INDEXES_TO_FLUSH="$INDEXES_TO_FLUSH orders-index"
fi
if [[ "$FLUSH_CUSTOMERS" == true ]]; then
    INDEXES_TO_FLUSH="$INDEXES_TO_FLUSH customers-index"
fi
if [[ "$FLUSH_INTERACTIONS" == true ]]; then
    INDEXES_TO_FLUSH="$INDEXES_TO_FLUSH interactions-index"
fi

echo -e "Indexes to flush:${GREEN}$INDEXES_TO_FLUSH${NC}"
echo ""

# Confirm
read -p "Are you sure you want to flush these indexes? This will DELETE all data. (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

echo ""

# Flush each index
if [[ "$FLUSH_PRODUCTS" == true ]]; then
    flush_index "products-index"
    echo ""
fi

if [[ "$FLUSH_ORDERS" == true ]]; then
    flush_index "orders-index"
    echo ""
fi

if [[ "$FLUSH_CUSTOMERS" == true ]]; then
    flush_index "customers-index"
    echo ""
fi

if [[ "$FLUSH_INTERACTIONS" == true ]]; then
    flush_index "interactions-index"
    echo ""
fi

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Flush Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Indexes are now empty and ready for new data."
echo ""
