"""
Glue ETL Job: Deduplication and JSONL Preparation

Reads CSV from S3, deduplicates by ID, converts to JSONL format for Bedrock Batch.

Arguments:
  --data_type: products | customers
  --input_path: s3://bucket/path/to/input.csv
  --output_path: s3://bucket/path/to/output/
  --chunk_size: Records per JSONL file (default: 50000)
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


def to_bedrock_jsonl(row, data_type):
    """Convert row to Bedrock Batch JSONL format."""
    if data_type == 'products':
        record_id = getattr(row, 'id', None) or getattr(row, 'ITEM_ID', None) or ''
        text = product_to_text(row)
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

# Determine ID column
if data_type == 'products':
    id_col = 'id' if 'id' in df.columns else 'ITEM_ID'
else:
    id_col = 'userId' if 'userId' in df.columns else 'USER_ID'

# Deduplicate
original_count = df.count()
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
