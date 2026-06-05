"""
Glue Python Shell Job: Upload Embeddings to S3 Vectors

Reads Bedrock Batch output and uploads vectors to S3 Vectors index.

Arguments:
  --data_type: products | customers
  --batch_output_path: s3://bucket/batch-output/job-name/
  --raw_data_path: s3://bucket/prepared/raw/
  --vector_bucket: S3 Vectors bucket name
  --region: AWS region
  --upload_mode: replace | upsert | append (default: upsert)
"""

import sys
import json
import boto3
from awsglue.utils import getResolvedOptions

# Get required args
args = getResolvedOptions(sys.argv, [
    'data_type',
    'batch_output_path',
    'raw_data_path',
    'vector_bucket',
    'region'
])

# Get optional args with defaults
upload_mode = 'upsert'
if '--upload_mode' in sys.argv:
    idx = sys.argv.index('--upload_mode')
    if idx + 1 < len(sys.argv):
        upload_mode = sys.argv[idx + 1]

data_type = args['data_type']
batch_output_path = args['batch_output_path'].rstrip('/')
raw_data_path = args['raw_data_path'].rstrip('/')
vector_bucket = args['vector_bucket']
region = args['region']

print(f"Uploading {data_type} vectors to {vector_bucket}")
print(f"Batch output: {batch_output_path}")
print(f"Raw data: {raw_data_path}")
print(f"Upload mode: {upload_mode}")

s3_client = boto3.client('s3', region_name=region)
s3vectors_client = boto3.client('s3vectors', region_name=region)

index_name = f"{data_type}-index"
BATCH_SIZE = 100


def parse_s3_path(s3_path):
    """Parse s3://bucket/key into (bucket, key)."""
    path = s3_path.replace('s3://', '')
    parts = path.split('/', 1)
    return parts[0], parts[1] if len(parts) > 1 else ''


def list_s3_files(bucket, prefix, suffix=''):
    """List all files in S3 with optional suffix filter."""
    files = []
    paginator = s3_client.get_paginator('list_objects_v2')

    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get('Contents', []):
            key = obj['Key']
            if not suffix or key.endswith(suffix):
                files.append(key)

    return files


def stream_jsonl_file(bucket, key):
    """Stream and parse JSONL file line by line."""
    response = s3_client.get_object(Bucket=bucket, Key=key)
    body = response['Body']

    # Read entire file and decode - safer for UTF-8
    content = body.read().decode('utf-8', errors='replace')

    for line in content.split('\n'):
        if line.strip():
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def load_raw_data(bucket, prefix):
    """Load raw data for metadata enrichment."""
    raw_data = {}
    files = list_s3_files(bucket, prefix, '.json')

    for key in files:
        if 'part-' in key or key.endswith('.json'):
            for record in stream_jsonl_file(bucket, key):
                if data_type == 'products':
                    record_id = record.get('id') or record.get('ITEM_ID')
                else:
                    record_id = record.get('userId') or record.get('USER_ID')

                if record_id:
                    raw_data[str(record_id)] = record

    print(f"Loaded {len(raw_data)} raw records for metadata")
    return raw_data


def product_to_metadata(product):
    """Convert product to S3 Vectors metadata."""
    metadata = {
        'name': str(product.get('name') or product.get('TITLE') or '')[:500],
        'description': str(product.get('description') or product.get('DESCRIPTION') or '')[:500],
        'price': str(product.get('price') or product.get('PRICE') or 0),
        'inStock': str(product.get('inStock') or product.get('AVAILABILITY') or 'true').lower()
    }

    for field, csv_field in [
        ('category', 'CATEGORY_L1'), ('categoryL1', 'CATEGORY_L1'),
        ('categoryL2', 'CATEGORY_L2'), ('theme', 'THEME'),
        ('occasion', 'OCCASION'), ('color', 'COLOR'), ('brand', 'BRAND')
    ]:
        val = product.get(field) or product.get(csv_field)
        if val:
            metadata[field] = str(val)[:100]

    return metadata


def customer_to_metadata(customer):
    """Convert customer to S3 Vectors metadata."""
    metadata = {
        'userId': str(customer.get('userId') or customer.get('USER_ID') or '')
    }

    for field, csv_field in [
        ('customerType', 'CUSTOMER_TYPE'), ('customerSegment', 'CUSTOMER_SEGMENT'),
        ('preferredCategoryL1', 'PREFERRED_CATEGORY_L1'),
        ('preferredTheme', 'PREFERRED_THEME'), ('priceAffinity', 'PRICE_AFFINITY')
    ]:
        val = customer.get(field) or customer.get(csv_field)
        if val:
            metadata[field] = str(val)[:100]

    spend = customer.get('lifetimeSpend') or customer.get('LIFETIME_SPEND')
    if spend is not None:
        metadata['lifetimeSpend'] = str(spend)

    return metadata


def upload_batch(vectors):
    """Upload a batch of vectors to S3 Vectors."""
    if not vectors:
        return 0

    # Deduplicate within batch (keep last)
    seen = {}
    for v in vectors:
        seen[v['key']] = v
    deduped = list(seen.values())

    payload = [{
        'key': v['key'],
        'data': {'float32': v['vector']},
        'metadata': v['metadata']
    } for v in deduped]

    s3vectors_client.put_vectors(
        vectorBucketName=vector_bucket,
        indexName=index_name,
        vectors=payload
    )

    return len(deduped)


def main():
    # Parse paths
    output_bucket, output_prefix = parse_s3_path(batch_output_path)
    raw_bucket, raw_prefix = parse_s3_path(raw_data_path)

    # Note: Flush for replace mode is handled by poll-jobs Lambda before this runs
    # This job always does upsert

    # Load raw data for metadata
    raw_data = load_raw_data(raw_bucket, raw_prefix)

    # Find batch output files
    output_files = list_s3_files(output_bucket, output_prefix, '.jsonl.out')
    if not output_files:
        output_files = list_s3_files(output_bucket, output_prefix, '.jsonl')

    print(f"Found {len(output_files)} output files")

    total_uploaded = 0
    batch = []

    for key in output_files:
        print(f"Processing {key}")

        for record in stream_jsonl_file(output_bucket, key):
            if record.get('error'):
                continue

            embedding = record.get('modelOutput', {}).get('embedding')
            record_id = record.get('recordId')

            if not embedding or not record_id:
                continue

            # Get metadata from raw data
            raw_item = raw_data.get(str(record_id), {})
            if data_type == 'products':
                metadata = product_to_metadata(raw_item) if raw_item else {'id': record_id}
            else:
                metadata = customer_to_metadata(raw_item) if raw_item else {'userId': record_id}

            batch.append({
                'key': str(record_id),
                'vector': embedding,
                'metadata': metadata
            })

            if len(batch) >= BATCH_SIZE:
                total_uploaded += upload_batch(batch)
                batch = []

                if total_uploaded % 5000 == 0:
                    print(f"Uploaded {total_uploaded} vectors...")

    # Upload remaining
    if batch:
        total_uploaded += upload_batch(batch)

    print(f"Upload complete: {total_uploaded} vectors to {index_name}")
    return total_uploaded


if __name__ == '__main__':
    total = main()
    print(json.dumps({'vectorsUploaded': total, 'indexName': index_name}))
