/**
 * Generate Synthetic Seed Data with Embeddings
 *
 * Creates party supply product and order data, generates embeddings
 * using Amazon Titan Text Embeddings V2, and outputs JSON files
 * ready for upload to S3 Vectors.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { writeFileSync, mkdirSync, existsSync } from "fs";

const REGION = process.env.AWS_REGION || "us-west-2";
const EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0";
const OUTPUT_DIR = "./seed-data";

const bedrockClient = new BedrockRuntimeClient({ region: REGION });

// ─── Synthetic Product Data ─────────────────────────────────────────────────

interface Product {
  id: string;
  name: string;
  category: string;
  theme: string;
  description: string;
  price: number;
  inStock: boolean;
  quantity: number;
}

const products: Product[] = [
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

// ─── Synthetic Order Data ───────────────────────────────────────────────────

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

const orders: Order[] = [
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

function productToText(product: Product): string {
  return `Product: ${product.name}. Category: ${product.category}. Theme: ${product.theme}. Description: ${product.description}. Price: $${product.price}. ${product.inStock ? "In stock" : "Out of stock"}, quantity: ${product.quantity}.`;
}

function orderToText(order: Order): string {
  const itemsList = order.items
    .map((i) => `${i.productName} (x${i.quantity})`)
    .join(", ");
  return `Order ${order.id} by ${order.customerName}. Items: ${itemsList}. Total: $${order.total}. Status: ${order.status}. Ordered: ${order.orderDate}. Delivery: ${order.deliveryDate}. Address: ${order.shippingAddress}. Notes: ${order.notes}`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("🎉 Generating Party Supply Seed Data with Embeddings\n");
  console.log(`Region: ${REGION}`);
  console.log(`Embedding Model: ${EMBEDDING_MODEL_ID}`);
  console.log(`Output Directory: ${OUTPUT_DIR}\n`);

  // Create output directory
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Generate product embeddings
  console.log("📦 Generating product embeddings...");
  const productVectors: Array<{
    key: string;
    vector: number[];
    metadata: Record<string, string>;
  }> = [];

  for (const product of products) {
    const text = productToText(product);
    console.log(`  Embedding: ${product.name}`);
    const embedding = await generateEmbedding(text);

    productVectors.push({
      key: product.id,
      vector: embedding,
      metadata: {
        name: product.name,
        category: product.category,
        theme: product.theme,
        description: product.description,
        price: String(product.price),
        inStock: String(product.inStock),
        quantity: String(product.quantity),
      },
    });

    // Rate limiting - Titan embeddings has RPM limits
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Generate order embeddings
  console.log("\n📋 Generating order embeddings...");
  const orderVectors: Array<{
    key: string;
    vector: number[];
    metadata: Record<string, string>;
  }> = [];

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

  // Write output files
  const productsOutput = {
    indexName: "products-index",
    vectorBucketName: "party-supply-vectors",
    dimensions: 1024,
    distanceMetric: "cosine",
    vectors: productVectors,
  };

  const ordersOutput = {
    indexName: "orders-index",
    vectorBucketName: "party-supply-vectors",
    dimensions: 1024,
    distanceMetric: "cosine",
    vectors: orderVectors,
  };

  writeFileSync(
    `${OUTPUT_DIR}/products-vectors.json`,
    JSON.stringify(productsOutput, null, 2)
  );
  writeFileSync(
    `${OUTPUT_DIR}/orders-vectors.json`,
    JSON.stringify(ordersOutput, null, 2)
  );

  // Also write raw data for reference
  writeFileSync(
    `${OUTPUT_DIR}/products-raw.json`,
    JSON.stringify(products, null, 2)
  );
  writeFileSync(
    `${OUTPUT_DIR}/orders-raw.json`,
    JSON.stringify(orders, null, 2)
  );

  console.log(`\n✅ Seed data generated successfully!`);
  console.log(`   Products: ${productVectors.length} vectors`);
  console.log(`   Orders: ${orderVectors.length} vectors`);
  console.log(`   Output: ${OUTPUT_DIR}/`);
  console.log(`\nFiles created:`);
  console.log(`  - ${OUTPUT_DIR}/products-vectors.json`);
  console.log(`  - ${OUTPUT_DIR}/orders-vectors.json`);
  console.log(`  - ${OUTPUT_DIR}/products-raw.json`);
  console.log(`  - ${OUTPUT_DIR}/orders-raw.json`);
}

main().catch((err) => {
  console.error("Error generating seed data:", err);
  process.exit(1);
});
