/**
 * Prompt loader.
 *
 * Reads system prompt sections from a DynamoDB table populated by the
 * deploy script (`./scripts/deploy.sh --prompts`). The runtime caches
 * results for 60 seconds, so customers can edit `agent/prompts.md`,
 * re-run --prompts, and see the new behavior live within a minute -
 * without rebuilding the agent container.
 *
 * Resolution order:
 *   1. Hot cache (last load <60s ago)
 *   2. DynamoDB Scan
 *   3. Local agent/prompts.md (last-resort fallback if DDB is unreachable
 *      or the table is empty - keeps the agent functional during initial
 *      container start before the first --prompts upload completes)
 *
 * Sections in the source markdown are demarcated by HTML comment tags
 * `<!-- @section: NAME -->`. Within a section, `{{PLACEHOLDER}}` tokens
 * are substituted at render time (catalog facets, customer profile, etc.).
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { clearCatalogFacetsCache } from "./tools/catalog-facets.js";

const REGION = process.env.AWS_REGION || "us-west-2";
const TABLE = process.env.PROMPTS_TABLE_NAME || "party-supply-prompts";
const CACHE_TTL_MS = 60_000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// In production (compiled to dist/), prompts.md sits one level up.
// In dev (npx tsx), it's already a sibling.
const PROMPT_FALLBACK_PATH = (() => {
  const candidates = [resolve(__dirname, "prompts.md"), resolve(__dirname, "../prompts.md")];
  for (const p of candidates) {
    try {
      readFileSync(p, "utf-8");
      return p;
    } catch {
      // try next
    }
  }
  return candidates[0];
})();

// Adaptive retry so a transient DynamoDB throttle doesn't fail the
// 60s prompt-cache refresh - we'd rather serve a slightly stale prompt
// than crash the request path.
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: REGION,
    maxAttempts: 10,
    retryMode: "adaptive",
  })
);

const SECTION_RE = /<!--\s*@section:\s*([A-Z_]+)\s*-->/g;

interface CachedSections {
  sections: Record<string, string>;
  loadedAt: number;
  source: "ddb" | "fallback";
  /** Sentinel value from the _meta row. Used to detect when an upload
   * happened so we can also bust downstream caches (catalog facets). */
  cacheBust: string | null;
}

let cache: CachedSections | null = null;

/**
 * Parse markdown content into a {sectionName: content} map. Used for both
 * the local fallback and any markdown payload returned from DDB (we store
 * each section's content directly, but the same parser handles either).
 */
function parseMarkdownSections(raw: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const markers: Array<{ name: string; start: number; end: number }> = [];

  let m: RegExpExecArray | null;
  SECTION_RE.lastIndex = 0;
  while ((m = SECTION_RE.exec(raw)) !== null) {
    markers.push({ name: m[1], start: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const next = markers[i + 1];
    sections[marker.name] = raw.slice(marker.end, next ? next.start : raw.length).trim();
  }

  return sections;
}

async function loadFromDynamoDB(): Promise<{
  sections: Record<string, string>;
  cacheBust: string | null;
} | null> {
  try {
    const out = await ddb.send(new ScanCommand({ TableName: TABLE }));
    const items = out.Items || [];
    if (items.length === 0) return null;

    const sections: Record<string, string> = {};
    let cacheBust: string | null = null;
    for (const item of items) {
      // The _meta row carries the cacheBust sentinel written by
      // deploy.sh step_prompts. It's not a section template - it's a
      // signal that the prompts table was updated, so consumers
      // (catalog-facets) can also refresh their caches.
      if (item.section === "_meta" && typeof item.cacheBust === "string") {
        cacheBust = item.cacheBust;
        continue;
      }
      if (typeof item.section === "string" && typeof item.template === "string") {
        sections[item.section] = item.template;
      }
    }
    return Object.keys(sections).length > 0 ? { sections, cacheBust } : null;
  } catch (err) {
    // ResourceNotFoundException, AccessDenied, network blips, etc. We
    // don't want any of these to take down the runtime - we fall back
    // to local file.
    console.warn(
      `[prompt-loader] DDB read failed (${(err as Error).name || "unknown"}): falling back to local prompts.md`
    );
    return null;
  }
}

function loadFromLocalFile(): Record<string, string> {
  try {
    const raw = readFileSync(PROMPT_FALLBACK_PATH, "utf-8");
    return parseMarkdownSections(raw);
  } catch (err) {
    console.error(
      `[prompt-loader] Could not read fallback ${PROMPT_FALLBACK_PATH}:`,
      err
    );
    return {};
  }
}

async function ensureLoaded(): Promise<CachedSections> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) {
    return cache;
  }

  const previousCacheBust = cache?.cacheBust ?? null;
  const fromDdb = await loadFromDynamoDB();

  if (fromDdb) {
    let sections = fromDdb.sections;
    if (!sections.BASE) {
      console.warn(
        "[prompt-loader] DDB returned items but no BASE section. Mixing local fallback in."
      );
      const local = loadFromLocalFile();
      sections = { ...local, ...sections };
    }

    // If the cacheBust sentinel changed since we last loaded, an admin
    // ran `./scripts/deploy.sh --prompts`. That implies the catalog or
    // prompt content shifted - bust the catalog-facets cache too so the
    // next request samples fresh metadata (themes/occasions/categories).
    if (
      previousCacheBust !== null &&
      fromDdb.cacheBust !== null &&
      fromDdb.cacheBust !== previousCacheBust
    ) {
      console.log(
        `[prompt-loader] cacheBust changed (${previousCacheBust} -> ${fromDdb.cacheBust}); refreshing catalog facets`
      );
      clearCatalogFacetsCache();
    }

    cache = {
      sections,
      loadedAt: now,
      source: "ddb",
      cacheBust: fromDdb.cacheBust,
    };
    return cache;
  }

  // Fall back to local file. We still cache it for the TTL so we don't
  // hit the filesystem on every request, but the next load attempt
  // will retry DDB.
  const local = loadFromLocalFile();
  cache = { sections: local, loadedAt: now, source: "fallback", cacheBust: null };
  return cache;
}

/**
 * Apply {{placeholder}} substitutions. Unknown placeholders are left in
 * place (visible in prompt) so authors notice typos rather than silently
 * dropping content.
 */
function applyPlaceholders(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (full, key) => {
    return key in vars ? vars[key] : full;
  });
}

/**
 * Render the BASE section with catalog facet placeholders.
 */
export async function renderBasePrompt(vars: {
  THEMES: string;
  OCCASIONS: string;
  CATEGORIES: string;
}): Promise<string> {
  const { sections, source } = await ensureLoaded();
  const template = sections.BASE;
  if (!template) {
    throw new Error(
      `prompt-loader: BASE section missing from ${source}. Run ./scripts/deploy.sh --prompts to upload.`
    );
  }
  return applyPlaceholders(template, vars);
}

/**
 * Render the optional PROFILE_BLOCK appended to the base prompt when a
 * customer profile is present. Returns empty string if the section isn't
 * defined (graceful: agent still works without per-profile context).
 */
export async function renderProfileBlock(vars: {
  PROFILE_CONTEXT: string;
  PROFILE_TIPS: string;
  INTERACTION_HISTORY: string;
}): Promise<string> {
  const { sections } = await ensureLoaded();
  const template = sections.PROFILE_BLOCK;
  if (!template) return "";
  return applyPlaceholders(template, vars);
}

/**
 * For diagnostics: which source the runtime is currently using.
 * Visible via console output on first load and helpful when debugging
 * "did my prompt update go live?" questions.
 */
export async function getPromptSource(): Promise<"ddb" | "fallback"> {
  const { source } = await ensureLoaded();
  return source;
}
