"""
Glue ETL Job: Deduplication and JSONL Preparation

Reads CSV from S3, deduplicates by ID, converts to JSONL format for Bedrock Batch.

Arguments:
  --data_type: products | customers | interactions
  --input_path: s3://bucket/path/to/input.csv
  --output_path: s3://bucket/path/to/output/
  --chunk_size: Records per JSONL file (default: 50000)

Note on interactions: each event row becomes its own vector. The "id" used
for the vector key is a composite of USER_ID + ITEM_ID + TIMESTAMP since
the same user can interact with the same item multiple times. Dedup is
applied on that composite key, not on USER_ID alone.
"""

import sys
from awsglue.transforms import *
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job
from pyspark.sql import functions as F
from pyspark.sql.types import StringType
import json

args = getResolvedOptions(sys.argv, [
    'JOB_NAME',
    'data_type',
    'input_path',
    'output_path',
    'chunk_size'
])

sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session
job = Job(glueContext)
job.init(args['JOB_NAME'], args)

data_type = args['data_type']
input_path = args['input_path']
output_path = args['output_path'].rstrip('/')
chunk_size = int(args.get('chunk_size', '50000'))

print(f"Processing {data_type} from {input_path}")
print(f"Output: {output_path}, Chunk size: {chunk_size}")


def product_to_text(row):
    """Convert product row to embedding text."""
    name = getattr(row, 'name', None) or getattr(row, 'TITLE', None) or ''
    parts = [f"Product: {name}"]

    category = getattr(row, 'category', None) or getattr(row, 'CATEGORY_L1', None) or ''
    if category:
        parts.append(f"Category: {category}")

    cat_l2 = getattr(row, 'categoryL2', None) or getattr(row, 'CATEGORY_L2', None)
    if cat_l2:
        parts.append(f"> {cat_l2}")

    theme = getattr(row, 'theme', None) or getattr(row, 'THEME', None)
    if theme:
        parts.append(f"Theme: {theme}")

    occasion = getattr(row, 'occasion', None) or getattr(row, 'OCCASION', None)
    if occasion:
        parts.append(f"Occasion: {occasion}")

    description = getattr(row, 'description', None) or getattr(row, 'DESCRIPTION', None) or ''
    parts.append(f"Description: {description}")

    price = getattr(row, 'price', None) or getattr(row, 'PRICE', None) or 0
    parts.append(f"Price: ${price}")

    color = getattr(row, 'color', None) or getattr(row, 'COLOR', None)
    if color:
        parts.append(f"Color: {color}")

    in_stock = getattr(row, 'inStock', None) or getattr(row, 'AVAILABILITY', None)
    if in_stock:
        parts.append("In stock" if str(in_stock).lower() in ['true', 'in stock', '1'] else "Out of stock")

    brand = getattr(row, 'brand', None) or getattr(row, 'BRAND', None)
    if brand:
        parts.append(f"Brand: {brand}")

    return ". ".join(parts)


def customer_to_text(row):
    """Convert customer row to embedding text."""
    user_id = getattr(row, 'userId', None) or getattr(row, 'USER_ID', None) or ''
    parts = [f"Customer: {user_id}"]

    cust_type = getattr(row, 'customerType', None) or getattr(row, 'CUSTOMER_TYPE', None)
    if cust_type:
        parts.append(f"Type: {cust_type}")

    segment = getattr(row, 'customerSegment', None) or getattr(row, 'CUSTOMER_SEGMENT', None)
    if segment:
        parts.append(f"Segment: {segment}")

    pref_cat = getattr(row, 'preferredCategoryL1', None) or getattr(row, 'PREFERRED_CATEGORY_L1', None)
    if pref_cat:
        parts.append(f"Preferred Category: {pref_cat}")

    pref_theme = getattr(row, 'preferredTheme', None) or getattr(row, 'PREFERRED_THEME', None)
    if pref_theme:
        parts.append(f"Preferred Theme: {pref_theme}")

    price_aff = getattr(row, 'priceAffinity', None) or getattr(row, 'PRICE_AFFINITY', None)
    if price_aff:
        parts.append(f"Price Affinity: {price_aff}")

    region = getattr(row, 'region', None) or getattr(row, 'REGION', None)
    state = getattr(row, 'state', None) or getattr(row, 'STATE', None)
    if region and state:
        parts.append(f"Location: {region}, {state}")

    orders = getattr(row, 'lifetimeOrderCount', None) or getattr(row, 'LIFETIME_ORDER_COUNT', None)
    if orders:
        parts.append(f"Orders: {orders}")

    spend = getattr(row, 'lifetimeSpend', None) or getattr(row, 'LIFETIME_SPEND', None)
    if spend:
        parts.append(f"Lifetime Spend: ${spend}")

    return ". ".join(parts)


def interaction_to_text(row):
    """Convert one interaction event row to embedding text.

    Each row is a single user/item event - we want the embedding to
    capture the action ("user X viewed item Y at time Z") so the agent
    can do semantic queries like "what has user X been browsing?" or
    "show me items recently purchased". Item details aren't included
    here because the products-index already covers product semantics;
    interactions just point at items.
    """
    user_id = getattr(row, 'USER_ID', None) or getattr(row, 'userId', None) or ''
    item_id = getattr(row, 'ITEM_ID', None) or getattr(row, 'itemId', None) or ''
    event_type = getattr(row, 'EVENT_TYPE', None) or getattr(row, 'eventType', None) or 'event'
    timestamp = getattr(row, 'TIMESTAMP', None) or getattr(row, 'timestamp', None) or ''
    quantity = getattr(row, 'QUANTITY', None) or getattr(row, 'quantity', None)
    price = getattr(row, 'PRICE', None) or getattr(row, 'price', None)
    rec_id = getattr(row, 'RECOMMENDATION_ID', None) or getattr(row, 'recommendationId', None)

    parts = [f"User {user_id} performed {event_type} on item {item_id}"]
    if timestamp:
        parts.append(f"at timestamp {timestamp}")
    if quantity and str(quantity).strip() not in ('', '0'):
        parts.append(f"quantity {quantity}")
    if price:
        parts.append(f"price ${price}")
    if rec_id and str(rec_id).strip():
        parts.append(f"via {rec_id}")
    return ". ".join(parts)


def make_interaction_id(row):
    """Composite key: user/item events aren't unique by user alone, the
    same user can view the same item many times. The vector store needs
    a stable per-event key so we hash user+item+timestamp."""
    user_id = str(getattr(row, 'USER_ID', None) or getattr(row, 'userId', None) or '')
    item_id = str(getattr(row, 'ITEM_ID', None) or getattr(row, 'itemId', None) or '')
    timestamp = str(getattr(row, 'TIMESTAMP', None) or getattr(row, 'timestamp', None) or '')
    return f"{user_id}_{item_id}_{timestamp}"


def to_bedrock_jsonl(row, data_type):
    """Convert row to Bedrock Batch JSONL format."""
    if data_type == 'products':
        record_id = getattr(row, 'id', None) or getattr(row, 'ITEM_ID', None) or ''
        text = product_to_text(row)
    elif data_type == 'interactions':
        record_id = make_interaction_id(row)
        text = interaction_to_text(row)
    else:
        record_id = getattr(row, 'userId', None) or getattr(row, 'USER_ID', None) or ''
        text = customer_to_text(row)

    return json.dumps({
        "recordId": str(record_id),
        "modelInput": {
            "inputText": text,
            "dimensions": 1024,
            "normalize": True
        }
    })


# Read CSV
df = spark.read.option("header", "true").option("inferSchema", "true").csv(input_path)
print(f"Read {df.count()} records")

# Determine dedup key. Products and customers dedup on a single column;
# interactions are uniquely identified by the (user, item, timestamp) tuple
# because the same user can interact with the same item many times.
original_count = df.count()
if data_type == 'products':
    id_col = 'id' if 'id' in df.columns else 'ITEM_ID'
    df_dedup = df.dropDuplicates([id_col])
elif data_type == 'interactions':
    user_col = 'userId' if 'userId' in df.columns else 'USER_ID'
    item_col = 'itemId' if 'itemId' in df.columns else 'ITEM_ID'
    ts_col = 'timestamp' if 'timestamp' in df.columns else 'TIMESTAMP'
    df_dedup = df.dropDuplicates([user_col, item_col, ts_col])
else:
    id_col = 'userId' if 'userId' in df.columns else 'USER_ID'
    df_dedup = df.dropDuplicates([id_col])

dedup_count = df_dedup.count()
print(f"After deduplication: {dedup_count} records ({original_count - dedup_count} duplicates removed)")

# Register UDF
to_jsonl_udf = F.udf(lambda row: to_bedrock_jsonl(row, data_type), StringType())

# Convert to JSONL format
df_jsonl = df_dedup.withColumn("jsonl_line", to_jsonl_udf(F.struct([F.col(c) for c in df_dedup.columns])))

# Write as text files (one line per record)
# Repartition to control chunk sizes
num_partitions = max(1, dedup_count // chunk_size + (1 if dedup_count % chunk_size else 0))
print(f"Writing {num_partitions} chunk(s)")

df_jsonl.select("jsonl_line") \
    .repartition(num_partitions) \
    .write \
    .mode("overwrite") \
    .text(f"{output_path}/chunks/")

# Write raw JSON for metadata enrichment later
df_dedup.write.mode("overwrite").json(f"{output_path}/raw/")

# Write manifest
manifest = {
    "dataType": data_type,
    "totalRecords": dedup_count,
    "duplicatesRemoved": original_count - dedup_count,
    "chunkCount": num_partitions,
    "chunkSize": chunk_size,
    "inputPath": input_path,
    "outputPath": output_path
}

manifest_df = spark.createDataFrame([manifest])
manifest_df.write.mode("overwrite").json(f"{output_path}/manifest/")

print(f"Complete. Output at {output_path}")

job.commit()
