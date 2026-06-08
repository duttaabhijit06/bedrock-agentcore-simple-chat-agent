/**
 * ChatResponse envelope contract (agent <-> UI).
 *
 * The agent always returns one of these. The UI parses on `type` and renders
 * appropriately:
 *   - "answer"   -> message + optional recommendations cards
 *   - "followup" -> message + chip buttons
 *   - "blocked"  -> error banner with the message
 *
 * If you change this, update chat-ui/src/types/response-envelope.ts to match.
 */

export type ChatResponseType = "answer" | "followup" | "blocked";

export interface ProductCard {
  id: string;
  title: string;
  price?: string;
  link?: string;
  image?: string;
  theme?: string;
  category?: string;
  description?: string;
  /** Vector similarity score, useful for debugging. Optional in display. */
  score?: number;
}

export interface FollowupOption {
  label: string;
  value: string;
}

export interface FollowupQuestion {
  id: string;
  label: string;
  options: FollowupOption[];
}

export interface ChatResponse {
  /** Discriminator. UI dispatches on this. */
  type: ChatResponseType;
  /** Markdown text shown above any structured elements. Required. */
  message: string;
  /** Populated when type == "answer" and the agent retrieved products. */
  recommendations?: ProductCard[];
  /** Populated when type == "followup". Empty otherwise. */
  followups?: FollowupQuestion[];
  /** Optional debug metadata. Strip before showing to end users. */
  meta?: {
    toolsCalled?: string[];
    blockedReason?: string;
  };
}

/**
 * Convert a SearchResult (from rag-search.ts) into a ProductCard for the
 * envelope. Strict about field names so we don't leak metadata the UI
 * doesn't expect.
 */
export function searchResultToCard(r: {
  id: string;
  score: number;
  metadata: Record<string, string>;
}): ProductCard {
  const m = r.metadata;
  return {
    id: r.id,
    title: m.name || m.title || r.id,
    price: m.price,
    link: m.link,
    image: m.image,
    theme: m.theme,
    category: m.category || m.categoryL2 || m.categoryL1,
    description: m.description ? m.description.slice(0, 300) : undefined,
    score: r.score,
  };
}
