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
 * Best-effort parse of a string that should be a JSON-formatted
 * ChatResponse. Model-agnostic: strips reasoning-scratchpad tags
 * (Nova <thinking>, others <scratchpad>/<reflection>) and locates the
 * embedded envelope from wrappers like markdown fences or "Here's your
 * answer: {...}" prose. Mirror of buildEnvelope() in agent/agent.ts;
 * keep them in sync.
 *
 * Returns null if no valid envelope shape is found - caller handles
 * fallback rendering.
 */
export function parseEnvelope(raw: string): ChatResponse | null {
  if (!raw) return null;

  const cleaned = raw
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<scratchpad>[\s\S]*?<\/scratchpad>/gi, "")
    .replace(/<reflection>[\s\S]*?<\/reflection>/gi, "")
    .trim();

  const candidates: string[] = [];
  const fenced = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(cleaned);
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<ChatResponse>;
      if (
        typeof parsed.type === "string" &&
        typeof parsed.message === "string" &&
        ["answer", "followup", "blocked"].includes(parsed.type)
      ) {
        return parsed as ChatResponse;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}
