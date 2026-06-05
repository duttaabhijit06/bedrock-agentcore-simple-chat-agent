/**
 * Anonymize CSV Data
 *
 * Removes/replaces identifiable information from CSV files:
 *
 * Products:
 * - Company names → "Party Supply Co"
 * - URLs → generic placeholders
 * - Image links → placeholder URLs
 *
 * Customers:
 * - USER_ID → hashed/randomized IDs
 * - REGION (city) → generic region codes
 * - STATE → kept (not PII by itself)
 *
 * Usage:
 *   npx tsx scripts/anonymize-csv.ts --input uploads/products.csv --output uploads/products-anon.csv
 *   npx tsx scripts/anonymize-csv.ts --input uploads/customers.csv --output uploads/customers-anon.csv --type customers
 */

import { readFileSync, writeFileSync } from "fs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { createHash } from "crypto";

// US regions for anonymization
const REGIONS = ["Northeast", "Southeast", "Midwest", "Southwest", "West", "Pacific", "Mountain", "Central"];

function hashId(id: string): string {
  // Create a consistent but anonymized ID
  const hash = createHash("sha256").update(id + "salt_party_supply").digest("hex");
  return `CUST-${hash.substring(0, 8).toUpperCase()}`;
}

function getRegion(index: number): string {
  return REGIONS[index % REGIONS.length];
}

async function main() {
  const args = process.argv.slice(2);

  let inputFile = "";
  let outputFile = "";
  let dataType = "auto"; // auto-detect or specify

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--input":
      case "-i":
        inputFile = args[++i];
        break;
      case "--output":
      case "-o":
        outputFile = args[++i];
        break;
      case "--type":
      case "-t":
        dataType = args[++i];
        break;
      case "--help":
      case "-h":
        console.log(`
Anonymize CSV Data

Usage:
  npx tsx scripts/anonymize-csv.ts --input <file> --output <file> [--type <type>]

Options:
  --input, -i <file>     Input CSV file
  --output, -o <file>    Output anonymized CSV file
  --type, -t <type>      Data type: products, customers, or auto (default: auto)
  --help, -h             Show this help message

Examples:
  npx tsx scripts/anonymize-csv.ts -i products.csv -o products-anon.csv
  npx tsx scripts/anonymize-csv.ts -i customers.csv -o customers-anon.csv --type customers
`);
        process.exit(0);
    }
  }

  if (!inputFile || !outputFile) {
    console.error("Error: --input and --output are required");
    process.exit(1);
  }

  console.log(`Anonymizing CSV...`);
  console.log(`  Input: ${inputFile}`);
  console.log(`  Output: ${outputFile}`);

  // Read entire file
  const content = readFileSync(inputFile, "utf-8");

  // Parse CSV
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });

  console.log(`  Records: ${records.length}`);

  // Auto-detect type based on columns
  if (dataType === "auto") {
    const firstRecord = records[0];
    if (firstRecord.USER_ID !== undefined) {
      dataType = "customers";
    } else if (firstRecord.ITEM_ID !== undefined) {
      dataType = "products";
    } else {
      dataType = "unknown";
    }
    console.log(`  Detected type: ${dataType}`);
  }

  // Anonymize each record
  let count = 0;
  for (const record of records) {
    if (dataType === "customers") {
      // Anonymize customer data
      if (record.USER_ID) {
        record.USER_ID = hashId(record.USER_ID);
      }

      // Replace city/region with generic region
      if (record.REGION) {
        record.REGION = getRegion(count);
      }

      // CUSTOMER_TYPE - keep or generalize
      if (record.CUSTOMER_TYPE && record.CUSTOMER_TYPE !== "CONSUMER" && record.CUSTOMER_TYPE !== "B2B") {
        record.CUSTOMER_TYPE = "CONSUMER";
      }

      // BUSINESS_UNIT - clear if present (could be identifiable)
      if (record.BUSINESS_UNIT) {
        record.BUSINESS_UNIT = "";
      }

    } else if (dataType === "products") {
      // Helper to replace all company references
      const sanitize = (value: string): string => {
        if (!value) return value;
        return value
          .replace(/Oriental Trading/gi, "PSC")
          .replace(/orientaltrading\.com/gi, "example.com")
          .replace(/\bOTC\b/g, "PSC");
      };

      // Anonymize product data
      if (record.MFTR) {
        record.MFTR = "Party Supply Co";
      }
      if (record.BRAND) {
        record.BRAND = record.BRAND ? "Generic Brand" : "";
      }

      // Replace URLs with placeholders
      if (record.LINK) {
        const itemId = record.ITEM_ID || `item-${count}`;
        record.LINK = `https://example.com/products/${itemId}`;
      }
      if (record.IMAGE_LINK) {
        const itemId = record.ITEM_ID || `item-${count}`;
        record.IMAGE_LINK = `https://example.com/images/${itemId}.jpg`;
      }

      // Sanitize all text fields
      if (record.DESCRIPTION) {
        record.DESCRIPTION = sanitize(record.DESCRIPTION);
      }
      if (record.TITLE) {
        record.TITLE = sanitize(record.TITLE);
      }
      if (record.BUSINESS_UNIT) {
        record.BUSINESS_UNIT = sanitize(record.BUSINESS_UNIT);
      }
      if (record.PRODUCT_TYPE) {
        record.PRODUCT_TYPE = sanitize(record.PRODUCT_TYPE);
      }

      // Sanitize any other field that might contain company references
      for (const key of Object.keys(record)) {
        if (typeof record[key] === "string" &&
            (record[key].includes("Oriental") || record[key].includes("OTC"))) {
          record[key] = sanitize(record[key]);
        }
      }
    }

    count++;
    if (count % 10000 === 0) {
      console.log(`  Processed ${count}/${records.length}...`);
    }
  }

  // Get headers from first record
  const headers = Object.keys(records[0]);

  // Write output
  const output = stringify(records, {
    header: true,
    columns: headers,
  });

  writeFileSync(outputFile, output);

  console.log(`\nAnonymized ${count} records`);
  console.log(`Output: ${outputFile}`);
}

main().catch((err) => {
  console.error("Error anonymizing CSV:", err);
  process.exit(1);
});
