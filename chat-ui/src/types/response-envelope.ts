/**
 * Mirror of agent/response-envelope.ts. The agent and UI don't share runtime
 * code, so we duplicate the contract. Keep these in sync.
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
  type: ChatResponseType;
  message: string;
  recommendations?: ProductCard[];
  followups?: FollowupQuestion[];
  meta?: {
    toolsCalled?: string[];
    blockedReason?: string;
  };
}

/**
 * Best-effort parse of a string that should be JSON-formatted ChatResponse.
 * Returns null if the string isn't valid JSON or doesn't have the right
 * shape - caller handles fallback rendering.
 */
export function parseEnvelope(raw: string): ChatResponse | null {
  if (!raw) return null;

  // Try to extract JSON from a markdown code fence if Claude wrapped it.
  // Some emissions look like ```json\n{...}\n``` rather than bare JSON.
  let candidate = raw.trim();
  const fenced = candidate.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) candidate = fenced[1].trim();

  try {
    const parsed = JSON.parse(candidate) as Partial<ChatResponse>;
    if (
      typeof parsed.type === "string" &&
      typeof parsed.message === "string" &&
      ["answer", "followup", "blocked"].includes(parsed.type)
    ) {
      return parsed as ChatResponse;
    }
  } catch {
    // not JSON, that's fine
  }
  return null;
}
