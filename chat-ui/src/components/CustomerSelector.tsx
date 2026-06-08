import { useEffect, useMemo, useRef, useState } from "react";
import { signRequest, getCredentials } from "../lib/sigv4";

const GATEWAY_URL = import.meta.env.VITE_GATEWAY_URL || "";

export interface Customer {
  userId: string;
  customerType?: string;
  customerSegment?: string;
  region?: string;
  state?: string;
  preferredTheme?: string;
  priceAffinity?: string;
  lifetimeSpend?: string;
}

interface CustomerSelectorProps {
  /** Currently selected customer (controlled by parent). */
  selected: Customer | null;
  /** Called when the user picks a customer or clicks "Clear". */
  onChange: (c: Customer | null) => void;
}

/**
 * Customer-selector dropdown with type-ahead filtering.
 *
 * Loads the list once via the gateway's `list_customers` tool (Lambda
 * proxies to S3 Vectors), caches in component state, then filters
 * client-side as the user types. ~5K customers fits in memory comfortably.
 */
export function CustomerSelector({ selected, onChange }: CustomerSelectorProps) {
  const [allCustomers, setAllCustomers] = useState<Customer[]>([]);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load on first open. Lazy-loading avoids wasting a gateway call on
  // sessions where the user never opens the selector.
  useEffect(() => {
    if (!open || loadState !== "idle") return;
    void loadCustomers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function loadCustomers() {
    const credentials = getCredentials();
    if (!credentials) {
      setLoadError("AWS credentials not set");
      setLoadState("error");
      return;
    }

    setLoadState("loading");
    setLoadError(null);

    try {
      const all: Customer[] = [];
      let nextToken: string | undefined;

      // Page through up to 5 pages (2500 customers max). With our
      // ~5K-row catalog, two pages typically covers everything.
      for (let page = 0; page < 5; page++) {
        const args: Record<string, unknown> = { action: "list_customers", limit: 500 };
        if (nextToken) args.nextToken = nextToken;

        const body = JSON.stringify({
          jsonrpc: "2.0",
          id: `${Date.now()}-${page}`,
          method: "tools/call",
          params: {
            name: "PartySupplyTarget___list_customers",
            arguments: args,
          },
        });

        const url = `${GATEWAY_URL}/mcp`;
        const signedHeaders = await signRequest(url, "POST", body, credentials);
        const response = await fetch(url, {
          method: "POST",
          headers: { ...signedHeaders, "content-type": "application/json" },
          body,
        });
        if (!response.ok) {
          throw new Error(`list_customers failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        const text = data?.result?.content
          ?.filter((c: { type: string }) => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join("\n") || "{}";

        let parsed: { customers?: Customer[]; nextToken?: string | null } = {};
        try {
          parsed = JSON.parse(text);
        } catch {
          // Older Lambda responses might wrap in `response` field
          parsed = JSON.parse(JSON.parse(text).response || "{}");
        }

        if (Array.isArray(parsed.customers)) all.push(...parsed.customers);
        nextToken = parsed.nextToken || undefined;
        if (!nextToken) break;
      }

      // Sort alphabetically by userId for predictable ordering
      all.sort((a, b) => a.userId.localeCompare(b.userId));
      setAllCustomers(all);
      setLoadState("loaded");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.error("[CustomerSelector] load failed:", e);
      setLoadError(msg);
      setLoadState("error");
    }
  }

  // Close dropdown on outside click
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Filter list as user types - search across userId + segment + region.
  // Memoized so we don't re-filter on every render (~5K rows is cheap
  // but no need to do it constantly).
  const filtered = useMemo(() => {
    if (!query.trim()) return allCustomers.slice(0, 50);
    const q = query.toLowerCase();
    return allCustomers
      .filter((c) => {
        return (
          c.userId.toLowerCase().includes(q) ||
          (c.customerSegment || "").toLowerCase().includes(q) ||
          (c.region || "").toLowerCase().includes(q) ||
          (c.preferredTheme || "").toLowerCase().includes(q)
        );
      })
      .slice(0, 50);
  }, [allCustomers, query]);

  return (
    <div className="customer-selector" ref={containerRef}>
      <button
        type="button"
        className="customer-selector-button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selected ? (
          <>
            <span className="cs-selected-icon">👤</span>
            <span className="cs-selected-id">{selected.userId}</span>
            {selected.customerSegment && (
              <span className="cs-selected-segment">{selected.customerSegment}</span>
            )}
          </>
        ) : (
          <>
            <span className="cs-selected-icon">🔍</span>
            <span>Select customer</span>
          </>
        )}
        <span className="cs-caret">▾</span>
      </button>

      {open && (
        <div className="customer-selector-dropdown" role="listbox">
          <div className="cs-search-row">
            <input
              type="text"
              className="cs-search-input"
              placeholder="Search by ID, segment, region, theme..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            {selected && (
              <button
                type="button"
                className="cs-clear-button"
                onClick={() => {
                  onChange(null);
                  setOpen(false);
                  setQuery("");
                }}
              >
                Clear
              </button>
            )}
          </div>

          <div className="cs-results">
            {loadState === "loading" && <div className="cs-status">Loading customers...</div>}
            {loadState === "error" && (
              <div className="cs-status cs-error">
                Failed to load: {loadError}
                <button type="button" onClick={() => loadCustomers()}>Retry</button>
              </div>
            )}
            {loadState === "loaded" && filtered.length === 0 && (
              <div className="cs-status">No matches</div>
            )}
            {loadState === "loaded" && filtered.length > 0 && (
              <ul className="cs-list">
                {filtered.map((c) => (
                  <li key={c.userId}>
                    <button
                      type="button"
                      className={`cs-row ${selected?.userId === c.userId ? "cs-row-selected" : ""}`}
                      onClick={() => {
                        onChange(c);
                        setOpen(false);
                        setQuery("");
                      }}
                    >
                      <div className="cs-row-id">{c.userId}</div>
                      <div className="cs-row-meta">
                        {c.customerSegment && <span>{c.customerSegment}</span>}
                        {c.region && <span>{c.region}</span>}
                        {c.preferredTheme && <span>{c.preferredTheme}</span>}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {loadState === "loaded" && (
            <div className="cs-footer">
              {filtered.length === allCustomers.length
                ? `${allCustomers.length} customers`
                : `Showing ${filtered.length} of ${allCustomers.length}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
