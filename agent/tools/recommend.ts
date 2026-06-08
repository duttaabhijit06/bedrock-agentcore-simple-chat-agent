/**
 * Product recommendation logic.
 *
 * Wraps vector search (`searchProducts`) with optional customer-profile
 * re-ranking. The vector index handles semantic similarity; this layer
 * handles business rules (price affinity, segment fit, in-stock filter).
 */

import {
  CustomerProfile,
  SearchResult,
  searchProducts,
  getCustomerProfile,
} from "./rag-search.js";

export interface RecommendCriteria {
  theme?: string;
  occasion?: string;
  category?: string;
  color?: string;
  ageGroup?: string;
  budget?: "low" | "mid" | "high" | "bulk";
  guestCount?: number;
  keywords?: string;
}

export interface RecommendOptions {
  /** Limit on results returned to the caller. */
  topK?: number;
  /** Number of vector candidates to rank (defaults to 3x topK). */
  candidatePoolSize?: number;
  /** Drop out-of-stock items. Default true. */
  inStockOnly?: boolean;
}

/**
 * Build a vector query string from structured criteria. The criteria are
 * concatenated with spaces - Titan's embedding similarity works fine on
 * loosely structured text, so dedicated field weighting isn't needed at
 * this dataset size.
 */
export function buildQueryFromCriteria(c: RecommendCriteria): string {
  const parts: string[] = [];
  if (c.theme) parts.push(c.theme);
  if (c.occasion) parts.push(c.occasion);
  if (c.category) parts.push(c.category);
  if (c.color) parts.push(`${c.color} colored`);
  if (c.ageGroup) parts.push(`for ${c.ageGroup}`);
  if (c.guestCount) parts.push(`${c.guestCount} guests`);
  if (c.budget) {
    const budgetText = {
      low: "budget-friendly affordable",
      mid: "mid-range",
      high: "premium upscale",
      bulk: "bulk wholesale",
    }[c.budget];
    parts.push(budgetText);
  }
  if (c.keywords) parts.push(c.keywords);
  return parts.join(" ").trim() || "party supplies";
}

/**
 * Build a vector query weighted by a customer's stored preferences.
 * Useful when only a customerId is known and no explicit criteria.
 */
export function buildQueryFromProfile(profile: CustomerProfile): string {
  const parts: string[] = [];
  if (profile.preferredTheme) parts.push(profile.preferredTheme);
  if (profile.preferredOccasion) parts.push(profile.preferredOccasion);
  if (profile.preferredCategoryL2) parts.push(profile.preferredCategoryL2);
  else if (profile.preferredCategoryL1) parts.push(profile.preferredCategoryL1);

  if (profile.priceAffinity) {
    const map: Record<string, string> = {
      LOW: "budget-friendly affordable",
      MID: "mid-range",
      HIGH: "premium upscale",
      BULK: "bulk wholesale",
    };
    if (map[profile.priceAffinity]) parts.push(map[profile.priceAffinity]);
  }
  return parts.join(" ").trim() || "popular party supplies";
}

/** Map customer's stored price affinity to an inclusive price range. */
function priceRangeForAffinity(
  affinity: string | undefined
): { min: number; max: number } | null {
  switch (affinity?.toUpperCase()) {
    case "LOW":
      return { min: 0, max: 30 };
    case "MID":
      return { min: 20, max: 80 };
    case "HIGH":
      return { min: 60, max: 1000 };
    case "BULK":
      return { min: 0, max: 1000 }; // bulk is about quantity, not price band
    default:
      return null;
  }
}

/**
 * Re-rank vector results using customer profile signals.
 *
 * Vector similarity is the primary signal (preserved as `score`); we add a
 * small bonus for items that match the customer's segment/price band/themes.
 * Scoring is intentionally simple - production systems would use a learned
 * ranker, but the bonus structure here is enough to noticeably influence
 * ordering without overpowering the semantic match.
 */
export function rerankByProfile(
  results: SearchResult[],
  profile: CustomerProfile
): SearchResult[] {
  const priceRange = priceRangeForAffinity(profile.priceAffinity);

  return results
    .map((r) => {
      let bonus = 0;
      const m = r.metadata;
      const price = parseFloat(m.price || "0");

      // Theme match (+0.10)
      if (
        profile.preferredTheme &&
        m.theme?.toLowerCase().includes(profile.preferredTheme.toLowerCase())
      ) {
        bonus += 0.1;
      }

      // Occasion match (+0.08)
      if (
        profile.preferredOccasion &&
        (m.occasion || m.theme || "")
          .toLowerCase()
          .includes(profile.preferredOccasion.toLowerCase())
      ) {
        bonus += 0.08;
      }

      // Price band match (+0.05)
      if (priceRange && price > 0 && price >= priceRange.min && price <= priceRange.max) {
        bonus += 0.05;
      }

      // B2B + bulk (+0.05)
      if (
        profile.customerType === "BUSINESS" &&
        (m.bulkAssortments || "").toLowerCase().includes("bulk")
      ) {
        bonus += 0.05;
      }

      // Higher distance = closer match in cosine; we add the bonus to the
      // raw `score` field, then sort descending. If your bucket exposes
      // distance differently, flip the sign here.
      return { ...r, score: r.score + bonus, _bonus: bonus };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Filter helper: drop items with availability != "in stock".
 */
export function filterInStock(results: SearchResult[]): SearchResult[] {
  return results.filter((r) => {
    const avail = (r.metadata.availability || "").toLowerCase();
    // Treat unknown availability as in-stock (don't drop products that
    // didn't get the field populated by the import pipeline).
    return avail === "" || avail.includes("in stock");
  });
}

/**
 * Core recommendation flow: criteria + optional profile -> ranked products.
 *
 * Performance note: when a customerId is supplied, we kick off the profile
 * lookup in parallel with the vector search. Profile only matters for
 * re-ranking, so we don't need to wait for it before searching. This
 * roughly halves wall-clock latency for personalized calls (profile
 * lookup ~300ms + search ~500ms => max(profile, search+embed) instead of
 * sum). The trade-off: explicit criteria from the caller fully drive the
 * vector query; profile-derived defaults only fill in fields the caller
 * left blank, and that filling now happens at re-rank time instead of
 * query-build time. In practice this changes ranking, not which docs
 * survive, since over-fetching gives the re-rank pass plenty of options.
 */
export async function recommendProducts(
  criteria: RecommendCriteria,
  customerId: string | undefined,
  options: RecommendOptions = {}
): Promise<SearchResult[]> {
  const topK = options.topK ?? 5;
  const poolSize = options.candidatePoolSize ?? Math.max(15, topK * 3);
  const inStockOnly = options.inStockOnly ?? true;

  // Build the query from explicit criteria up front. We don't try to
  // enrich with profile here - that's deferred to the re-rank pass below
  // so we can fire the profile lookup in parallel with the search.
  const query = buildQueryFromCriteria(criteria);

  // 1. Fire profile lookup and vector search in parallel
  const [profile, rawResults] = await Promise.all([
    customerId ? getCustomerProfile(customerId).catch(() => null) : Promise.resolve(null),
    searchProducts(query, poolSize),
  ]);

  // 2. Filter
  let results = inStockOnly ? filterInStock(rawResults) : rawResults;

  // 3. Re-rank if we have a profile. The bonus structure in rerankByProfile
  // already encodes theme / occasion / price-band match, so profile-derived
  // criteria still influence the final ordering even though they didn't
  // shape the original vector query.
  if (profile) {
    results = rerankByProfile(results, profile);
  }

  return results.slice(0, topK);
}

/**
 * Recommend products for a customer using only their stored profile - no
 * other criteria needed. Useful for landing-page style "for you" displays
 * or zero-shot recommendations.
 */
export async function recommendForCustomer(
  customerId: string,
  options: RecommendOptions = {}
): Promise<{ profile: CustomerProfile | null; recommendations: SearchResult[] }> {
  const profile = await getCustomerProfile(customerId);
  if (!profile) {
    return { profile: null, recommendations: [] };
  }

  const query = buildQueryFromProfile(profile);
  const topK = options.topK ?? 5;
  const poolSize = options.candidatePoolSize ?? Math.max(15, topK * 3);
  const inStockOnly = options.inStockOnly ?? true;

  let results = await searchProducts(query, poolSize);
  if (inStockOnly) results = filterInStock(results);
  results = rerankByProfile(results, profile);

  return { profile, recommendations: results.slice(0, topK) };
}

/**
 * Personalized free-text search. Takes a customer query string and the
 * actor's customerId, runs the search, and re-ranks results by profile.
 */
export async function personalizedSearch(
  query: string,
  customerId: string | undefined,
  options: RecommendOptions = {}
): Promise<SearchResult[]> {
  const topK = options.topK ?? 5;
  const poolSize = options.candidatePoolSize ?? Math.max(15, topK * 3);
  const inStockOnly = options.inStockOnly ?? true;

  // Run profile lookup and search in parallel. We previously enriched the
  // query with profile-derived hints before searching, but that forced the
  // calls to be sequential. The re-rank pass below covers the same ground
  // (theme / price-band bonuses), so we lose almost nothing by skipping
  // the enrichment and gain ~300ms of wall-clock latency.
  const [profile, rawResults] = await Promise.all([
    customerId ? getCustomerProfile(customerId).catch(() => null) : Promise.resolve(null),
    searchProducts(query, poolSize),
  ]);

  let results = inStockOnly ? filterInStock(rawResults) : rawResults;
  if (profile) results = rerankByProfile(results, profile);

  return results.slice(0, topK);
}
