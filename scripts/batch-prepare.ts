/**
 * Batch Prepare - Convert raw JSON to JSONL for Bedrock Batch Inference
 *
 * Takes the raw JSON from import-csv-data.ts and converts it to the JSONL format
 * required by Bedrock Batch Inference API.
 *
 * Usage:
 *   npx tsx scripts/batch-prepare.ts --type products --input ./seed-data/products-raw.json --output /tmp/products.jsonl
 */

import { readFileSync, writeFileSync, createWriteStream } from "fs";

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

// ─── Text Conversion Functions ──────────────────────────────────────────────

function productToText(product: Product): string {
  const parts: string[] = [`Product: ${product.name}`];

  const category = product.category || product.categoryL1;
  if (category) parts.push(`Category: ${category}`);
  if (product.categoryL2) parts.push(`> ${product.categoryL2}`);
  if (product.categoryL3) parts.push(`> ${product.categoryL3}`);

  if (product.theme) parts.push(`Theme: ${product.theme}`);
  if (product.occasion) parts.push(`Occasion: ${product.occasion}`);
  if (product.holiday) parts.push(`Holiday: ${product.holiday}`);

  parts.push(`Description: ${product.description}`);
  parts.push(`Price: $${product.price}`);
  if (product.salePrice) parts.push(`Sale Price: $${product.salePrice}`);

  if (product.color) parts.push(`Color: ${product.color}`);
  if (product.material) parts.push(`Material: ${product.material}`);
  if (product.forWhom) parts.push(`For: ${product.forWhom}`);
  if (product.ageGroup) parts.push(`Age Group: ${product.ageGroup}`);

  parts.push(product.inStock ? "In stock" : "Out of stock");
  if (product.quantity !== undefined) parts.push(`Quantity: ${product.quantity}`);

  if (product.brand) parts.push(`Brand: ${product.brand}`);
  if (product.manufacturer) parts.push(`Manufacturer: ${product.manufacturer}`);

  return parts.join(". ");
}

function customerToText(customer: CustomerProfile): string {
  const parts: string[] = [`Customer: ${customer.userId}`];

  if (customer.customerType) parts.push(`Type: ${customer.customerType}`);
  if (customer.customerSegment) parts.push(`Segment: ${customer.customerSegment}`);

  if (customer.preferredCategoryL1) parts.push(`Preferred Category: ${customer.preferredCategoryL1}`);
  if (customer.preferredTheme) parts.push(`Preferred Theme: ${customer.preferredTheme}`);
  if (customer.preferredOccasion) parts.push(`Preferred Occasion: ${customer.preferredOccasion}`);

  if (customer.priceAffinity) parts.push(`Price Affinity: ${customer.priceAffinity}`);
  if (customer.discountAffinity) parts.push(`Discount Affinity: ${customer.discountAffinity}`);

  if (customer.region && customer.state) {
    parts.push(`Location: ${customer.region}, ${customer.state}`);
  }

  if (customer.lifetimeOrderCount !== undefined) {
    parts.push(`Orders: ${customer.lifetimeOrderCount}`);
  }
  if (customer.lifetimeSpend !== undefined) {
    parts.push(`Lifetime Spend: $${customer.lifetimeSpend}`);
  }
  if (customer.avgOrderValue !== undefined) {
    parts.push(`Avg Order: $${customer.avgOrderValue}`);
  }
  if (customer.daysSinceLastOrder !== undefined) {
    parts.push(`Days Since Last Order: ${customer.daysSinceLastOrder}`);
  }

  return parts.join(". ");
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  let dataType = "";
  let inputFile = "";
  let outputFile = "";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--type":
      case "-t":
        dataType = args[++i];
        break;
      case "--input":
      case "-i":
        inputFile = args[++i];
        break;
      case "--output":
      case "-o":
        outputFile = args[++i];
        break;
      case "--help":
      case "-h":
        console.log(`
Batch Prepare - Convert raw JSON to JSONL for Bedrock Batch Inference

Usage:
  npx tsx scripts/batch-prepare.ts [options]

Options:
  --type, -t <type>      Data type: products or customers
  --input, -i <file>     Input JSON file (from import-csv-data.ts)
  --output, -o <file>    Output JSONL file for batch inference
  --help, -h             Show this help message
`);
        process.exit(0);
    }
  }

  if (!dataType || !inputFile || !outputFile) {
    console.error("Error: --type, --input, and --output are required");
    process.exit(1);
  }

  console.log(`Preparing batch input for ${dataType}...`);
  console.log(`  Input: ${inputFile}`);
  console.log(`  Output: ${outputFile}`);

  // Read input JSON
  const rawData = JSON.parse(readFileSync(inputFile, "utf-8"));
  console.log(`  Records: ${rawData.length}`);

  // Deduplicate by ID (keep last occurrence)
  const seenIds = new Set<string>();
  const duplicateCount = { count: 0 };

  // Create JSONL output
  const writeStream = createWriteStream(outputFile);

  let count = 0;
  for (const item of rawData) {
    // Get the ID and text based on data type
    let recordId: string;
    let text: string;

    if (dataType === "products") {
      const product = item as Product;
      recordId = product.id;
      text = productToText(product);
    } else if (dataType === "customers") {
      const customer = item as CustomerProfile;
      recordId = customer.userId;
      text = customerToText(customer);
    } else {
      console.error(`Unknown data type: ${dataType}`);
      process.exit(1);
    }

    // Skip duplicates
    if (seenIds.has(recordId)) {
      duplicateCount.count++;
      continue;
    }
    seenIds.add(recordId);

    // Bedrock Batch Inference JSONL format
    // Each line contains: {"recordId": "...", "modelInput": {...}}
    const jsonlRecord = {
      recordId: recordId,
      modelInput: {
        inputText: text,
        dimensions: 1024,
        normalize: true,
      },
    };

    writeStream.write(JSON.stringify(jsonlRecord) + "\n");
    count++;

    // Progress indicator for large datasets
    if (count % 10000 === 0) {
      console.log(`  Prepared ${count}/${rawData.length} records...`);
    }
  }

  writeStream.end();

  console.log(`\nBatch input prepared: ${count} records`);
  if (duplicateCount.count > 0) {
    console.log(`  Skipped ${duplicateCount.count} duplicate IDs`);
  }
  console.log(`Output: ${outputFile}`);
}

main().catch((err) => {
  console.error("Error preparing batch input:", err);
  process.exit(1);
});
