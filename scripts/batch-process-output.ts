/**
 * Batch Process Output - Convert Bedrock Batch Inference results to vector format
 *
 * Takes the output from Bedrock Batch Inference and combines it with the raw data
 * to create the final vectors JSON file for S3 Vectors upload.
 *
 * Usage:
 *   npx tsx scripts/batch-process-output.ts --type products --input /tmp/output/ --raw ./seed-data/products-raw.json --output ./seed-data/products-vectors.json
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

// ─── Type Definitions ───────────────────────────────────────────────────────

interface Product {
  id: string;
  itemGroupId?: string;
  mpn?: string;
  name: string;
  manufacturer?: string;
  brand?: string;
  imageLink?: string;
  productLink?: string;
  description: string;
  price: number;
  salePrice?: number;
  productType?: string;
  category?: string;
  categoryL1?: string;
  categoryL2?: string;
  categoryL3?: string;
  categoryL4?: string;
  categoryL5?: string;
  inStock: boolean;
  quantity?: number;
  reviewRating?: number;
  color?: string;
  material?: string;
  theme?: string;
  occasion?: string;
  holiday?: string;
  forWhom?: string;
  ageGroup?: string;
  gender?: string;
  size?: string;
  industryType?: string;
  businessUnit?: string;
  isBundle?: boolean;
  isBulk?: boolean;
  isOnSale?: boolean;
}

interface CustomerProfile {
  userId: string;
  customerType?: string;
  customerSegment?: string;
  businessUnit?: string;
  preferredCategoryL1?: string;
  preferredCategoryL2?: string;
  preferredOccasion?: string;
  preferredTheme?: string;
  priceAffinity?: string;
  discountAffinity?: string;
  region?: string;
  state?: string;
  accountAgeDays?: number;
  lifetimeOrderCount?: number;
  lifetimeSpend?: number;
  avgOrderValue?: number;
  daysSinceLastOrder?: number;
  emailOptIn?: boolean;
}

interface BatchOutputRecord {
  recordId: string;
  modelOutput?: {
    embedding: number[];
  };
  error?: {
    errorCode: string;
    errorMessage: string;
  };
}

// ─── Metadata Conversion Functions ──────────────────────────────────────────

function productToMetadata(product: Product): Record<string, string> {
  const metadata: Record<string, string> = {
    name: product.name,
    description: product.description,
    price: String(product.price),
    inStock: String(product.inStock),
  };

  if (product.category) metadata.category = product.category;
  if (product.categoryL1) metadata.categoryL1 = product.categoryL1;
  if (product.categoryL2) metadata.categoryL2 = product.categoryL2;
  if (product.categoryL3) metadata.categoryL3 = product.categoryL3;
  if (product.theme) metadata.theme = product.theme;
  if (product.occasion) metadata.occasion = product.occasion;
  if (product.holiday) metadata.holiday = product.holiday;
  if (product.color) metadata.color = product.color;
  if (product.material) metadata.material = product.material;
  if (product.forWhom) metadata.forWhom = product.forWhom;
  if (product.ageGroup) metadata.ageGroup = product.ageGroup;
  if (product.gender) metadata.gender = product.gender;
  if (product.brand) metadata.brand = product.brand;
  if (product.manufacturer) metadata.manufacturer = product.manufacturer;
  if (product.imageLink) metadata.imageLink = product.imageLink;
  if (product.productLink) metadata.productLink = product.productLink;
  if (product.salePrice) metadata.salePrice = String(product.salePrice);
  if (product.reviewRating !== undefined) metadata.reviewRating = String(product.reviewRating);
  if (product.quantity !== undefined) metadata.quantity = String(product.quantity);
  if (product.industryType) metadata.industryType = product.industryType;
  if (product.businessUnit) metadata.businessUnit = product.businessUnit;

  return metadata;
}

function customerToMetadata(customer: CustomerProfile): Record<string, string> {
  const metadata: Record<string, string> = {
    userId: customer.userId,
  };

  if (customer.customerType) metadata.customerType = customer.customerType;
  if (customer.customerSegment) metadata.customerSegment = customer.customerSegment;
  if (customer.businessUnit) metadata.businessUnit = customer.businessUnit;
  if (customer.preferredCategoryL1) metadata.preferredCategoryL1 = customer.preferredCategoryL1;
  if (customer.preferredCategoryL2) metadata.preferredCategoryL2 = customer.preferredCategoryL2;
  if (customer.preferredOccasion) metadata.preferredOccasion = customer.preferredOccasion;
  if (customer.preferredTheme) metadata.preferredTheme = customer.preferredTheme;
  if (customer.priceAffinity) metadata.priceAffinity = customer.priceAffinity;
  if (customer.discountAffinity) metadata.discountAffinity = customer.discountAffinity;
  if (customer.region) metadata.region = customer.region;
  if (customer.state) metadata.state = customer.state;
  if (customer.accountAgeDays !== undefined) metadata.accountAgeDays = String(customer.accountAgeDays);
  if (customer.lifetimeOrderCount !== undefined) metadata.lifetimeOrderCount = String(customer.lifetimeOrderCount);
  if (customer.lifetimeSpend !== undefined) metadata.lifetimeSpend = String(customer.lifetimeSpend);
  if (customer.avgOrderValue !== undefined) metadata.avgOrderValue = String(customer.avgOrderValue);
  if (customer.daysSinceLastOrder !== undefined) metadata.daysSinceLastOrder = String(customer.daysSinceLastOrder);
  if (customer.emailOptIn !== undefined) metadata.emailOptIn = String(customer.emailOptIn);

  return metadata;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  let dataType = "";
  let inputDir = "";
  let rawFile = "";
  let outputFile = "";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--type":
      case "-t":
        dataType = args[++i];
        break;
      case "--input":
      case "-i":
        inputDir = args[++i];
        break;
      case "--raw":
      case "-r":
        rawFile = args[++i];
        break;
      case "--output":
      case "-o":
        outputFile = args[++i];
        break;
      case "--help":
      case "-h":
        console.log(`
Batch Process Output - Convert Bedrock Batch Inference results to vector format

Usage:
  npx tsx scripts/batch-process-output.ts [options]

Options:
  --type, -t <type>      Data type: products or customers
  --input, -i <dir>      Input directory containing batch output files
  --raw, -r <file>       Raw JSON file (from import-csv-data.ts)
  --output, -o <file>    Output vectors JSON file
  --help, -h             Show this help message
`);
        process.exit(0);
    }
  }

  if (!dataType || !inputDir || !rawFile || !outputFile) {
    console.error("Error: --type, --input, --raw, and --output are required");
    process.exit(1);
  }

  console.log(`Processing batch output for ${dataType}...`);
  console.log(`  Batch output: ${inputDir}`);
  console.log(`  Raw data: ${rawFile}`);
  console.log(`  Output: ${outputFile}`);

  // Load raw data into a map for quick lookup
  const rawData = JSON.parse(readFileSync(rawFile, "utf-8"));
  const rawMap = new Map<string, Product | CustomerProfile>();

  for (const item of rawData) {
    const id = dataType === "products" ? (item as Product).id : (item as CustomerProfile).userId;
    rawMap.set(id, item);
  }

  console.log(`  Raw records: ${rawMap.size}`);

  // Read all JSONL files from output directory
  const embeddings = new Map<string, number[]>();
  let errorCount = 0;

  const files = readdirSync(inputDir).filter((f) => f.endsWith(".jsonl") || f.endsWith(".jsonl.out"));

  for (const file of files) {
    const filePath = join(inputDir, file);
    const content = readFileSync(filePath, "utf-8");

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;

      try {
        const record = JSON.parse(line) as BatchOutputRecord;

        if (record.error) {
          console.warn(`  Error for ${record.recordId}: ${record.error.errorMessage}`);
          errorCount++;
          continue;
        }

        if (record.modelOutput?.embedding) {
          embeddings.set(record.recordId, record.modelOutput.embedding);
        }
      } catch (e) {
        console.warn(`  Failed to parse line: ${line.substring(0, 100)}`);
      }
    }
  }

  console.log(`  Embeddings loaded: ${embeddings.size}`);
  if (errorCount > 0) {
    console.log(`  Errors: ${errorCount}`);
  }

  // Build vectors array
  const vectors: Array<{
    key: string;
    vector: number[];
    metadata: Record<string, string>;
  }> = [];

  for (const [id, embedding] of embeddings) {
    const rawItem = rawMap.get(id);
    if (!rawItem) {
      console.warn(`  No raw data found for: ${id}`);
      continue;
    }

    let metadata: Record<string, string>;
    if (dataType === "products") {
      metadata = productToMetadata(rawItem as Product);
    } else {
      metadata = customerToMetadata(rawItem as CustomerProfile);
    }

    vectors.push({
      key: id,
      vector: embedding,
      metadata,
    });
  }

  // Write output
  const output = {
    indexName: `${dataType}-index`,
    vectorBucketName: "party-supply-vectors",
    dimensions: 1024,
    distanceMetric: "cosine",
    vectors,
  };

  writeFileSync(outputFile, JSON.stringify(output, null, 2));

  console.log(`\nOutput written: ${vectors.length} vectors`);
  console.log(`File: ${outputFile}`);

  // Summary
  const missingCount = rawMap.size - vectors.length;
  if (missingCount > 0) {
    console.log(`\nWarning: ${missingCount} records missing embeddings`);
  }
}

main().catch((err) => {
  console.error("Error processing batch output:", err);
  process.exit(1);
});
