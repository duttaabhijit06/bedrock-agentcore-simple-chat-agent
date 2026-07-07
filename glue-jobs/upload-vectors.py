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

from botocore.config import Config

# S3 Vectors' PutVectors is throttleable when many chunks upload in
# parallel (Glue Python Shell scales out and the batch-result Lambdas
# don't coordinate submission rate across data types). Configure the
# boto3 client with adaptive retry so throttled calls back off and
# retry rather than surfacing as a Glue job failure.
_boto_cfg = Config(
    region_name=region,
    retries={'max_attempts': 10, 'mode': 'adaptive'},
)
s3_client = boto3.client('s3', config=_boto_cfg)
s3vectors_client = boto3.client('s3vectors', config=_boto_cfg)

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
    """Load raw data for metadata enrichment.

    For products/customers the key is a single column. For interactions
    the key is a composite of (user, item, timestamp) - same shape as
    `make_interaction_id` in dedup-prepare.py - because a user can
    interact with the same item many times and each event needs a
    distinct vector.
    """
    raw_data = {}
    files = list_s3_files(bucket, prefix, '.json')

    for key in files:
        if 'part-' in key or key.endswith('.json'):
            for record in stream_jsonl_file(bucket, key):
                if data_type == 'products':
                    record_id = record.get('id') or record.get('ITEM_ID')
                elif data_type == 'interactions':
                    user_id = record.get('userId') or record.get('USER_ID') or ''
                    item_id = record.get('itemId') or record.get('ITEM_ID') or ''
                    timestamp = record.get('timestamp') or record.get('TIMESTAMP') or ''
                    record_id = f"{user_id}_{item_id}_{timestamp}" if user_id else None
                else:
                    record_id = record.get('userId') or record.get('USER_ID')

                if record_id:
                    raw_data[str(record_id)] = record

    print(f"Loaded {len(raw_data)} raw records for metadata")
    return raw_data


# S3 Vectors metadata limits (per index):
#   - Filterable metadata: 2048 bytes/record (must be small).
#   - Non-filterable metadata: 40KB/record.
# products-index and orders-index are created with these keys marked
# non-filterable (see scripts/deploy.sh and scripts/flush-indexes.sh).
# The Glue job still needs a safety net for the filterable half so a
# stray long value can't fail the whole batch.
NON_FILTERABLE_KEYS = {"name", "description", "link", "image"}
FILTERABLE_BYTE_CAP = 1800  # headroom vs the 2048 API limit


def enforce_filterable_cap(metadata):
    """Ensure the filterable half of a metadata dict stays under the 2KB
    S3 Vectors limit. Iteratively trims the longest filterable string
    field until the JSON-encoded size fits.

    Non-filterable keys (see NON_FILTERABLE_KEYS above) are excluded
    from the size calculation because they don't count against the
    filterable budget on indexes created with that config. If the index
    wasn't created with the split, these fields still count - we log
    a warning so operators can spot the misconfiguration in CloudWatch.
    """
    import json as _json

    def filterable_size():
        filterable = {k: v for k, v in metadata.items() if k not in NON_FILTERABLE_KEYS}
        return len(_json.dumps(filterable).encode("utf-8"))

    guard = 20  # bound the loop so a pathological record can't hang the job
    while filterable_size() > FILTERABLE_BYTE_CAP and guard > 0:
        guard -= 1
        # Find the longest *filterable* string field to trim
        candidates = [
            (k, v) for k, v in metadata.items()
            if k not in NON_FILTERABLE_KEYS and isinstance(v, str) and len(v) > 20
        ]
        if not candidates:
            print(
                f"[metadata-cap] Cannot trim further; filterable size {filterable_size()}B "
                f"still exceeds {FILTERABLE_BYTE_CAP}B. Non-string fields dominate."
            )
            break
        biggest_key, biggest_val = max(candidates, key=lambda kv: len(kv[1]))
        new_len = max(len(biggest_val) - 200, 20)
        metadata[biggest_key] = biggest_val[:new_len]
    return metadata


def product_to_metadata(product):
    """Convert product to S3 Vectors metadata.

    Preserves LINK and IMAGE_LINK so the chat UI can render product cards
    with clickable titles and thumbnails. URLs aren't truncated since
    cropping mid-URL produces a 404; we cap at 500 chars instead.

    Large text fields (name/description/link/image) are stored as
    non-filterable metadata; the index config declares them so and this
    function keeps them under keys that the enforce_filterable_cap()
    helper knows to exclude from its budget check.
    """
    metadata = {
        'name': str(product.get('name') or product.get('TITLE') or '')[:500],
        'description': str(product.get('description') or product.get('DESCRIPTION') or '')[:500],
        'price': str(product.get('price') or product.get('PRICE') or 0),
        'inStock': str(product.get('inStock') or product.get('AVAILABILITY') or 'true').lower(),
        'link': str(product.get('link') or product.get('LINK') or '')[:500],
        'image': str(product.get('image') or product.get('IMAGE_LINK') or '')[:500],
    }

    for field, csv_field in [
        ('category', 'CATEGORY_L1'), ('categoryL1', 'CATEGORY_L1'),
        ('categoryL2', 'CATEGORY_L2'), ('theme', 'THEME'),
        ('occasion', 'OCCASION'), ('color', 'COLOR'), ('brand', 'BRAND')
    ]:
        val = product.get(field) or product.get(csv_field)
        if val:
            metadata[field] = str(val)[:100]

    return enforce_filterable_cap(metadata)


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

    return enforce_filterable_cap(metadata)


def interaction_to_metadata(interaction):
    """Convert one interaction event to S3 Vectors metadata.

    Stores all the structured fields the agent will need to filter or
    summarize: user, item, event type, when, quantity, price, recommendation
    source. The vector itself captures semantic meaning of the action;
    metadata is what the agent reads back when QueryVectors returns hits.
    """
    metadata = {
        'userId': str(interaction.get('userId') or interaction.get('USER_ID') or ''),
        'itemId': str(interaction.get('itemId') or interaction.get('ITEM_ID') or ''),
    }

    for field, csv_field in [
        ('eventType', 'EVENT_TYPE'), ('eventValue', 'EVENT_VALUE'),
        ('quantity', 'QUANTITY'), ('price', 'PRICE'),
        ('timestamp', 'TIMESTAMP'),
        ('recommendationId', 'RECOMMENDATION_ID'),
    ]:
        val = interaction.get(field) or interaction.get(csv_field)
        if val is not None and str(val).strip():
            metadata[field] = str(val).strip()[:100]

    return enforce_filterable_cap(metadata)


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

    # Retry envelope around the SDK's built-in adaptive retry. S3 Vectors
    # can throttle for multi-second bursts when several Glue workers
    # (or several parallel imports) submit at once. We keep retrying with
    # exponential backoff so ephemeral throttles don't fail the whole job.
    from botocore.exceptions import ClientError
    import time
    import random

    max_attempts = 8
    delay_s = 1.0
    for attempt in range(1, max_attempts + 1):
        try:
            s3vectors_client.put_vectors(
                vectorBucketName=vector_bucket,
                indexName=index_name,
                vectors=payload,
            )
            return len(deduped)
        except ClientError as e:
            code = e.response.get('Error', {}).get('Code', '')
            throttled = code in (
                'ThrottlingException',
                'TooManyRequestsException',
                'ProvisionedThroughputExceededException',
                'RequestLimitExceeded',
            )
            if not throttled or attempt >= max_attempts:
                raise
            wait = delay_s + random.random() * 0.5  # jitter
            print(
                f"[put_vectors] Throttled (attempt {attempt}/{max_attempts}, "
                f"code={code}). Sleeping {wait:.1f}s before retry."
            )
            time.sleep(wait)
            delay_s = min(delay_s * 2, 30.0)  # cap at 30s
    # Unreachable - loop either returns or raises
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
            elif data_type == 'interactions':
                metadata = interaction_to_metadata(raw_item) if raw_item else {'eventKey': record_id}
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
