/**
 * Generate Seed Data with Embeddings
 *
 * Creates party supply product, order, and customer profile data,
 * generates embeddings using Amazon Titan Text Embeddings V2,
 * and outputs JSON files ready for upload to S3 Vectors.
 *
 * Supports both built-in sample data and imported CSV data.
 *
 * Usage:
 *   npx tsx scripts/generate-seed-data.ts [--use-imported]
 *
 * Options:
 *   --use-imported  Use data from *-raw.json files (from import-csv-data.ts)
 *                   instead of built-in sample data
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";

const REGION = process.env.AWS_REGION || "us-west-2";
const EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0";
const OUTPUT_DIR = "./seed-data";

// Adaptive retry so bulk seed generation doesn't fail on transient
// Bedrock ThrottlingException. Default retry mode is "standard" with 3
// attempts, which is not enough for backfill-style loops that fire
// hundreds of InvokeModel calls back-to-back.
const bedrockClient = new BedrockRuntimeClient({
  region: REGION,
  maxAttempts: 10,
  retryMode: "adaptive",
});

// ─── Type Definitions ───────────────────────────────────────────────────────

/**
 * Extended Product interface supporting both simple and rich schemas
 */
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
  category?: string; // Simple schema
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

/**
 * Order interface
 */
interface Order {
  id: string;
  customerId: string;
  customerName: string;
  items: { productId: string; productName: string; quantity: number; price: number }[];
  total: number;
  status: string;
  orderDate: string;
  deliveryDate: string;
  shippingAddress: string;
  notes: string;
}

/**
 * Customer profile interface
 */
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

/**
 * One user-item event. Each row in the customer's interactions CSV (or a
 * synthesized seed event) becomes one of these. The embedding text and
 * metadata shape mirror what glue-jobs/dedup-prepare.py and upload-vectors.py
 * produce, so the seed and the bulk pipeline are interchangeable downstream.
 */
interface Interaction {
  userId: string;
  itemId: string;
  timestamp: number; // epoch seconds
  eventType: "view" | "add_to_cart" | "purchase";
  eventValue: number;
  quantity: number;
  price: number;
  recommendationId?: string;
}

// ─── Sample Data ────────────────────────────────────────────────────────────

const sampleProducts: Product[] = [
  {
    id: "PROD-001",
    name: "Rainbow Balloon Arch Kit",
    category: "Balloons",
    theme: "Birthday",
    description:
      "Complete rainbow balloon arch kit with 120 latex balloons in assorted colors, balloon strip, glue dots, and tying tool. Perfect for birthday party entrances and photo backdrops.",
    price: 34.99,
    inStock: true,
    quantity: 250,
  },
  {
    id: "PROD-002",
    name: "Gold Confetti Balloons (Pack of 20)",
    category: "Balloons",
    theme: "Wedding",
    description:
      "Elegant 12-inch clear latex balloons pre-filled with gold confetti. Ideal for weddings, anniversaries, and upscale celebrations. Includes ribbon.",
    price: 14.99,
    inStock: true,
    quantity: 500,
  },
  {
    id: "PROD-003",
    name: "Spooky Halloween Decoration Set",
    category: "Decorations",
    theme: "Halloween",
    description:
      "Complete Halloween decoration set including spider webs, hanging ghosts, bat cutouts, and LED orange string lights. Covers up to 200 sq ft.",
    price: 49.99,
    inStock: true,
    quantity: 150,
  },
  {
    id: "PROD-004",
    name: "Princess Castle Tableware Set (Serves 16)",
    category: "Tableware",
    theme: "Princess",
    description:
      "Pink and purple princess-themed tableware set including plates, cups, napkins, tablecloth, and centerpiece. Serves 16 guests. BPA-free materials.",
    price: 29.99,
    inStock: true,
    quantity: 300,
  },
  {
    id: "PROD-005",
    name: "Tropical Luau Party Pack",
    category: "Party Packs",
    theme: "Tropical",
    description:
      "Everything you need for a tropical luau party: grass skirts, leis, tiki torches (LED), palm leaf plates, coconut cups, and tropical banner. Serves 12.",
    price: 59.99,
    inStock: true,
    quantity: 100,
  },
  {
    id: "PROD-006",
    name: "Superhero Photo Booth Props",
    category: "Photo Props",
    theme: "Superhero",
    description:
      "30-piece superhero photo booth prop set with masks, speech bubbles, capes on sticks, and pow/bam signs. Great for kids and adult parties.",
    price: 12.99,
    inStock: true,
    quantity: 400,
  },
  {
    id: "PROD-007",
    name: "Elegant White Wedding Arch Draping",
    category: "Decorations",
    theme: "Wedding",
    description:
      "Sheer white chiffon fabric draping for wedding arches and ceremony backdrops. 20 feet long, 5 feet wide. Machine washable and reusable.",
    price: 24.99,
    inStock: true,
    quantity: 200,
  },
  {
    id: "PROD-008",
    name: "Dinosaur Birthday Party Bundle",
    category: "Party Packs",
    theme: "Dinosaur",
    description:
      "Roar-some dinosaur party bundle with dino plates, cups, napkins, favor bags, stickers, and inflatable T-Rex. Serves 20 guests.",
    price: 44.99,
    inStock: true,
    quantity: 175,
  },
  {
    id: "PROD-009",
    name: "New Year's Eve Countdown Kit",
    category: "Party Packs",
    theme: "New Year",
    description:
      "Ring in the new year with this countdown kit: includes party hats, noisemakers, confetti poppers, 2025 glasses, and a countdown clock banner. For 10 guests.",
    price: 39.99,
    inStock: false,
    quantity: 0,
  },
  {
    id: "PROD-010",
    name: "Unicorn Piñata with Candy Fill",
    category: "Games & Activities",
    theme: "Unicorn",
    description:
      "Large unicorn-shaped piñata pre-filled with assorted candy and small toys. Includes blindfold and bat. Holds up to 3 lbs of treats.",
    price: 32.99,
    inStock: true,
    quantity: 80,
  },
  {
    id: "PROD-011",
    name: "Corporate Event Banner Kit",
    category: "Banners",
    theme: "Corporate",
    description:
      "Professional customizable banner kit for corporate events. Includes letter stencils, metallic markers, and premium cardstock in navy, silver, and white.",
    price: 22.99,
    inStock: true,
    quantity: 350,
  },
  {
    id: "PROD-012",
    name: "Baby Shower Gender Reveal Poppers (Set of 4)",
    category: "Confetti & Poppers",
    theme: "Baby Shower",
    description:
      "Gender reveal confetti poppers - 2 pink and 2 blue. Biodegradable tissue paper confetti shoots up to 15 feet. Safe twist-to-pop mechanism.",
    price: 18.99,
    inStock: true,
    quantity: 600,
  },
  {
    id: "PROD-013",
    name: "Glow Party Neon Supplies Kit",
    category: "Party Packs",
    theme: "Glow Party",
    description:
      "Ultimate glow party kit with 50 glow sticks, UV reactive plates and cups, neon garland, blacklight-responsive tablecloth, and face paint. Serves 15.",
    price: 54.99,
    inStock: true,
    quantity: 120,
  },
  {
    id: "PROD-014",
    name: "Vintage Tea Party Set",
    category: "Tableware",
    theme: "Tea Party",
    description:
      "Charming vintage floral tea party set with scalloped paper plates, teacup-shaped napkins, doily placemats, and tiered serving stand. Serves 8.",
    price: 27.99,
    inStock: true,
    quantity: 220,
  },
  {
    id: "PROD-015",
    name: "Space Galaxy Ceiling Decorations",
    category: "Decorations",
    theme: "Space",
    description:
      "Transform any room into outer space with hanging planets, glow-in-the-dark stars, rocket ship cutouts, and a galaxy swirl backdrop. Covers 150 sq ft ceiling.",
    price: 36.99,
    inStock: true,
    quantity: 160,
  },
  {
    id: "PROD-016",
    name: "Fiesta Mexican Party Decorations",
    category: "Decorations",
    theme: "Fiesta",
    description:
      "Colorful fiesta decoration set with papel picado banners, tissue paper flowers, cactus centerpieces, and sombrero garland. Vibrant reds, greens, and yellows.",
    price: 31.99,
    inStock: true,
    quantity: 190,
  },
  {
    id: "PROD-017",
    name: "Frozen Ice Princess Party Favors (12 Pack)",
    category: "Party Favors",
    theme: "Frozen",
    description:
      "Ice princess party favor bags with snowflake bracelets, mini tiaras, ice crystal stickers, and blue rock candy. Set of 12 pre-filled bags.",
    price: 24.99,
    inStock: true,
    quantity: 280,
  },
  {
    id: "PROD-018",
    name: "BBQ Cookout Paper Goods Set",
    category: "Tableware",
    theme: "BBQ",
    description:
      "Summer BBQ themed paper goods with gingham check plates, hot dog and burger napkins, red solo-style cups, and checkered tablecloth. Serves 24.",
    price: 19.99,
    inStock: true,
    quantity: 450,
  },
  {
    id: "PROD-019",
    name: "Graduation Cap Confetti & Streamer Pack",
    category: "Confetti & Poppers",
    theme: "Graduation",
    description:
      "Celebrate graduates with metallic graduation cap confetti, diploma-shaped streamers, and star garland in black and gold. Includes table scatter.",
    price: 15.99,
    inStock: true,
    quantity: 500,
  },
  {
    id: "PROD-020",
    name: "Under the Sea Mermaid Party Kit",
    category: "Party Packs",
    theme: "Mermaid",
    description:
      "Dive into fun with this mermaid party kit: iridescent plates, shell-shaped cups, seaweed streamers, mermaid tail favor bags, and bubble wands. Serves 12.",
    price: 42.99,
    inStock: true,
    quantity: 140,
  },
];

const sampleOrders: Order[] = [
  {
    id: "ORD-10001",
    customerId: "CUST-201",
    customerName: "Sarah Johnson",
    items: [
      { productId: "PROD-001", productName: "Rainbow Balloon Arch Kit", quantity: 2, price: 34.99 },
      { productId: "PROD-008", productName: "Dinosaur Birthday Party Bundle", quantity: 1, price: 44.99 },
    ],
    total: 114.97,
    status: "Delivered",
    orderDate: "2025-04-15",
    deliveryDate: "2025-04-18",
    shippingAddress: "123 Oak Street, Portland, OR 97201",
    notes: "Birthday party for 5-year-old. Requested gift wrapping.",
  },
  {
    id: "ORD-10002",
    customerId: "CUST-202",
    customerName: "Michael Chen",
    items: [
      { productId: "PROD-002", productName: "Gold Confetti Balloons (Pack of 20)", quantity: 5, price: 14.99 },
      { productId: "PROD-007", productName: "Elegant White Wedding Arch Draping", quantity: 3, price: 24.99 },
    ],
    total: 149.92,
    status: "Shipped",
    orderDate: "2025-05-01",
    deliveryDate: "2025-05-06",
    shippingAddress: "456 Maple Ave, Seattle, WA 98101",
    notes: "Wedding reception on May 10th. Please ensure delivery before the 6th.",
  },
  {
    id: "ORD-10003",
    customerId: "CUST-203",
    customerName: "Emily Rodriguez",
    items: [
      { productId: "PROD-005", productName: "Tropical Luau Party Pack", quantity: 3, price: 59.99 },
      { productId: "PROD-018", productName: "BBQ Cookout Paper Goods Set", quantity: 2, price: 19.99 },
    ],
    total: 219.95,
    status: "Processing",
    orderDate: "2025-05-10",
    deliveryDate: "2025-05-15",
    shippingAddress: "789 Palm Drive, Miami, FL 33101",
    notes: "Company summer party for 50 people. Bulk order.",
  },
  {
    id: "ORD-10004",
    customerId: "CUST-204",
    customerName: "David Kim",
    items: [
      { productId: "PROD-003", productName: "Spooky Halloween Decoration Set", quantity: 4, price: 49.99 },
      { productId: "PROD-013", productName: "Glow Party Neon Supplies Kit", quantity: 2, price: 54.99 },
    ],
    total: 309.94,
    status: "Pending",
    orderDate: "2025-05-12",
    deliveryDate: "2025-05-20",
    shippingAddress: "321 Elm Street, Austin, TX 78701",
    notes: "Halloween-themed glow party. Need everything by Oct 28.",
  },
  {
    id: "ORD-10005",
    customerId: "CUST-205",
    customerName: "Jessica Williams",
    items: [
      { productId: "PROD-012", productName: "Baby Shower Gender Reveal Poppers (Set of 4)", quantity: 3, price: 18.99 },
      { productId: "PROD-002", productName: "Gold Confetti Balloons (Pack of 20)", quantity: 2, price: 14.99 },
    ],
    total: 86.95,
    status: "Delivered",
    orderDate: "2025-04-20",
    deliveryDate: "2025-04-23",
    shippingAddress: "555 Birch Lane, Denver, CO 80201",
    notes: "Gender reveal party. Very excited!",
  },
  {
    id: "ORD-10006",
    customerId: "CUST-206",
    customerName: "Corporate Events Inc.",
    items: [
      { productId: "PROD-011", productName: "Corporate Event Banner Kit", quantity: 10, price: 22.99 },
      { productId: "PROD-019", productName: "Graduation Cap Confetti & Streamer Pack", quantity: 8, price: 15.99 },
    ],
    total: 357.82,
    status: "Shipped",
    orderDate: "2025-05-05",
    deliveryDate: "2025-05-09",
    shippingAddress: "100 Business Park Blvd, San Francisco, CA 94102",
    notes: "Annual company graduation celebration. Need invoice for accounting.",
  },
  {
    id: "ORD-10007",
    customerId: "CUST-207",
    customerName: "Amanda Foster",
    items: [
      { productId: "PROD-004", productName: "Princess Castle Tableware Set (Serves 16)", quantity: 2, price: 29.99 },
      { productId: "PROD-017", productName: "Frozen Ice Princess Party Favors (12 Pack)", quantity: 2, price: 24.99 },
      { productId: "PROD-010", productName: "Unicorn Piñata with Candy Fill", quantity: 1, price: 32.99 },
    ],
    total: 142.95,
    status: "Processing",
    orderDate: "2025-05-11",
    deliveryDate: "2025-05-16",
    shippingAddress: "222 Rose Court, Nashville, TN 37201",
    notes: "Daughter's 7th birthday princess party. 30 kids expected.",
  },
  {
    id: "ORD-10008",
    customerId: "CUST-208",
    customerName: "Robert Martinez",
    items: [
      { productId: "PROD-015", productName: "Space Galaxy Ceiling Decorations", quantity: 2, price: 36.99 },
      { productId: "PROD-006", productName: "Superhero Photo Booth Props", quantity: 3, price: 12.99 },
    ],
    total: 112.95,
    status: "Delivered",
    orderDate: "2025-04-25",
    deliveryDate: "2025-04-28",
    shippingAddress: "888 Star Way, Houston, TX 77001",
    notes: "Space and superhero themed party for twins turning 8.",
  },
  {
    id: "ORD-10009",
    customerId: "CUST-209",
    customerName: "Lisa Thompson",
    items: [
      { productId: "PROD-014", productName: "Vintage Tea Party Set", quantity: 4, price: 27.99 },
      { productId: "PROD-016", productName: "Fiesta Mexican Party Decorations", quantity: 1, price: 31.99 },
    ],
    total: 143.95,
    status: "Shipped",
    orderDate: "2025-05-08",
    deliveryDate: "2025-05-12",
    shippingAddress: "444 Garden Path, Charlotte, NC 28201",
    notes: "Bridal shower with a tea party and fiesta fusion theme.",
  },
  {
    id: "ORD-10010",
    customerId: "CUST-210",
    customerName: "James Wilson",
    items: [
      { productId: "PROD-020", productName: "Under the Sea Mermaid Party Kit", quantity: 2, price: 42.99 },
      { productId: "PROD-001", productName: "Rainbow Balloon Arch Kit", quantity: 1, price: 34.99 },
    ],
    total: 120.97,
    status: "Pending",
    orderDate: "2025-05-13",
    deliveryDate: "2025-05-18",
    shippingAddress: "777 Ocean Blvd, San Diego, CA 92101",
    notes: "Pool party with mermaid theme. Need waterproof items if possible.",
  },
];

const sampleCustomers: CustomerProfile[] = [
  {
    userId: "CUST-201",
    customerType: "CONSUMER",
    customerSegment: "CONSUMER",
    preferredCategoryL1: "Party Packs",
    preferredTheme: "Birthday",
    priceAffinity: "MID",
    region: "Portland",
    state: "OR",
    accountAgeDays: 365,
    lifetimeOrderCount: 5,
    lifetimeSpend: 450.00,
    avgOrderValue: 90.00,
    daysSinceLastOrder: 30,
    emailOptIn: true,
  },
  {
    userId: "CUST-202",
    customerType: "CONSUMER",
    customerSegment: "CONSUMER",
    preferredCategoryL1: "Decorations",
    preferredTheme: "Wedding",
    priceAffinity: "HIGH",
    region: "Seattle",
    state: "WA",
    accountAgeDays: 180,
    lifetimeOrderCount: 2,
    lifetimeSpend: 300.00,
    avgOrderValue: 150.00,
    daysSinceLastOrder: 15,
    emailOptIn: true,
  },
  {
    userId: "CUST-206",
    customerType: "BUSINESS",
    customerSegment: "B2B",
    businessUnit: "Corporate",
    preferredCategoryL1: "Banners",
    preferredTheme: "Corporate",
    priceAffinity: "BULK",
    region: "San Francisco",
    state: "CA",
    accountAgeDays: 730,
    lifetimeOrderCount: 24,
    lifetimeSpend: 8500.00,
    avgOrderValue: 354.00,
    daysSinceLastOrder: 45,
    emailOptIn: true,
  },
];

// ─── Embedding Generation ───────────────────────────────────────────────────

async function generateEmbedding(text: string): Promise<number[]> {
  const payload = {
    inputText: text,
    dimensions: 1024,
    normalize: true,
  };

  const command = new InvokeModelCommand({
    modelId: EMBEDDING_MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(payload),
  });

  const response = await bedrockClient.send(command);
  const responseBody = JSON.parse(new TextDecoder().decode(response.body));
  return responseBody.embedding;
}

/**
 * Convert product to searchable text for embedding
 * Handles both simple and rich schemas
 */
function productToText(product: Product): string {
  const parts: string[] = [`Product: ${product.name}`];

  // Category (support both schemas)
  const category = product.category || product.categoryL1;
  if (category) parts.push(`Category: ${category}`);
  if (product.categoryL2) parts.push(`> ${product.categoryL2}`);
  if (product.categoryL3) parts.push(`> ${product.categoryL3}`);

  // Theme and occasion
  if (product.theme) parts.push(`Theme: ${product.theme}`);
  if (product.occasion) parts.push(`Occasion: ${product.occasion}`);
  if (product.holiday) parts.push(`Holiday: ${product.holiday}`);

  // Description
  parts.push(`Description: ${product.description}`);

  // Price
  parts.push(`Price: $${product.price}`);
  if (product.salePrice) parts.push(`Sale Price: $${product.salePrice}`);

  // Attributes
  if (product.color) parts.push(`Color: ${product.color}`);
  if (product.material) parts.push(`Material: ${product.material}`);
  if (product.forWhom) parts.push(`For: ${product.forWhom}`);
  if (product.ageGroup) parts.push(`Age Group: ${product.ageGroup}`);

  // Availability
  parts.push(product.inStock ? "In stock" : "Out of stock");
  if (product.quantity !== undefined) parts.push(`Quantity: ${product.quantity}`);

  // Brand/manufacturer
  if (product.brand) parts.push(`Brand: ${product.brand}`);
  if (product.manufacturer) parts.push(`Manufacturer: ${product.manufacturer}`);

  return parts.join(". ");
}

function orderToText(order: Order): string {
  const itemsList = order.items
    .map((i) => `${i.productName} (x${i.quantity})`)
    .join(", ");
  return `Order ${order.id} by ${order.customerName}. Items: ${itemsList}. Total: $${order.total}. Status: ${order.status}. Ordered: ${order.orderDate}. Delivery: ${order.deliveryDate}. Address: ${order.shippingAddress}. Notes: ${order.notes}`;
}

/**
 * Convert customer profile to searchable text for embedding
 */
function customerToText(customer: CustomerProfile): string {
  const parts: string[] = [`Customer: ${customer.userId}`];

  if (customer.customerType) parts.push(`Type: ${customer.customerType}`);
  if (customer.customerSegment) parts.push(`Segment: ${customer.customerSegment}`);

  // Preferences
  if (customer.preferredCategoryL1) parts.push(`Preferred Category: ${customer.preferredCategoryL1}`);
  if (customer.preferredTheme) parts.push(`Preferred Theme: ${customer.preferredTheme}`);
  if (customer.preferredOccasion) parts.push(`Preferred Occasion: ${customer.preferredOccasion}`);

  // Price sensitivity
  if (customer.priceAffinity) parts.push(`Price Affinity: ${customer.priceAffinity}`);
  if (customer.discountAffinity) parts.push(`Discount Affinity: ${customer.discountAffinity}`);

  // Location
  if (customer.region && customer.state) {
    parts.push(`Location: ${customer.region}, ${customer.state}`);
  }

  // Engagement metrics
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

/**
 * Convert product to metadata for vector storage
 */
function productToMetadata(product: Product): Record<string, string> {
  const metadata: Record<string, string> = {
    name: product.name,
    description: product.description,
    price: String(product.price),
    inStock: String(product.inStock),
  };

  // Add optional fields if present
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

/**
 * Convert customer to metadata for vector storage
 */
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

// ─── Interaction helpers ────────────────────────────────────────────────────
//
// These mirror the Glue jobs (glue-jobs/dedup-prepare.py interaction_to_text
// and glue-jobs/upload-vectors.py interaction_to_metadata) so the embedding
// shape matches whether the data comes from this seed script or the bulk
// pipeline. Keep them in sync if you change one.

const SEED_RECOMMENDATION_SOURCES = [
  "Recently Viewed",
  "Frequently Bought Together",
  "Customers Also Bought",
  "Trending Now",
  "Picked For You",
  "Search Results",
];

/** Composite vector key. The same user/item pair can recur across events
 *  (view → cart → purchase), so the timestamp keeps each event distinct. */
function interactionKey(i: Interaction): string {
  return `${i.userId}_${i.itemId}_${i.timestamp}`;
}

function interactionToText(i: Interaction): string {
  const parts = [`User ${i.userId} performed ${i.eventType} on item ${i.itemId}`];
  parts.push(`at timestamp ${i.timestamp}`);
  if (i.quantity > 0) parts.push(`quantity ${i.quantity}`);
  parts.push(`price $${i.price}`);
  if (i.recommendationId) parts.push(`via ${i.recommendationId}`);
  return parts.join(". ");
}

function interactionToMetadata(i: Interaction): Record<string, string> {
  const m: Record<string, string> = {
    userId: i.userId,
    itemId: i.itemId,
    timestamp: String(i.timestamp),
    eventType: i.eventType,
    eventValue: String(i.eventValue),
    quantity: String(i.quantity),
    price: String(i.price),
  };
  if (i.recommendationId) m.recommendationId = i.recommendationId;
  return m;
}

/**
 * Synthesize a small set of interaction events for the seed data.
 *
 * Each event references real seed products and customers so the agent's
 * `query_interactions` tool returns coherent results - the agent can
 * follow up with `search_products` or `lookup_customer` to enrich.
 *
 * Distribution roughly mirrors a real funnel (~70% views, ~20% cart,
 * ~10% purchase) so behavioral queries surface a realistic mix. Events
 * are spread across the past 60 days.
 */
function synthesizeInteractions(
  customers: CustomerProfile[],
  products: Product[],
  count: number
): Interaction[] {
  if (customers.length === 0 || products.length === 0 || count <= 0) return [];

  const out: Interaction[] = [];
  const now = Math.floor(Date.now() / 1000);
  const SIXTY_DAYS = 60 * 24 * 60 * 60;
  const eventTypeBag: Interaction["eventType"][] = [
    // Weighted bag - 7 view, 2 cart, 1 purchase per 10 events on average
    "view", "view", "view", "view", "view", "view", "view",
    "add_to_cart", "add_to_cart",
    "purchase",
  ];
  const eventValueByType: Record<Interaction["eventType"], number> = {
    view: 1.0,
    add_to_cart: 2.0,
    purchase: 5.0,
  };

  for (let i = 0; i < count; i++) {
    const customer = customers[Math.floor(Math.random() * customers.length)];
    const product = products[Math.floor(Math.random() * products.length)];
    const eventType = eventTypeBag[Math.floor(Math.random() * eventTypeBag.length)];
    const event: Interaction = {
      userId: customer.userId,
      itemId: product.id,
      timestamp: now - Math.floor(Math.random() * SIXTY_DAYS),
      eventType,
      eventValue: eventValueByType[eventType],
      quantity: eventType === "view" ? 0 : 1 + Math.floor(Math.random() * 3),
      price: product.salePrice ?? product.price,
      recommendationId:
        Math.random() < 0.3
          ? SEED_RECOMMENDATION_SOURCES[Math.floor(Math.random() * SEED_RECOMMENDATION_SOURCES.length)]
          : undefined,
    };
    out.push(event);
  }

  return out;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const useImported = args.includes("--use-imported");

  // Check for specific data type flags (used by import-csv.sh)
  // If --only-products or --only-customers is passed, only generate those types
  const onlyProducts = args.includes("--only-products");
  const onlyCustomers = args.includes("--only-customers");
  const onlyOrders = args.includes("--only-orders");
  const onlyInteractions = args.includes("--only-interactions");
  const hasOnlyFlags = onlyProducts || onlyCustomers || onlyOrders || onlyInteractions;

  // Determine what to generate. Interactions need products + customers as
  // an ID source, so when --only-interactions is set we still load (but
  // don't re-embed) the other types from the existing raw JSON files.
  // --force regenerates outputs even if the *-vectors.json file already
  // exists. Without it we skip per-type when the file is present, which
  // keeps "fill in the missing ones" re-runs cheap (only the new
  // interactions get embedded if the older 3 files are still around).
  const force = args.includes("--force") || args.includes("--force-regenerate");
  const productsAlreadyDone = !force && existsSync(`${OUTPUT_DIR}/products-vectors.json`);
  const ordersAlreadyDone = !force && existsSync(`${OUTPUT_DIR}/orders-vectors.json`);
  const customersAlreadyDone = !force && existsSync(`${OUTPUT_DIR}/customers-vectors.json`);
  const interactionsAlreadyDone = !force && existsSync(`${OUTPUT_DIR}/interactions-vectors.json`);

  const generateProducts = (!hasOnlyFlags || onlyProducts) && !productsAlreadyDone;
  const generateOrders = (!hasOnlyFlags || onlyOrders) && !ordersAlreadyDone;
  const generateCustomers = (!hasOnlyFlags || onlyCustomers) && !customersAlreadyDone;
  const generateInteractions = (!hasOnlyFlags || onlyInteractions) && !interactionsAlreadyDone;

  if (productsAlreadyDone || ordersAlreadyDone || customersAlreadyDone || interactionsAlreadyDone) {
    const skipped: string[] = [];
    if (productsAlreadyDone) skipped.push("products");
    if (ordersAlreadyDone) skipped.push("orders");
    if (customersAlreadyDone) skipped.push("customers");
    if (interactionsAlreadyDone) skipped.push("interactions");
    console.log(`Skipping (output already exists): ${skipped.join(", ")}`);
    console.log("Pass --force to regenerate.");
  }

  // How many interaction events to synthesize. Default 50 keeps the seed
  // small and the embedding pass quick (~10s); customers wanting realistic
  // volume should use the bulk generator (scripts/generate-bulk-csv.ts).
  const numInteractions = (() => {
    const i = args.indexOf("--num-interactions");
    if (i >= 0 && args[i + 1]) return parseInt(args[i + 1], 10);
    return 50;
  })();

  console.log("🎉 Generating Party Supply Seed Data with Embeddings\n");
  console.log(`Region: ${REGION}`);
  console.log(`Embedding Model: ${EMBEDDING_MODEL_ID}`);
  console.log(`Output Directory: ${OUTPUT_DIR}`);
  console.log(`Data Source: ${useImported ? "Imported CSV data" : "Built-in sample data"}`);
  if (hasOnlyFlags) {
    const types = [
      generateProducts && "products",
      generateOrders && "orders",
      generateCustomers && "customers"
    ].filter(Boolean).join(", ");
    console.log(`Generating: ${types}`);
  }
  console.log("");

  // Create output directory
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Load data (imported or sample)
  let products: Product[] = [];
  let orders: Order[] = [];
  let customers: CustomerProfile[] = [];

  // Interactions need a product + customer pool for IDs. Even if the
  // caller passed --only-interactions we still load those two from raw
  // JSON / sample so the synthesizer has something to reference.
  const needProductsForLoad = generateProducts || generateInteractions;
  const needCustomersForLoad = generateCustomers || generateInteractions;

  if (useImported) {
    // Load from imported JSON files - only load what we need
    const productsPath = `${OUTPUT_DIR}/products-raw.json`;
    const ordersPath = `${OUTPUT_DIR}/orders-raw.json`;
    const customersPath = `${OUTPUT_DIR}/customers-raw.json`;

    if (needProductsForLoad) {
      products = existsSync(productsPath)
        ? JSON.parse(readFileSync(productsPath, "utf-8"))
        : [];
      if (products.length === 0 && !hasOnlyFlags) {
        console.warn("⚠️  No products found in products-raw.json, using sample data");
        products = sampleProducts;
      }
    }

    if (generateOrders) {
      orders = existsSync(ordersPath)
        ? JSON.parse(readFileSync(ordersPath, "utf-8"))
        : [];
      if (orders.length === 0 && !hasOnlyFlags) {
        console.warn("⚠️  No orders found in orders-raw.json, using sample data");
        orders = sampleOrders;
      }
    }

    if (needCustomersForLoad) {
      customers = existsSync(customersPath)
        ? JSON.parse(readFileSync(customersPath, "utf-8"))
        : [];
      if (customers.length === 0 && !hasOnlyFlags) {
        console.warn("⚠️  No customers found in customers-raw.json, using sample data");
        customers = sampleCustomers;
      }
    }
  } else {
    products = needProductsForLoad ? sampleProducts : [];
    orders = generateOrders ? sampleOrders : [];
    customers = needCustomersForLoad ? sampleCustomers : [];
  }

  // Generate product embeddings
  const productVectors: Array<{
    key: string;
    vector: number[];
    metadata: Record<string, string>;
  }> = [];

  if (products.length > 0 && generateProducts) {
    console.log("📦 Generating product embeddings...");
    for (const product of products) {
      const text = productToText(product);
      console.log(`  Embedding: ${product.name}`);
      const embedding = await generateEmbedding(text);

      productVectors.push({
        key: product.id,
        vector: embedding,
        metadata: productToMetadata(product),
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  // Generate order embeddings
  const orderVectors: Array<{
    key: string;
    vector: number[];
    metadata: Record<string, string>;
  }> = [];

  if (orders.length > 0) {
    console.log("\n📋 Generating order embeddings...");
    for (const order of orders) {
      const text = orderToText(order);
      console.log(`  Embedding: ${order.id} - ${order.customerName}`);
      const embedding = await generateEmbedding(text);

      orderVectors.push({
        key: order.id,
        vector: embedding,
        metadata: {
          orderId: order.id,
          customerId: order.customerId,
          customerName: order.customerName,
          items: JSON.stringify(order.items),
          total: String(order.total),
          status: order.status,
          orderDate: order.orderDate,
          deliveryDate: order.deliveryDate,
          shippingAddress: order.shippingAddress,
          notes: order.notes,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  // Generate customer profile embeddings
  const customerVectors: Array<{
    key: string;
    vector: number[];
    metadata: Record<string, string>;
  }> = [];

  if (customers.length > 0 && generateCustomers) {
    console.log("\n👤 Generating customer profile embeddings...");
    for (const customer of customers) {
      const text = customerToText(customer);
      console.log(`  Embedding: ${customer.userId}`);
      const embedding = await generateEmbedding(text);

      customerVectors.push({
        key: customer.userId,
        vector: embedding,
        metadata: customerToMetadata(customer),
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  // Generate interaction event embeddings. Each event references a real
  // seed product and customer so the agent can cross-reference them.
  const interactionVectors: Array<{
    key: string;
    vector: number[];
    metadata: Record<string, string>;
  }> = [];
  let interactions: Interaction[] = [];

  if (generateInteractions && products.length > 0 && customers.length > 0) {
    interactions = synthesizeInteractions(customers, products, numInteractions);
    console.log(`\n🛒 Generating ${interactions.length} interaction embeddings...`);
    for (const event of interactions) {
      const text = interactionToText(event);
      const embedding = await generateEmbedding(text);
      interactionVectors.push({
        key: interactionKey(event),
        vector: embedding,
        metadata: interactionToMetadata(event),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } else if (generateInteractions) {
    console.warn(
      "⚠️  Skipping interactions: need both products and customers loaded (run without --only-* or with both already present)"
    );
  }

  // Write output files (only for types that were generated)
  const filesCreated: string[] = [];

  if (productVectors.length > 0) {
    const productsOutput = {
      indexName: "products-index",
      vectorBucketName: "party-supply-vectors",
      dimensions: 1024,
      distanceMetric: "cosine",
      vectors: productVectors,
    };
    writeFileSync(
      `${OUTPUT_DIR}/products-vectors.json`,
      JSON.stringify(productsOutput, null, 2)
    );
    filesCreated.push(`${OUTPUT_DIR}/products-vectors.json`);

    if (!useImported) {
      writeFileSync(
        `${OUTPUT_DIR}/products-raw.json`,
        JSON.stringify(products, null, 2)
      );
      filesCreated.push(`${OUTPUT_DIR}/products-raw.json`);
    }
  }

  if (orderVectors.length > 0) {
    const ordersOutput = {
      indexName: "orders-index",
      vectorBucketName: "party-supply-vectors",
      dimensions: 1024,
      distanceMetric: "cosine",
      vectors: orderVectors,
    };
    writeFileSync(
      `${OUTPUT_DIR}/orders-vectors.json`,
      JSON.stringify(ordersOutput, null, 2)
    );
    filesCreated.push(`${OUTPUT_DIR}/orders-vectors.json`);

    if (!useImported) {
      writeFileSync(
        `${OUTPUT_DIR}/orders-raw.json`,
        JSON.stringify(orders, null, 2)
      );
      filesCreated.push(`${OUTPUT_DIR}/orders-raw.json`);
    }
  }

  if (customerVectors.length > 0) {
    const customersOutput = {
      indexName: "customers-index",
      vectorBucketName: "party-supply-vectors",
      dimensions: 1024,
      distanceMetric: "cosine",
      vectors: customerVectors,
    };
    writeFileSync(
      `${OUTPUT_DIR}/customers-vectors.json`,
      JSON.stringify(customersOutput, null, 2)
    );
    filesCreated.push(`${OUTPUT_DIR}/customers-vectors.json`);

    if (!useImported) {
      writeFileSync(
        `${OUTPUT_DIR}/customers-raw.json`,
        JSON.stringify(customers, null, 2)
      );
      filesCreated.push(`${OUTPUT_DIR}/customers-raw.json`);
    }
  }

  if (interactionVectors.length > 0) {
    const interactionsOutput = {
      indexName: "interactions-index",
      vectorBucketName: "party-supply-vectors",
      dimensions: 1024,
      distanceMetric: "cosine",
      vectors: interactionVectors,
    };
    writeFileSync(
      `${OUTPUT_DIR}/interactions-vectors.json`,
      JSON.stringify(interactionsOutput, null, 2)
    );
    filesCreated.push(`${OUTPUT_DIR}/interactions-vectors.json`);

    // Also persist the raw events for traceability and re-runs.
    writeFileSync(
      `${OUTPUT_DIR}/interactions-raw.json`,
      JSON.stringify(interactions, null, 2)
    );
    filesCreated.push(`${OUTPUT_DIR}/interactions-raw.json`);
  }

  console.log(`\n✅ Seed data generated successfully!`);
  if (productVectors.length > 0) console.log(`   Products: ${productVectors.length} vectors`);
  if (orderVectors.length > 0) console.log(`   Orders: ${orderVectors.length} vectors`);
  if (customerVectors.length > 0) console.log(`   Customers: ${customerVectors.length} vectors`);
  if (interactionVectors.length > 0) console.log(`   Interactions: ${interactionVectors.length} vectors`);
  console.log(`   Output: ${OUTPUT_DIR}/`);
  console.log(`\nFiles created:`);
  filesCreated.forEach(f => console.log(`  - ${f}`));
}

main().catch((err) => {
  console.error("Error generating seed data:", err);
  process.exit(1);
});
