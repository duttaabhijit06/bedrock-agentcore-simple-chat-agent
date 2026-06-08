/**
 * Generate bulk CSV fixtures for batch import testing.
 *
 * Reads the headers from uploads/sample-*.csv, synthesizes 100K products,
 * 5K customers, and 25K interactions, then writes:
 *   uploads/products.csv          - bulk products
 *   uploads/customers.csv         - bulk customers
 *   uploads/interactions.csv      - bulk interactions referencing the bulk IDs
 *   uploads/sample-interactions.csv - 500-row sample referencing the sample IDs
 *
 * Interactions are coherent with the catalog: each row references real
 * USER_ID and ITEM_ID values from the customer/product files (bulk
 * interactions reference bulk IDs, sample interactions reference sample IDs).
 * That means the agent's query_interactions can be paired with
 * search_products/lookup_customer for round-trip enrichment.
 *
 * Usage:
 *   npx tsx scripts/generate-bulk-csv.ts
 *   npx tsx scripts/generate-bulk-csv.ts --products 50000 --customers 2000 --interactions 10000
 */
import { readFileSync, writeFileSync, createWriteStream } from "fs";

// ─── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag: string, fallback: number): number {
  const i = args.indexOf(flag);
  if (i >= 0 && args[i + 1]) return parseInt(args[i + 1], 10);
  return fallback;
}
const NUM_PRODUCTS = getArg("--products", 100000);
const NUM_CUSTOMERS = getArg("--customers", 5000);
const NUM_INTERACTIONS = getArg("--interactions", 25000);
const NUM_SAMPLE_INTERACTIONS = getArg("--sample-interactions", 500);

// ─── Read sample headers + rows ──────────────────────────────────────────────
function parseCsv(path: string): { headers: string[]; rows: string[][] } {
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(parseLine);
  return { headers, rows };
}

// Minimal RFC 4180 line parser (handles quoted fields with commas)
function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQ = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === ",") {
        out.push(cur);
        cur = "";
      } else if (ch === '"') {
        inQ = true;
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}

function escapeCsv(value: string): string {
  if (value === undefined || value === null) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randFloat(min: number, max: number, decimals = 2): number {
  const v = Math.random() * (max - min) + min;
  return parseFloat(v.toFixed(decimals));
}

// ─── Variation pools (for combinatorial uniqueness) ──────────────────────────
const themes = [
  "Elegant", "Tropical", "Rustic", "Superhero", "Glow Party", "Vintage",
  "Fiesta", "Baby Elephant", "Spooky", "Academic", "Princess", "Dinosaur",
  "Unicorn", "Mermaid", "Space", "Pirate", "Safari", "Jungle", "Western",
  "Boho", "Modern", "Classic", "Whimsical", "Minimalist", "Floral",
  "Nautical", "Sports", "Music", "Art", "Science",
];
const colors = [
  "Gold", "Pink", "Blue", "Green", "Red", "Black", "White", "Silver",
  "Purple", "Orange", "Yellow", "Multi-Color", "Pastel", "Neon",
  "Rose Gold", "Burgundy", "Teal", "Coral", "Mint", "Navy",
];
// Excluded by design (Bedrock content filters trip on these even at MEDIUM
// strength because the classifier's training data heavily associates them
// with adult / underage themes):
//   - "Bachelor Party", "Bachelorette Party" -> SEXUAL filter
//   - "Sweet 16", "Quinceañera"               -> SEXUAL (minors-adjacent)
// Removing them keeps the catalog clean rather than relying on the
// guardrail to ignore false positives at runtime.
const occasions = [
  "Wedding", "Birthday Party", "Baby Shower", "Graduation", "Halloween",
  "Christmas", "Easter", "Anniversary", "Retirement", "Bridal Shower",
  "Engagement", "First Birthday", "Cinco de Mayo", "Thanksgiving",
  "New Year", "Valentine's Day", "St. Patrick's Day", "Mother's Day",
  "Father's Day", "Fourth of July", "Hanukkah", "Diwali", "Eid",
];
const productTypes = [
  "Balloons", "Tableware", "Decorations", "Party Packs", "Costumes",
  "Banners", "Centerpieces", "Photo Props", "Confetti", "Streamers",
  "Cake Toppers", "Favor Bags", "Piñatas", "Tablecloths", "Napkins",
  "Cups", "Plates", "Garlands", "Backdrops", "Lighting",
];
const adjectives = [
  "Premium", "Deluxe", "Classic", "Elegant", "Rustic", "Modern", "Vintage",
  "Festive", "Sparkling", "Charming", "Fancy", "Trendy", "Bold", "Soft",
  "Bright", "Glittery", "Metallic", "Holographic", "Rainbow", "Pastel",
];
const guestCounts = ["8", "12", "16", "20", "24", "30", "50", "100"];
const sizes = ["Small", "Medium", "Large", "X-Large", "Mini", "Jumbo", "Standard"];
const ageGroups = ["Kids", "Teens", "Adults", "All Ages", "3-10", "10-18", "Adult"];
const genders = ["Male", "Female", "Unisex"];
const indoorOutdoor = ["Indoor", "Outdoor", "Indoor Outdoor"];
const availability = ["in stock", "in stock", "in stock", "out of stock"]; // ~75% in stock

// Customer pools
const customerTypes = ["CONSUMER", "BUSINESS"];
const segments = ["PREMIUM", "STANDARD", "BUDGET", "B2B"];
const priceAffinities = ["LOW", "MID", "HIGH", "BULK"];
const discountAffinities = ["LOW", "MID", "HIGH"];
const cities: Array<[string, string]> = [
  ["Seattle", "WA"], ["Portland", "OR"], ["San Francisco", "CA"],
  ["Los Angeles", "CA"], ["San Diego", "CA"], ["Austin", "TX"],
  ["Houston", "TX"], ["Dallas", "TX"], ["Miami", "FL"], ["Orlando", "FL"],
  ["Denver", "CO"], ["Boulder", "CO"], ["Nashville", "TN"], ["Memphis", "TN"],
  ["Chicago", "IL"], ["Phoenix", "AZ"], ["Atlanta", "GA"], ["Charlotte", "NC"],
  ["Boston", "MA"], ["New York", "NY"], ["Philadelphia", "PA"],
  ["Detroit", "MI"], ["Minneapolis", "MN"], ["Salt Lake City", "UT"],
  ["Las Vegas", "NV"], ["Portland", "ME"], ["Burlington", "VT"],
];

// ─── Generate one product row keyed off the sample header order ─────────────
function generateProduct(index: number, headers: string[]): string[] {
  const id = `PROD-${(100 + index).toString().padStart(7, "0")}`;
  const productType = pick(productTypes);
  const adjective = pick(adjectives);
  const color = pick(colors);
  const theme = pick(themes);
  const occasion = pick(occasions);
  const size = pick(sizes);
  const guestCount = pick(guestCounts);
  const ageGroup = pick(ageGroups);
  const gender = pick(genders);
  const inOut = pick(indoorOutdoor);
  const avail = pick(availability);
  const price = randFloat(5, 200);
  const onSale = Math.random() < 0.3;
  const salePrice = onSale ? parseFloat((price * randFloat(0.5, 0.9)).toFixed(2)) : "";

  const title = `${adjective} ${color} ${theme} ${productType} - ${guestCount} Pack`;
  const description = `${title}. Perfect for ${occasion.toLowerCase()} celebrations. Includes everything you need for ${guestCount} guests. High-quality ${color.toLowerCase()} ${productType.toLowerCase()} designed with a ${theme.toLowerCase()} aesthetic. Suitable for ${ageGroup.toLowerCase()}.`;

  // Build value map keyed by header name
  const m: Record<string, string> = {
    BUSINESS_UNIT: "PSC",
    ITEM_GROUP_ID: (13700000 + index).toString(),
    ITEM_ID: id,
    MPN: id,
    TITLE: title,
    MFTR: "Party Supply Company",
    IMAGE_LINK: `https://example.com/images/prod-${index}.jpg`,
    LINK: `https://example.com/products/prod-${index}`,
    DESCRIPTION: description,
    PRICE: price.toString(),
    SALE_PRICE: salePrice.toString(),
    PRODUCT_TYPE: `Party Supplies > ${productType} > ${theme}`,
    CATEGORY_L1: "Party Supplies",
    CATEGORY_L2: productType,
    CATEGORY_L3: theme,
    CATEGORY_L4: "",
    CATEGORY_L5: "",
    AVAILABILITY: avail,
    REVIEW_RATING: randFloat(3.5, 5.0, 1).toString(),
    OVERWEIGHT_PRICE: "",
    IS_BUNDLE: Math.random() < 0.2 ? "Yes" : "",
    BRAND: "PSC",
    CHARACTERS: "",
    COLOR: color,
    MATERIAL: pick(["Latex", "Paper", "Plastic", "Polyester", "Mixed", "Cardstock", "Glass"]),
    SPECIAL_OCCASION_OR_EVENT: occasion,
    THEME: theme,
    POPULAR_COLLECTIONS: pick(["Premium Collection", "Wedding Collection", "Kids Favorites", "Trending", "Seasonal", ""]),
    BULK_ASSORTMENTS: Math.random() < 0.5 ? "Bulk" : "",
    HOLIDAYS: "",
    NOW_ON_SALE: onSale ? "Yes" : "",
    NUMBER_OF_GUESTS: guestCount,
    AWARENESS: "",
    SCHOOL_EVENT: "",
    FOR_WHOM: ageGroup,
    AGE_GROUP: ageGroup,
    GENDER: gender,
    SIZES: size,
    SIZE: size,
    POPULAR_COSTUMES: "",
    TODDLER_SIZE: "",
    PATTERN: pick(["Solid", "Striped", "Polka Dot", "Floral", "Geometric", ""]),
    POPULAR_KEYWORDS: `${theme.toLowerCase()},${color.toLowerCase()},${productType.toLowerCase()}`,
    WEDDING: occasion === "Wedding" ? "Yes" : "",
    YOUTH_SIZE: "",
    ADDITIONAL_SIZE_OPTIONS: "",
    BABY_SIZE: "",
    WOMENS_SIZE: "",
    DIVISION: "",
    SEASON: pick(["Spring", "Summer", "Fall", "Winter", "All", ""]),
    CURRICULUM_PROJECTS_ACTIVITIES: "",
    TARGETED_LEARNING: "",
    SPECIALTY_COSTUME: "",
    AGE_RECOMMENDATION: pick(["3+", "5+", "10+", "Teen Adult", "All Ages"]),
    GRADE: "",
    FAITH_BASED_EVENT: "",
    SPORTS: "",
    GROUP_SIZE: guestCount,
    FLAVOR: "",
    BIRTHDAY: occasion.includes("Birthday") ? "Yes" : "",
    COLOR_COMBINATIONS: "",
    MILESTONE_BIRTHDAY: "",
    LEARNING_ENVIRONMENT: "",
    DIETARY_NEEDS: "",
    INDUSTRY_TYPE: "",
    LANGUAGE_ARTS_CATEGORY: "",
    ROOM: "",
    MATH_CATEGORY: "",
    TREE_TYPE: "",
    TREE_HEIGHT: "",
    SPECIALITY_TREES: "",
    SPORTS_TEAM: "",
    INDOOR_OUTDOOR_USE: inOut,
    CONTENT: "",
    AWARDS: "",
    DISPLAY_TYPE: "",
    SOCIAL_STUDIES_CATEGORY: "",
    CRAFT_TYPE: "",
    SCIENCE_CATEGORY: "",
    CLASSROOM_ESSENTIALS: "",
    PAINT_TYPE: "",
    NUMBER_OF_PLAYERS: "",
    WIG_STYLE: "",
  };

  return headers.map((h) => m[h] ?? "");
}

function generateCustomer(index: number, headers: string[]): string[] {
  const id = `CUST-${(100000 + index).toString()}`;
  const cType = pick(customerTypes);
  const segment = cType === "BUSINESS" ? "B2B" : pick(["PREMIUM", "STANDARD", "BUDGET"]);
  const [city, state] = pick(cities);
  const accountAge = randInt(30, 1825);
  const orderCount = segment === "B2B" ? randInt(20, 100) :
    segment === "PREMIUM" ? randInt(10, 30) :
    segment === "STANDARD" ? randInt(3, 15) : randInt(1, 5);
  const avgOrderValue = segment === "B2B" ? randFloat(150, 500) :
    segment === "PREMIUM" ? randFloat(80, 200) :
    segment === "STANDARD" ? randFloat(40, 100) : randFloat(20, 60);
  const lifetimeSpend = parseFloat((orderCount * avgOrderValue).toFixed(2));

  const m: Record<string, string> = {
    USER_ID: id,
    CUSTOMER_TYPE: cType,
    CUSTOMER_SEGMENT: segment,
    BUSINESS_UNIT: "PSC",
    PREFERRED_CATEGORY_L1: "Party Supplies",
    PREFERRED_CATEGORY_L2: pick(productTypes),
    PREFERRED_OCCASION: pick(occasions),
    PREFERRED_THEME: pick(themes),
    PRICE_AFFINITY: segment === "B2B" ? "BULK" : pick(priceAffinities),
    DISCOUNT_AFFINITY: pick(discountAffinities),
    REGION: city,
    STATE: state,
    ACCOUNT_AGE_DAYS: accountAge.toString(),
    LIFETIME_ORDER_COUNT: orderCount.toString(),
    LIFETIME_SPEND: lifetimeSpend.toString(),
    AVG_ORDER_VALUE: avgOrderValue.toString(),
    DAYS_SINCE_LAST_ORDER: randInt(0, 365).toString(),
    EMAIL_OPT_IN: Math.random() < 0.8 ? "Y" : "N",
  };

  return headers.map((h) => m[h] ?? "");
}

// ─── Interactions ───────────────────────────────────────────────────────────
//
// Each row is one user/item event. Distribution mirrors typical e-commerce
// funnels: ~70% views, ~20% add_to_cart, ~10% purchase. RECOMMENDATION_ID
// is populated for ~30% of events to simulate "discovered via X" tracking.

const interactionHeaders = [
  "USER_ID",
  "ITEM_ID",
  "TIMESTAMP",
  "EVENT_TYPE",
  "EVENT_VALUE",
  "QUANTITY",
  "PRICE",
  "RECOMMENDATION_ID",
];

const eventTypes = [
  // Weighted: more views than purchases, like real funnels
  "view", "view", "view", "view", "view", "view", "view",
  "add_to_cart", "add_to_cart",
  "purchase",
];

const eventValueByType: Record<string, string> = {
  view: "1.0",
  add_to_cart: "2.0",
  purchase: "5.0",
};

const recommendationSources = [
  "Recently Viewed",
  "Frequently Bought Together",
  "Customers Also Bought",
  "Trending Now",
  "Picked For You",
  "Search Results",
];

/**
 * Build a function that generates interaction rows referencing the given
 * customer and product ID pools. Both pools are arrays of strings; each
 * row picks one user and one item at random and emits an event for them.
 *
 * Timestamps are spread across the past 90 days (epoch seconds) so the
 * agent has a notion of recency.
 */
function makeInteractionGenerator(userIds: string[], itemIds: string[], itemPrices: Record<string, number>) {
  const now = Math.floor(Date.now() / 1000);
  const NINETY_DAYS = 90 * 24 * 60 * 60;

  return function generateInteraction(_index: number): string[] {
    const userId = pick(userIds);
    const itemId = pick(itemIds);
    const eventType = pick(eventTypes);
    const eventValue = eventValueByType[eventType];
    const quantity = eventType === "view" ? "0" : randInt(1, 3).toString();
    const price = itemPrices[itemId]?.toFixed(2) ?? randFloat(5, 200).toFixed(2);
    const timestamp = (now - randInt(0, NINETY_DAYS)).toString();
    // ~30% of events have a recommendation source, the rest are organic
    const recommendationId = Math.random() < 0.3 ? pick(recommendationSources) : "";

    return [
      userId,
      itemId,
      timestamp,
      eventType,
      eventValue,
      quantity,
      price,
      recommendationId,
    ];
  };
}

// ─── ID + price extraction from generated CSVs ──────────────────────────────
//
// After we generate products.csv and customers.csv we read them back to get
// the ID space the interactions should reference. Reading the CSV instead
// of recomputing from generator state means interactions stay coherent
// even if you re-run the generator with different sizes.

interface IdPool {
  userIds: string[];
  itemIds: string[];
  itemPrices: Record<string, number>;
}

function loadIdPool(productPath: string, customerPath: string): IdPool {
  const products = parseCsv(productPath);
  const customers = parseCsv(customerPath);

  const itemIdIdx = products.headers.indexOf("ITEM_ID");
  const priceIdx = products.headers.indexOf("PRICE");
  const userIdIdx = customers.headers.indexOf("USER_ID");

  const itemIds: string[] = [];
  const itemPrices: Record<string, number> = {};
  for (const row of products.rows) {
    const id = row[itemIdIdx];
    if (id) {
      itemIds.push(id);
      const price = parseFloat(row[priceIdx]);
      if (!Number.isNaN(price)) itemPrices[id] = price;
    }
  }

  const userIds = customers.rows
    .map((row) => row[userIdIdx])
    .filter((v) => Boolean(v));

  return { userIds, itemIds, itemPrices };
}

// ─── Streamed writes ─────────────────────────────────────────────────────────
function writeRowsStreamed(
  outPath: string,
  headers: string[],
  count: number,
  generator: (i: number, h: string[]) => string[],
  label: string
) {
  const stream = createWriteStream(outPath);
  stream.write(headers.map(escapeCsv).join(",") + "\n");

  let last = Date.now();
  for (let i = 0; i < count; i++) {
    const row = generator(i, headers);
    stream.write(row.map(escapeCsv).join(",") + "\n");

    if (i > 0 && i % 10000 === 0) {
      const elapsed = ((Date.now() - last) / 1000).toFixed(1);
      console.log(`  ${label}: ${i.toLocaleString()}/${count.toLocaleString()} (+10k in ${elapsed}s)`);
      last = Date.now();
    }
  }

  return new Promise<void>((resolve, reject) => {
    stream.end(() => resolve());
    stream.on("error", reject);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Reading sample CSV headers...");
  const productSample = parseCsv("uploads/sample-products.csv");
  const customerSample = parseCsv("uploads/sample-customers.csv");
  console.log(`  Products header: ${productSample.headers.length} columns`);
  console.log(`  Customers header: ${customerSample.headers.length} columns`);

  console.log(`\nGenerating ${NUM_PRODUCTS.toLocaleString()} products → uploads/products.csv`);
  const t1 = Date.now();
  await writeRowsStreamed(
    "uploads/products.csv",
    productSample.headers,
    NUM_PRODUCTS,
    generateProduct,
    "products"
  );
  console.log(`  ✓ Done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  console.log(`\nGenerating ${NUM_CUSTOMERS.toLocaleString()} customers → uploads/customers.csv`);
  const t2 = Date.now();
  await writeRowsStreamed(
    "uploads/customers.csv",
    customerSample.headers,
    NUM_CUSTOMERS,
    generateCustomer,
    "customers"
  );
  console.log(`  ✓ Done in ${((Date.now() - t2) / 1000).toFixed(1)}s`);

  // Bulk interactions reference the bulk catalog/customer IDs we just wrote.
  console.log(`\nGenerating ${NUM_INTERACTIONS.toLocaleString()} interactions → uploads/interactions.csv`);
  const t3 = Date.now();
  console.log("  Loading ID pool from generated products + customers...");
  const bulkPool = loadIdPool("uploads/products.csv", "uploads/customers.csv");
  console.log(`  Pool: ${bulkPool.userIds.length.toLocaleString()} users × ${bulkPool.itemIds.length.toLocaleString()} items`);
  const generateBulkInteraction = makeInteractionGenerator(
    bulkPool.userIds,
    bulkPool.itemIds,
    bulkPool.itemPrices
  );
  await writeRowsStreamed(
    "uploads/interactions.csv",
    interactionHeaders,
    NUM_INTERACTIONS,
    generateBulkInteraction,
    "interactions"
  );
  console.log(`  ✓ Done in ${((Date.now() - t3) / 1000).toFixed(1)}s`);

  // Sample interactions reference the small sample CSVs (CUST-1001..1010,
  // PROD-101..110). These are useful for unit-test-sized smoke tests where
  // you don't want to push 25K rows through the batch pipeline.
  console.log(`\nGenerating ${NUM_SAMPLE_INTERACTIONS.toLocaleString()} sample interactions → uploads/sample-interactions.csv`);
  const t4 = Date.now();
  const samplePool = loadIdPool("uploads/sample-products.csv", "uploads/sample-customers.csv");
  console.log(`  Pool: ${samplePool.userIds.length} users × ${samplePool.itemIds.length} items`);
  const generateSampleInteraction = makeInteractionGenerator(
    samplePool.userIds,
    samplePool.itemIds,
    samplePool.itemPrices
  );
  await writeRowsStreamed(
    "uploads/sample-interactions.csv",
    interactionHeaders,
    NUM_SAMPLE_INTERACTIONS,
    generateSampleInteraction,
    "sample-interactions"
  );
  console.log(`  ✓ Done in ${((Date.now() - t4) / 1000).toFixed(1)}s`);

  console.log("\nNext step:");
  console.log("  ./scripts/batch-import.sh \\");
  console.log("    -p uploads/products.csv \\");
  console.log("    -c uploads/customers.csv \\");
  console.log("    -i uploads/interactions.csv \\");
  console.log("    --mode replace");
}

main().catch((err) => {
  console.error("Generation failed:", err);
  process.exit(1);
});
