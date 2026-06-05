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
 */
export async function recommendProducts(
  criteria: RecommendCriteria,
  customerId: string | undefined,
  options: RecommendOptions = {}
): Promise<SearchResult[]> {
  const topK = options.topK ?? 5;
  const poolSize = options.candidatePoolSize ?? Math.max(15, topK * 3);
  const inStockOnly = options.inStockOnly ?? true;

  // 1. Resolve customer profile if provided
  let profile: CustomerProfile | null = null;
  if (customerId) {
    profile = await getCustomerProfile(customerId);
  }

  // 2. Build query - explicit criteria win, then we layer in profile prefs
  // for unspecified fields. Caller's intent always trumps stored prefs.
  const merged: RecommendCriteria = { ...criteria };
  if (profile) {
    if (!merged.theme && profile.preferredTheme) merged.theme = profile.preferredTheme;
    if (!merged.occasion && profile.preferredOccasion) merged.occasion = profile.preferredOccasion;
    if (!merged.category && profile.preferredCategoryL2) merged.category = profile.preferredCategoryL2;
    if (!merged.budget && profile.priceAffinity) {
      const map: Record<string, RecommendCriteria["budget"]> = {
        LOW: "low",
        MID: "mid",
        HIGH: "high",
        BULK: "bulk",
      };
      merged.budget = map[profile.priceAffinity];
    }
  }

  const query = buildQueryFromCriteria(merged);

  // 3. Vector search (over-fetch so the re-rank/filter pass has options)
  let results = await searchProducts(query, poolSize);

  // 4. Filter
  if (inStockOnly) {
    results = filterInStock(results);
  }

  // 5. Re-rank if we have a profile
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

  let profile: CustomerProfile | null = null;
  if (customerId) profile = await getCustomerProfile(customerId);

  // If we have a profile, lightly enrich the query with the customer's
  // top theme/budget. We don't want to fully overwrite their explicit
  // search terms - just add context the embedding can pick up on.
  let enriched = query;
  if (profile) {
    const hints: string[] = [];
    if (profile.preferredTheme) hints.push(profile.preferredTheme);
    if (profile.priceAffinity) {
      const map: Record<string, string> = {
        LOW: "budget-friendly",
        MID: "mid-range",
        HIGH: "premium",
        BULK: "bulk",
      };
      if (map[profile.priceAffinity]) hints.push(map[profile.priceAffinity]);
    }
    if (hints.length > 0) {
      enriched = `${query} ${hints.join(" ")}`;
    }
  }

  let results = await searchProducts(enriched, poolSize);
  if (inStockOnly) results = filterInStock(results);
  if (profile) results = rerankByProfile(results, profile);

  return results.slice(0, topK);
}
