/**
 * Import CSV Data for Party Supply Agent
 *
 * Converts customer product and user profile CSV files into the JSON format
 * expected by generate-seed-data.ts. Supports both seed data generation and
 * live data imports.
 *
 * Usage:
 *   npx tsx scripts/import-csv-data.ts --products products.csv --customers customers.csv --output ./seed-data
 *
 * The script will generate:
 *   - products-raw.json (product catalog)
 *   - customers-raw.json (customer profiles)
 *
 * Then run generate-seed-data.ts to create embeddings for vector search.
 */

import { createReadStream, writeFileSync, existsSync } from "fs";
import { parse } from "csv-parse";
import { finished } from "stream/promises";

// ─── Type Definitions ───────────────────────────────────────────────────────

/**
 * Product schema matching the customer's CSV structure
 * All fields are optional to handle varying CSV completeness
 */
export interface Product {
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
  categoryL1?: string;
  categoryL2?: string;
  categoryL3?: string;
  categoryL4?: string;
  categoryL5?: string;
  inStock: boolean;
  reviewRating?: number;
  // Extended attributes for rich filtering
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
  // Business metadata
  businessUnit?: string;
  isBundle?: boolean;
  isBulk?: boolean;
  isOnSale?: boolean;
}

/**
 * Customer profile schema matching the customer's CSV structure
 */
export interface CustomerProfile {
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

// ─── CSV Field Mappings ─────────────────────────────────────────────────────

const PRODUCT_FIELD_MAP: Record<string, keyof Product> = {
  ITEM_ID: "id",
  ITEM_GROUP_ID: "itemGroupId",
  MPN: "mpn",
  TITLE: "name",
  MFTR: "manufacturer",
  BRAND: "brand",
  IMAGE_LINK: "imageLink",
  LINK: "productLink",
  DESCRIPTION: "description",
  PRICE: "price",
  SALE_PRICE: "salePrice",
  PRODUCT_TYPE: "productType",
  CATEGORY_L1: "categoryL1",
  CATEGORY_L2: "categoryL2",
  CATEGORY_L3: "categoryL3",
  CATEGORY_L4: "categoryL4",
  CATEGORY_L5: "categoryL5",
  AVAILABILITY: "inStock",
  REVIEW_RATING: "reviewRating",
  COLOR: "color",
  MATERIAL: "material",
  THEME: "theme",
  SPECIAL_OCCASION_OR_EVENT: "occasion",
  HOLIDAYS: "holiday",
  FOR_WHOM: "forWhom",
  AGE_GROUP: "ageGroup",
  GENDER: "gender",
  SIZE: "size",
  INDUSTRY_TYPE: "industryType",
  BUSINESS_UNIT: "businessUnit",
  IS_BUNDLE: "isBundle",
  BULK_ASSORTMENTS: "isBulk",
  NOW_ON_SALE: "isOnSale",
};

const CUSTOMER_FIELD_MAP: Record<string, keyof CustomerProfile> = {
  USER_ID: "userId",
  CUSTOMER_TYPE: "customerType",
  CUSTOMER_SEGMENT: "customerSegment",
  BUSINESS_UNIT: "businessUnit",
  PREFERRED_CATEGORY_L1: "preferredCategoryL1",
  PREFERRED_CATEGORY_L2: "preferredCategoryL2",
  PREFERRED_OCCASION: "preferredOccasion",
  PREFERRED_THEME: "preferredTheme",
  PRICE_AFFINITY: "priceAffinity",
  DISCOUNT_AFFINITY: "discountAffinity",
  REGION: "region",
  STATE: "state",
  ACCOUNT_AGE_DAYS: "accountAgeDays",
  LIFETIME_ORDER_COUNT: "lifetimeOrderCount",
  LIFETIME_SPEND: "lifetimeSpend",
  AVG_ORDER_VALUE: "avgOrderValue",
  DAYS_SINCE_LAST_ORDER: "daysSinceLastOrder",
  EMAIL_OPT_IN: "emailOptIn",
};

// ─── Parsing Utilities ──────────────────────────────────────────────────────

function parsePrice(value: string): number {
  if (!value) return 0;
  const cleaned = value.replace(/[^0-9.]/g, "");
  return parseFloat(cleaned) || 0;
}

function parseBoolean(value: string): boolean {
  if (!value) return false;
  const lower = value.toLowerCase().trim();
  return lower === "true" || lower === "yes" || lower === "y" || lower === "in stock";
}

function parseNumber(value: string): number | undefined {
  if (!value) return undefined;
  const num = parseFloat(value);
  return isNaN(num) ? undefined : num;
}

function cleanString(value: string): string {
  return value?.trim() || "";
}

// ─── CSV Parsers ────────────────────────────────────────────────────────────

async function parseProductsCsv(filePath: string): Promise<Product[]> {
  const products: Product[] = [];
  const parser = createReadStream(filePath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    })
  );

  parser.on("readable", () => {
    let record: Record<string, string>;
    while ((record = parser.read()) !== null) {
      const product: Partial<Product> = {};

      // Map CSV fields to Product fields
      for (const [csvField, productField] of Object.entries(PRODUCT_FIELD_MAP)) {
        const value = record[csvField];
        if (value === undefined || value === "") continue;

        switch (productField) {
          case "price":
          case "salePrice":
            (product as any)[productField] = parsePrice(value);
            break;
          case "inStock":
          case "isBundle":
          case "isBulk":
          case "isOnSale":
            (product as any)[productField] = parseBoolean(value);
            break;
          case "reviewRating":
            (product as any)[productField] = parseNumber(value);
            break;
          default:
            (product as any)[productField] = cleanString(value);
        }
      }

      // Ensure required fields have defaults
      if (!product.id) {
        console.warn("Skipping product without ID:", record);
        continue;
      }
      if (!product.name) product.name = product.id;
      if (!product.description) product.description = product.name;
      if (product.inStock === undefined) product.inStock = true;
      if (!product.price) product.price = 0;

      products.push(product as Product);
    }
  });

  await finished(parser);
  return products;
}

async function parseCustomersCsv(filePath: string): Promise<CustomerProfile[]> {
  const customers: CustomerProfile[] = [];
  const parser = createReadStream(filePath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    })
  );

  parser.on("readable", () => {
    let record: Record<string, string>;
    while ((record = parser.read()) !== null) {
      const customer: Partial<CustomerProfile> = {};

      // Map CSV fields to CustomerProfile fields
      for (const [csvField, customerField] of Object.entries(CUSTOMER_FIELD_MAP)) {
        const value = record[csvField];
        if (value === undefined || value === "") continue;

        switch (customerField) {
          case "accountAgeDays":
          case "lifetimeOrderCount":
          case "daysSinceLastOrder":
            (customer as any)[customerField] = parseNumber(value);
            break;
          case "lifetimeSpend":
          case "avgOrderValue":
            (customer as any)[customerField] = parsePrice(value);
            break;
          case "emailOptIn":
            (customer as any)[customerField] = parseBoolean(value);
            break;
          default:
            (customer as any)[customerField] = cleanString(value);
        }
      }

      // Ensure required fields
      if (!customer.userId) {
        console.warn("Skipping customer without USER_ID:", record);
        continue;
      }

      customers.push(customer as CustomerProfile);
    }
  });

  await finished(parser);
  return customers;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let productsFile: string | undefined;
  let customersFile: string | undefined;
  let outputDir = "./seed-data";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--products":
      case "-p":
        productsFile = args[++i];
        break;
      case "--customers":
      case "-c":
        customersFile = args[++i];
        break;
      case "--output":
      case "-o":
        outputDir = args[++i];
        break;
      case "--help":
      case "-h":
        console.log(`
Import CSV Data for Party Supply Agent

Usage:
  npx tsx scripts/import-csv-data.ts [options]

Options:
  --products, -p <file>   Path to products CSV file
  --customers, -c <file>  Path to customers CSV file
  --output, -o <dir>      Output directory (default: ./seed-data)
  --help, -h              Show this help message

Examples:
  # Import both products and customers
  npx tsx scripts/import-csv-data.ts -p products.csv -c customers.csv

  # Import only products
  npx tsx scripts/import-csv-data.ts -p products.csv -o ./my-data

  # Import only customer profiles
  npx tsx scripts/import-csv-data.ts -c customers.csv
`);
        process.exit(0);
    }
  }

  if (!productsFile && !customersFile) {
    console.error("Error: At least one of --products or --customers must be specified");
    console.error("Run with --help for usage information");
    process.exit(1);
  }

  console.log("📦 CSV Data Import\n");

  // Process products
  if (productsFile) {
    if (!existsSync(productsFile)) {
      console.error(`Error: Products file not found: ${productsFile}`);
      process.exit(1);
    }
    console.log(`Reading products from: ${productsFile}`);
    const products = await parseProductsCsv(productsFile);
    const outputPath = `${outputDir}/products-raw.json`;
    writeFileSync(outputPath, JSON.stringify(products, null, 2));
    console.log(`  ✅ Imported ${products.length} products -> ${outputPath}`);
  }

  // Process customers
  if (customersFile) {
    if (!existsSync(customersFile)) {
      console.error(`Error: Customers file not found: ${customersFile}`);
      process.exit(1);
    }
    console.log(`Reading customers from: ${customersFile}`);
    const customers = await parseCustomersCsv(customersFile);
    const outputPath = `${outputDir}/customers-raw.json`;
    writeFileSync(outputPath, JSON.stringify(customers, null, 2));
    console.log(`  ✅ Imported ${customers.length} customer profiles -> ${outputPath}`);
  }

  console.log(`
Next steps:
  1. Run 'npx tsx scripts/generate-seed-data.ts' to generate embeddings
  2. Upload the vectors to S3 Vectors using the deploy script
`);
}

main().catch((err) => {
  console.error("Error importing CSV data:", err);
  process.exit(1);
});
