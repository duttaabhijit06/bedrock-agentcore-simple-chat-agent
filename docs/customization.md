# Customizing the Agent

This guide covers the levers that don't require touching agent code. Most behavioral changes (persona, recommendation flow, refinement chips, fallback messaging) are driven by the system prompt in [`agent/prompts.md`](../agent/prompts.md), and updates land **without rebuilding the runtime container**.

## Table of contents

- [Editing the system prompt](#editing-the-system-prompt)
- [Adding a new prompt section](#adding-a-new-prompt-section)
- [Tuning the recommendation flow](#tuning-the-recommendation-flow)
- [Customizing chip categories](#customizing-chip-categories)
- [Importing user interaction data](#importing-user-interaction-data)
- [Changing the persona / tone](#changing-the-persona--tone)
- [Tuning the guardrail](#tuning-the-guardrail)
- [Changing welcome message and UI copy](#changing-welcome-message-and-ui-copy)
- [Verifying your changes are live](#verifying-your-changes-are-live)
- [Rolling back a bad prompt](#rolling-back-a-bad-prompt)

---

## Editing the system prompt

The full system prompt lives in [`agent/prompts.md`](../agent/prompts.md). It's a markdown file with sections marked by HTML comments:

```markdown
<!-- @section: BASE -->
You are a helpful party supply customer service agent...
{{THEMES}}
{{OCCASIONS}}
...

<!-- @section: PROFILE_BLOCK -->
## Current Customer Profile
{{PROFILE_CONTEXT}}
{{PROFILE_TIPS}}
```

**To update the prompt:**

```bash
# 1. Edit agent/prompts.md
vim agent/prompts.md

# 2. Upload to DynamoDB (~5 seconds)
./scripts/deploy.sh --prompts

# 3. Wait up to 60 seconds (the runtime polls the table on a TTL cache)
# 4. Test in the chat UI
```

**No agent rebuild, no Lambda redeploy.** The runtime reads from DDB on a 60-second cache TTL.

### How the loader works

1. The agent calls `renderBasePrompt({ THEMES, OCCASIONS, CATEGORIES })` (and `renderProfileBlock` if a customer is logged in)
2. The loader checks its in-memory cache (last DDB load <60s ago → return cached)
3. On cache miss: `Scan` the prompts table, build a `{section: template}` map, cache it
4. If DDB is unreachable (broken IAM, table just deleted): fall back to the local `agent/prompts.md` baked into the container
5. Apply `{{placeholder}}` substitutions and return the rendered prompt

This means:
- Live edits go through DDB (fast, no rebuild)
- Cold starts work even before the first `--prompts` upload (uses the markdown shipped with the container)
- DDB outages don't take down the agent (degrades to the bundled markdown)

---

## Adding a new prompt section

Sections are recognized by the `<!-- @section: NAME -->` marker. To add one (e.g., a separate prompt for B2B customers):

1. **Add the marker and content to `agent/prompts.md`:**

   ```markdown
   <!-- @section: B2B_BLOCK -->
   ## B2B Customer Context

   This customer has a {{B2B_SEGMENT}} segment...
   ```

2. **Add a renderer in `agent/prompt-loader.ts`:**

   ```ts
   export async function renderB2BBlock(vars: { B2B_SEGMENT: string }): Promise<string> {
     const { sections } = await ensureLoaded();
     const template = sections.B2B_BLOCK;
     if (!template) return "";
     return applyPlaceholders(template, vars);
   }
   ```

3. **Call it from `agent/agent.ts` where appropriate:**

   ```ts
   if (customerProfile?.customerType === "BUSINESS") {
     const b2bBlock = await renderB2BBlock({ B2B_SEGMENT: customerProfile.customerSegment });
     // append to system prompt
   }
   ```

4. **Deploy:**

   ```bash
   ./scripts/deploy.sh --prompts   # upload markdown
   ./scripts/deploy.sh --agent     # ship code change
   ```

---

## Tuning the recommendation flow

The `RECOMMENDATION FLOW` section in `prompts.md` controls when the agent shows products vs. asks follow-up questions. The current default is **"show first, refine later"** — always run a recommendation tool with whatever criteria the user gave, then attach optional refinement chips.

Common variants:

| Goal | Edit |
|---|---|
| Always show 5 products before asking anything | Already the default |
| Ask 1-2 questions before showing anything (legacy "filter-first") | Change step 2 from "Always make the recommendation call" to "Ask follow-ups before recommending if criteria are sparse" |
| Show 10 products instead of 5 | The number is enforced by the `recommend_products` tool's `maxResults` default (5). Edit [`agent/agent.ts`](../agent/agent.ts) `recommendProductsTool.callback`, change `maxResults || 5` to `maxResults || 10`, then `--agent` |
| Skip refinement chips entirely | Remove the "Compose a type=answer response with both products AND chips" guidance and tell the agent to never include `followups` |

After editing, run `./scripts/deploy.sh --prompts` (no agent rebuild needed for prompt-only changes).

---

## Customizing chip categories

Refinement chip values are auto-populated from your **actual product catalog** at runtime. The runtime samples up to 1000 vectors from `products-index` and surfaces the top distinct `theme` / `occasion` / `category` / `color` values in the `LIVE CATALOG` section of the prompt.

### Refreshing chips after a catalog change

The facet list is cached in memory for the lifetime of the runtime container. To pick up newly imported themes/occasions/categories without redeploying the agent:

```bash
./scripts/batch-import.sh -p new-products.csv --mode replace
./scripts/deploy.sh --prompts    # writes a cacheBust sentinel; runtime refreshes facets within 60s
```

Mechanism: `--prompts` writes a `_meta.cacheBust` row to the prompts DynamoDB table. On the next 60s poll, the prompt loader compares the value against what it cached previously; if it changed, it calls `clearCatalogFacetsCache()` and the next chat request re-samples the catalog. You'll see this in CloudWatch:

```
[prompt-loader] cacheBust changed (2026-06-08T15:42:11Z -> 2026-06-08T18:03:54Z); refreshing catalog facets
[catalog-facets] Loaded from 1000 vectors: 12 themes, 10 occasions, 8 categories
```

If you only changed the catalog without changing prompts, you can still run `--prompts` — it's idempotent and the sentinel write is what matters.

### Overriding the auto-detected list

If you want to expose a curated set of themes regardless of catalog content:

1. Edit [`agent/tools/catalog-facets.ts`](../agent/tools/catalog-facets.ts) and either:
   - Adjust `topN(values, 12)` to a different cap
   - Pre-seed `FALLBACK_FACETS` if your catalog hasn't been imported yet
   - Hardcode specific themes in the harvester
2. Run `./scripts/deploy.sh --agent` (this requires a rebuild because the harvester is code, not prompt content)

If you want to **change which fields drive the chips** (e.g., add `BRAND` as a refinement axis):

1. In `catalog-facets.ts`, add a `brands: string[]` field to `CatalogFacets`
2. Update the loop to push `m.brand` into a new array
3. In `agent/agent.ts` `buildBasePrompt`, add a `BRANDS` placeholder
4. Edit `prompts.md` to reference `{{BRANDS}}` in the `LIVE CATALOG` section
5. Run `./scripts/deploy.sh --agent --prompts`

---

## Importing user interaction data

The agent has a `query_interactions` tool that searches a third index (`interactions-index`) holding user-item events: views, add-to-cart, purchases. Each event becomes one vector. Useful for behavioral questions like "what have I been browsing" or "show me items I left in my cart".

### CSV format

```csv
USER_ID,ITEM_ID,TIMESTAMP,EVENT_TYPE,EVENT_VALUE,QUANTITY,PRICE,RECOMMENDATION_ID
4503601698855094,13931569,1777423645,add_to_cart,2.0,1,3.97,
4503601723285031,14512445,1777421241,purchase,5.0,1,8.79,
4503601834337855,14245142,1777423969,view,1.0,0,5.07,Recently Viewed
```

Required columns: `USER_ID`, `ITEM_ID`, `TIMESTAMP`, `EVENT_TYPE`. The rest are optional but stored as metadata if present.

### Import command

```bash
./scripts/batch-import.sh -i uploads/interactions.csv --mode replace
```

This pushes the CSV through the same Step Functions pipeline as products/customers: dedup by `(USER_ID, ITEM_ID, TIMESTAMP)` composite key, embed via Bedrock Batch, upload to `interactions-index`. The `dataType: "interactions"` flag in the state machine input routes everything correctly — no other code path changes needed.

### How the agent uses it

The prompt (`agent/prompts.md`) tells Claude to pick `query_interactions` for browsing/cart history questions. A typical chat flow:

1. User: "what items did I add to my cart this week?"
2. Agent calls `query_interactions("add to cart events by user X")` → returns 5 events with itemIds
3. Agent calls `search_products("...")` per itemId to enrich with title/price/link
4. Response renders product cards in the UI

Tuning the agent's preference for this tool: edit the "Tool selection for behavioral queries" block in `agent/prompts.md` and run `./scripts/deploy.sh --prompts` (live in 60s).

### Re-importing after schema changes

Interactions metadata fields (`eventType`, `eventValue`, `quantity`, `price`, `recommendationId`) are mapped in [`glue-jobs/upload-vectors.py`](../glue-jobs/upload-vectors.py) `interaction_to_metadata()`. To add a new field (e.g., `SESSION_ID`):

1. Edit `interaction_to_metadata()` to copy `SESSION_ID` from the raw record
2. If the new field should appear in the embedding text (rather than just metadata), update `interaction_to_text()` in [`glue-jobs/dedup-prepare.py`](../glue-jobs/dedup-prepare.py)
3. Re-run `./scripts/batch-import.sh -i uploads/interactions.csv --mode replace`

Glue jobs auto-pick up the new code on the next batch run; no agent rebuild needed since the agent just reads whatever metadata the index returns.

---

## Changing the persona / tone

The opening lines of the BASE section define the persona:

```markdown
You are a helpful party supply customer service agent with long-term memory. You assist customers with:
1. **Product Discovery** - Help customers find the right party supplies for their events
...
```

**To change persona:**

1. Replace those lines in `prompts.md` (e.g., "You are a no-nonsense pro shopper who only recommends the top-rated picks" or "You are an enthusiastic event planner who suggests creative themes")
2. Update the `Guidelines:` block to match the tone (e.g., remove "friendly, enthusiastic" and replace with "concise and authoritative")
3. `./scripts/deploy.sh --prompts`

The persona affects message text but not response structure (the JSON envelope rules apply regardless).

---

## Tuning the guardrail

Bedrock Guardrails are a separate CDK stack at [`guardrail-cdk/lib/guardrail-stack.ts`](../guardrail-cdk/lib/guardrail-stack.ts). Default tuning:

| Filter | Strength | Why |
|---|---|---|
| HATE | HIGH | Genuinely harmful, unrelated to domain |
| INSULTS, SEXUAL, VIOLENCE, MISCONDUCT | LOW | Bedrock false-positives on legitimate party-supply terms |

To change a filter strength, edit the array in `contentPolicyConfig.filtersConfig`, then:

```bash
./scripts/deploy.sh --guardrail
```

**Adding a denied topic** (e.g., "Returns Policy" if you want to deflect those queries to a human):

1. Add an entry to `topicPolicyConfig.topicsConfig` with `name`, `definition`, `examples`, `type: "DENY"`
2. `./scripts/deploy.sh --guardrail`

The runtime intercepts blocked responses and renders them as a banner instead of raw text — see `buildEnvelope` in [`agent/agent.ts`](../agent/agent.ts).

---

## Changing welcome message and UI copy

The welcome message that appears when a customer opens chat is in [`chat-ui/src/components/ChatWindow.tsx`](../chat-ui/src/components/ChatWindow.tsx) — search for "Hi there! 🎉". Other UI strings ("Want to narrow it down?", placeholder text in the input) live in the same file.

UI changes don't go through DDB; they require restarting the local UI:

```bash
./scripts/run-local-ui.sh --port 3000
```

If you've deployed the UI as a static site, rebuild and redeploy per your hosting setup. The local dev server hot-reloads on file save.

---

## Verifying your changes are live

After running `./scripts/deploy.sh --prompts`:

```bash
# 1. Confirm the upload
aws dynamodb scan --table-name party-supply-prompts \
  --region us-west-2 \
  --query "Items[*].{section:section.S,version:version.S}"

# 2. Trigger a chat that exercises the changed section. New section content
#    appears in <=60s (cache TTL). Look at runtime CloudWatch logs:
aws logs tail /aws/bedrock-agentcore/runtimes/PartySupply_PartySupplyAgent-* \
  --follow --region us-west-2

# 3. The first request after upload logs:
#    [prompts] Loaded 2 sections from prompts.md: BASE, PROFILE_BLOCK
#    or
#    [prompt-loader] DDB read failed: falling back to local prompts.md
```

If the agent's response doesn't reflect your changes after 60 seconds:
- Check CloudWatch for `[prompt-loader]` warnings
- Verify the runtime IAM role has `dynamodb:Scan` on the prompts table (deploy.sh adds this; if you ran a partial deploy, run `--agent` once)
- Confirm the section name in markdown matches what your code calls (e.g., `BASE`, `PROFILE_BLOCK`)

---

## Rolling back a bad prompt

The DDB items have a `version` (ISO timestamp) and `uploadedFrom` field. There's no built-in version history, so the best rollback strategy is:

1. **Git revert the prompt change:**
   ```bash
   git log -p agent/prompts.md       # find the bad commit
   git revert <commit-sha>           # or: git checkout <prev-sha> -- agent/prompts.md
   ```

2. **Re-upload:**
   ```bash
   ./scripts/deploy.sh --prompts
   ```

3. **Confirm version timestamp updated:**
   ```bash
   aws dynamodb scan --table-name party-supply-prompts --region us-west-2 \
     --query "Items[*].version.S"
   ```

If you need to disable the live system prompt entirely (emergency stop) and fall back to the markdown bundled in the container, delete the table — the loader will gracefully fall back:

```bash
aws dynamodb delete-table --table-name party-supply-prompts --region us-west-2
```

The next request after the table goes away will log `[prompt-loader] DDB read failed: falling back to local prompts.md` and use the version baked into the container at last `--agent` deploy.

---

## Reference: placeholder substitution

The loader replaces `{{PLACEHOLDER}}` tokens at request time. Available placeholders:

| Placeholder | Source | Substituted in |
|---|---|---|
| `{{THEMES}}` | top distinct `theme` values from product index | `BASE` |
| `{{OCCASIONS}}` | top distinct `occasion` values | `BASE` |
| `{{CATEGORIES}}` | top distinct `category` values | `BASE` |
| `{{PROFILE_CONTEXT}}` | `formatCustomerProfile(profile)` output | `PROFILE_BLOCK` |
| `{{PROFILE_TIPS}}` | per-customer reasoning rules from `buildProfileTips()` | `PROFILE_BLOCK` |

Unknown placeholders are **left in place** in the rendered prompt (visible to Claude). This is intentional — you'll see typos rather than silently lose content. To add a new placeholder, edit both:

1. `agent/agent.ts` (where the renderer is called) — pass the new key in the `vars` object
2. `agent/prompts.md` — reference `{{NEW_KEY}}` somewhere
