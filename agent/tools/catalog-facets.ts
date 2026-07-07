/**
 * Catalog facet cache.
 *
 * Harvests distinct values for theme, occasion, category, and color from the
 * actual product index so chip suggestions reflect what the catalog
 * really contains - not whatever values Claude happens to invent.
 *
 * Sampled once per container lifetime at first use, then cached. The
 * sample is bounded (1000 vectors) because we only need a representative
 * spread of values, not the long tail.
 *
 * This is best-effort: if S3 Vectors list-vectors fails or returns no
 * metadata, we fall back to a small built-in seed set so the agent still
 * works. The seed values are common enough that customers won't notice.
 */

import {
  S3VectorsClient,
  ListVectorsCommand,
} from "@aws-sdk/client-s3vectors";

const REGION = process.env.AWS_REGION || "us-west-2";
const VECTOR_BUCKET_NAME =
  process.env.VECTOR_BUCKET_NAME || "party-supply-vectors";

// Adaptive retry so ListVectors sampling doesn't fail on transient
// S3 Vectors throttling during startup / cache-bust refresh.
const client = new S3VectorsClient({
  region: REGION,
  maxAttempts: 10,
  retryMode: "adaptive",
});

export interface CatalogFacets {
  themes: string[];
  occasions: string[];
  categories: string[];
  colors: string[];
}

// Hardcoded fallback. Used when the live catalog can't be sampled
// (cold container with broken IAM, no products imported yet, etc.).
const FALLBACK_FACETS: CatalogFacets = {
  themes: ["Elegant", "Tropical", "Rustic", "Superhero", "Princess", "Dinosaur", "Unicorn", "Spooky", "Vintage"],
  occasions: ["Birthday", "Wedding", "Baby Shower", "Graduation", "Halloween", "Christmas", "Anniversary"],
  categories: ["Balloons", "Tableware", "Decorations", "Party Packs", "Costumes", "Banners"],
  colors: ["Gold", "Pink", "Blue", "Green", "Red", "Purple", "Silver"],
};

let cachedFacets: CatalogFacets | null = null;
let inflightLoad: Promise<CatalogFacets> | null = null;

/**
 * Top N most frequent values from a sample. We use frequency rather than
 * arbitrary distinct values so common occasions float to the top - chips
 * should suggest "Birthday" before "Quinceañera" because most users
 * shopping in this catalog want birthday supplies.
 */
function topN(values: string[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v || typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    counts.set(trimmed, (counts.get(trimmed) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([v]) => v);
}

async function loadFacetsOnce(): Promise<CatalogFacets> {
  // Sample up to 1000 product vectors. S3 Vectors caps maxResults at 500
  // per call, so we paginate a couple of times.
  const themes: string[] = [];
  const occasions: string[] = [];
  const categories: string[] = [];
  const colors: string[] = [];

  let nextToken: string | undefined;
  let collected = 0;
  const TARGET = 1000;

  try {
    while (collected < TARGET) {
      const out = await client.send(
        new ListVectorsCommand({
          vectorBucketName: VECTOR_BUCKET_NAME,
          indexName: "products-index",
          maxResults: 500,
          returnMetadata: true,
          nextToken,
        })
      );

      const vectors = out.vectors || [];
      for (const v of vectors) {
        const m = (v.metadata as Record<string, string>) || {};
        if (m.theme) themes.push(m.theme);
        if (m.occasion) occasions.push(m.occasion);
        if (m.category) categories.push(m.category);
        if (m.color) colors.push(m.color);
      }
      collected += vectors.length;

      if (!out.nextToken || vectors.length === 0) break;
      nextToken = out.nextToken;
    }

    const facets: CatalogFacets = {
      themes: topN(themes, 12),
      occasions: topN(occasions, 10),
      categories: topN(categories, 8),
      colors: topN(colors, 10),
    };

    // If the catalog had no metadata at all (e.g., before batch import),
    // fall back so the agent still suggests something reasonable.
    if (
      facets.themes.length === 0 &&
      facets.occasions.length === 0 &&
      facets.categories.length === 0
    ) {
      console.warn("[catalog-facets] No metadata in product index, using fallback");
      return FALLBACK_FACETS;
    }

    console.log(
      `[catalog-facets] Loaded from ${collected} vectors: ${facets.themes.length} themes, ${facets.occasions.length} occasions, ${facets.categories.length} categories`
    );
    return facets;
  } catch (error) {
    console.warn("[catalog-facets] Sample failed, using fallback:", error);
    return FALLBACK_FACETS;
  }
}

/**
 * Returns the cached catalog facets. First call samples the index;
 * subsequent calls return the cached result. Concurrent first calls share
 * the same in-flight promise (no thundering herd).
 */
export async function getCatalogFacets(): Promise<CatalogFacets> {
  if (cachedFacets) return cachedFacets;
  if (inflightLoad) return inflightLoad;

  inflightLoad = loadFacetsOnce()
    .then((facets) => {
      cachedFacets = facets;
      return facets;
    })
    .finally(() => {
      inflightLoad = null;
    });

  return inflightLoad;
}

/**
 * Force a refresh. Useful after a re-import or for tests; not called by
 * normal request flow.
 */
export function clearCatalogFacetsCache(): void {
  cachedFacets = null;
}
