# Path to Production

This guide walks you from a working dev deployment to a production-grade setup. It's organized as a checklist by area: identity & accounts, CI/CD, data pipeline, observability, security, cost, and rollback.

The reference implementation in this repo is intentionally single-account / single-environment so it's easy to learn. Production deployments add a few layers (separate AWS accounts, automated pipelines, monitoring) on top of the same scripts and CDK stacks.

## Table of contents

- [Phase 1: AWS account topology](#phase-1-aws-account-topology)
- [Phase 2: Multi-environment deploys](#phase-2-multi-environment-deploys)
- [Phase 3: CI/CD pipeline](#phase-3-cicd-pipeline)
- [Phase 4: Production data pipeline](#phase-4-production-data-pipeline)
- [Phase 5: Observability & alerting](#phase-5-observability--alerting)
- [Phase 6: Security hardening](#phase-6-security-hardening)
- [Phase 7: Cost guardrails](#phase-7-cost-guardrails)
- [Phase 8: Disaster recovery](#phase-8-disaster-recovery)
- [Pre-launch checklist](#pre-launch-checklist)

---

## Phase 1: AWS account topology

The reference setup runs everything in a single account. For production, separate at least:

| Account | Purpose | Resources |
|---|---|---|
| **dev** | Day-to-day development, prompt iteration | All resources from `./scripts/deploy.sh --all` |
| **staging** | Pre-production validation, load testing | Mirrors prod config, scaled-down |
| **prod** | Customer-facing | Production deployment |

Use AWS Organizations + IAM Identity Center for cross-account access. The IAM policy at [`docs/iam-policy.json`](iam-policy.json) is a starting point — split it by least-privilege per role:

| Role | Use case | Scope |
|---|---|---|
| `agent-deployer` | CI/CD pipeline runner | Full deploy/cleanup permissions |
| `agent-runtime` | The runtime container's execution role | `bedrock:InvokeModel`, `s3vectors:Query*`, `dynamodb:Scan` on prompts table, etc. (see [`scripts/deploy.sh`](../scripts/deploy.sh) `step_agent`) |
| `agent-operator` | On-call humans | Read-only on logs/metrics, ability to rollback prompts |

The deploy script already supports a per-target setup via `--suffix`. For multiple accounts, use the same suffix discipline but combined with profile selection:

```bash
AWS_PROFILE=prod ./scripts/deploy.sh --all
AWS_PROFILE=staging ./scripts/deploy.sh --all
```

---

## Phase 2: Multi-environment deploys

The repo's resource names default to `party-supply-*`. In production you'll want environment isolation. Two approaches:

### Approach A: One account per environment (recommended)

Same resource names, different accounts. The deploy script doesn't need changes — it just runs against whatever credentials are active.

```bash
# dev
AWS_PROFILE=dev ./scripts/deploy.sh --all

# prod (separate account, same resource names)
AWS_PROFILE=prod ./scripts/deploy.sh --all
```

Cleanest because no name collisions, simpler IAM, blast radius limited per environment.

### Approach B: One account, multiple suffixes

For solo/small-team setups where multi-account isn't worth the overhead. The script's resource naming uses a single shared `party-supply` prefix today; to support per-env suffixing you'd need to thread a `STACK_SUFFIX` through:

- `VECTOR_BUCKET_NAME` → `party-supply-vectors-${SUFFIX}`
- `LAMBDA_NAME` → `party-supply-gateway-handler-${SUFFIX}`
- `PROMPTS_TABLE_NAME` → `party-supply-prompts-${SUFFIX}`
- `STACK_NAME` → `AgentCore-PartySupply-${SUFFIX}`
- AgentCore CLI deployment target name (currently `default`)

This is partially scaffolded already but not threaded everywhere. For production, prefer Approach A.

---

## Phase 3: CI/CD pipeline

The repo doesn't ship a CI workflow today — it's manual `./scripts/deploy.sh` from a developer machine. To productionize:

### Recommended: GitHub Actions (or your equivalent)

Create `.github/workflows/deploy.yml` with two jobs:

**Job 1: PR validation** — runs on every PR

```yaml
name: validate
on: [pull_request]
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: cd agent && npm ci
      - run: cd chat-ui && npm ci
      - name: Type check
        run: |
          cd agent && npx tsc --noEmit
          cd ../chat-ui && npx tsc --noEmit
      - name: Shell lint
        run: bash -n scripts/*.sh
      - name: Markdown lint (prompts)
        run: |
          # Verify required prompt sections exist
          grep -q '<!-- @section: BASE -->' agent/prompts.md
```

**Job 2: Deploy on merge to main** — uses [OIDC federation](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html) instead of long-lived access keys

```yaml
name: deploy
on:
  push:
    branches: [main]
jobs:
  deploy-staging:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::STAGING_ACCOUNT:role/agent-deployer
          aws-region: us-west-2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci && cd agent && npm ci
      - run: ./scripts/deploy.sh --prompts --agent --lambda --gateway-target

  deploy-prod:
    needs: deploy-staging
    environment: prod  # GitHub environments require approval before running
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      # ...same as staging but role-to-assume is the prod account
```

### Per-resource deploy strategy

Different resources change at different rates. Map your deploy steps accordingly:

| Resource | Frequency | Pipeline step | Time |
|---|---|---|---|
| Agent runtime container | Every code push to `agent/**` | `--agent` | ~5 min (CodeBuild) |
| Lambda gateway handler | Every push to `lambda/**` | `--lambda --gateway-target` | ~30 sec |
| System prompts | Every push to `agent/prompts.md` | `--prompts` | ~5 sec |
| Guardrail config | Manual review only | `--guardrail` | ~30 sec |
| S3 Vectors / batch infra | Rare (schema changes) | `--vectors --batch-async` | ~5 min |
| Chat UI | Static site rebuild | `cd chat-ui && npm run build && aws s3 sync ...` | ~1 min |

Use `paths` filters in your CI to only run the steps that need to run. Prompt-only edits should be fast: `--prompts` upload + chat UI redeploy if relevant, no agent rebuild.

### Required CI secrets / role permissions

The deploy role needs the actions in [`docs/iam-policy.json`](iam-policy.json) plus:

- `iam:PassRole` for the AgentCore-managed CDK roles
- `dynamodb:CreateTable` / `dynamodb:DeleteTable` for the prompts table
- `cloudformation:*` on the AgentCore stacks

Don't grant `iam:*` blanket — scope to specific role ARNs.

---

## Phase 4: Production data pipeline

The reference catalog uses a synthetic CSV regenerated each deploy. In production, your catalog comes from a source-of-truth system (PIM, e-commerce platform, ERP).

### Sourcing fresh data

Two patterns work well:

**Pattern A: Scheduled batch import** (recommended for catalogs that update daily/weekly)

The repo's [`scripts/batch-import.sh`](../scripts/batch-import.sh) and the [`batch-cdk`](../batch-cdk/lib/batch-processing-stack.ts) Step Functions pipeline are production-ready for this. Wire them up:

1. Land your CSV in S3 nightly from your PIM (use AWS DataSync, AppFlow, or a custom Lambda)
2. EventBridge rule on `s3:ObjectCreated` fires the batch state machine
3. Step Functions runs Glue ETL → Bedrock Batch embedding → Glue upload to S3 Vectors
4. Old vectors stay until replaced (set `--mode replace` in the pipeline if you want full replacement; default is upsert)

The pipeline handles 100K+ products in ~25 min; cost is ~50% of online embedding because Bedrock Batch is half-price.

**Pattern B: Streaming updates** (for high-frequency changes)

Not implemented today — would require a Kinesis or DynamoDB Streams consumer that:

1. Receives product CRUD events
2. Calls `bedrock-runtime:InvokeModel` for the changed product (Titan Embed)
3. Writes the new vector via `s3vectors:PutVectors`

Use this only if you genuinely need <1-minute freshness. Most catalogs do fine on hourly or daily.

### Customer profiles

The reference uses a separate `customers-index` populated from CSV. In production, customers come from your CRM/identity provider:

- **Auth**: replace SigV4 IAM auth with Cognito or your IdP. The chat UI's `lib/sigv4.ts` would be swapped for an `Authorization: Bearer <token>` flow against your provider.
- **Profile data**: depending on size and freshness needs, either:
  - Continue with vector index for semantic lookup ("find customers similar to X")
  - Move profile lookup to a transactional store (DynamoDB keyed on customerId) for exact-key lookups, leaving the vector index just for the segment-similarity use case
- **Privacy**: the existing PII guardrail blocks credit cards/SSN/etc. but raw profile data still flows into the runtime. Treat the runtime container as PII-handling and apply your data residency / retention rules accordingly.

### Schema migrations

Vector indexes have fixed dimensions and metric (1024-d cosine here). To change either, you need to rebuild:

1. Stand up new index alongside the old (e.g., `products-index-v2`)
2. Re-embed and upload to the new index
3. Switch the agent's `searchProducts` call to read from `-v2`
4. Verify, then delete the old index

Plan for it: dual-write or shadow-mode reads during migration.

---

## Phase 5: Observability & alerting

The runtime, Lambda, and CDK stacks already log to CloudWatch. The work here is curation.

### Required dashboards

Build a single CloudWatch dashboard with these panels:

1. **Agent invocation latency** (p50, p95, p99) — from runtime CloudWatch logs, parse `responseTime` field on `request completed` log lines
2. **Tool call distribution** — from the `[envelope]` log lines we emit, count `recommend_products` vs `personalized_search` vs `search_products`
3. **Guardrail interventions** — from `[guardrail] Output blocked` log lines; spike means a content filter or denied topic is firing more than usual (could indicate a malicious user or an over-tuned filter)
4. **Embedding cache hit rate** — from `[embed-cache]` log lines emitted every 50 misses
5. **Catalog facet load source** — `[catalog-facets] Loaded from N vectors` vs `using fallback` (fallback signals an IAM or data issue)
6. **DDB prompt loader source** — `[prompts] Loaded N sections` (DDB) vs `[prompt-loader] DDB read failed` (fallback)
7. **Lambda 500s** — `errors` metric on the gateway handler
8. **S3 Vectors latency** — there's no built-in metric; either instrument client-side timing or skip and rely on overall request p99

Use CloudWatch Logs Insights queries instead of metric filters where you can — cheaper and more flexible.

### Alarms

| Alarm | Threshold | Severity | Action |
|---|---|---|---|
| Gateway Lambda 5xx rate >1% over 5 min | error rate | P1 page | page on-call |
| Runtime p99 latency >10s over 5 min | latency | P2 ticket | investigate Bedrock throttling |
| Guardrail block rate >5% over 15 min | unusual filter activity | P3 review | check for prompt injection or filter mis-tune |
| DDB throttled requests on prompts table | rate limit | P3 review | bump table provisioning (currently PAY_PER_REQUEST so unlikely) |
| Embedding cache hit rate <30% over 1 hour | poor caching | P3 review | inspect query distribution; cache might be too small |
| Prompt loader fallback active for >5 min | DDB outage or IAM | P2 ticket | verify table + role policy |

Wire alarms to SNS → PagerDuty/OpsGenie/your on-call rotation.

### Bedrock-specific quotas

You'll hit these before most other limits:

- **Claude Sonnet 4.5 invocations/min**: default ~30 RPM in us-west-2. Request a service quota increase via AWS Support before launch — production agents need 200-500 RPM at minimum.
- **Titan Embeddings RPM**: similar caps. The LRU cache mitigates a lot but not all.
- **Bedrock Batch concurrent jobs**: 20 by default. Hit this if you're running re-embeds while the live traffic is also batching.

---

## Phase 6: Security hardening

### Auth on the gateway

The reference uses SigV4 IAM auth, which means every chat UI client needs AWS credentials. For production:

1. **Move auth to Cognito or your IdP** — issues bearer tokens to logged-in users
2. **Replace AgentCore Gateway's IAM authorizer with `CUSTOM`** (Lambda authorizer) that validates the bearer token against your IdP
3. **Don't expose IAM credentials in the chat UI bundle** — the `chat-ui/.env.local` pattern in this repo is dev-only

### Secrets

Today the project doesn't have many secrets — credentials come from the EC2 IAM role / runtime execution role. For production, anything that genuinely needs secrecy (API keys to your PIM, third-party model providers, etc.) goes in:

- **AWS Secrets Manager** with rotation enabled
- **SSM Parameter Store** (cheaper, no rotation) for non-rotating config

The runtime role gets `secretsmanager:GetSecretValue` scoped to the specific secret ARN.

### Network isolation

The AgentCore Runtime currently runs `networkMode: PUBLIC` (see [`agentcore/agentcore.json`](../agentcore/agentcore.json)). For production with sensitive data:

- Switch to `VPC` mode and put the runtime in a private subnet
- Add VPC endpoints for `bedrock-runtime`, `s3vectors`, `dynamodb`, `bedrock-agentcore`
- This blocks the runtime from reaching the public internet (good if you're not calling external APIs from tools)

### Prompt injection defense

The agent handles user input directly. Mitigations already in place:

- Bedrock Guardrails (denied topics, PII filters)
- The JSON envelope contract — Claude's output goes through `buildEnvelope` which detects guardrail blocks and refuses non-JSON output gracefully

What to add for production:

- **Input length limit** in the Lambda — reject prompts >2000 chars at the edge before they hit the runtime
- **Rate limiting per IP / token** — API Gateway throttling or a Cloudflare-like layer in front of the gateway
- **Output validation** — the envelope already validates structure, but add `link` URL allowlisting before rendering product cards (don't trust Bedrock to never produce a malicious URL)

### Dependency updates

```bash
# Run regularly in CI
npm audit --production --audit-level=high
cd agent && npm audit --production --audit-level=high
cd ../chat-ui && npm audit --production --audit-level=high
```

Auto-merge minor/patch updates via Dependabot. Pin major versions.

---

## Phase 7: Cost guardrails

Sources of cost in this stack, in rough order:

| Source | Driver | Mitigation |
|---|---|---|
| Bedrock Claude Sonnet 4.5 | Tokens in/out per chat turn | Shorter prompts (the JSON envelope helps), session summarization for long conversations, prompt caching when Bedrock supports it |
| Bedrock Titan Embeddings | Embedding API calls | LRU cache (already in place); use Bedrock Batch for bulk re-embedding (50% cheaper) |
| S3 Vectors | Storage + queries | Storage is cheap; queries scale with index size, not query volume. ~100K products is fine. |
| Lambda invocations | Chat traffic + warm-up pings | Warm-up is ~$0.0002/month; main cost is real traffic |
| AgentCore Memory | Stored events | 30-day TTL keeps growth bounded; tune `eventExpiryDuration` if you need shorter retention |
| CloudWatch Logs | Volume × retention | Set log retention to 7-30 days (`aws logs put-retention-policy`); the reference deploys default to never-expire |
| DynamoDB (prompts table) | PAY_PER_REQUEST scans | At one Scan per ~60s per container, this is negligible (<$1/month) |

### Required cost work pre-launch

1. **Set log retention on every log group** — script it as part of deploy:

   ```bash
   for LG in $(aws logs describe-log-groups --query "logGroups[?starts_with(logGroupName, '/aws/bedrock-agentcore') || starts_with(logGroupName, '/aws/lambda/party-supply')].logGroupName" --output text); do
     aws logs put-retention-policy --log-group-name "$LG" --retention-in-days 30
   done
   ```

2. **Budget alerts** — AWS Budgets at 50% / 80% / 100% of monthly target, scoped to `tag:Project=PartySupplyChatAgent`

3. **Cost Explorer dashboard** — group by `service` and `tag:Project` to track per-component spend

---

## Phase 8: Disaster recovery

### What can fail

| Failure | Blast radius | Recovery |
|---|---|---|
| Runtime container crashes | Single chat session | Auto-restart by AgentCore; <30s |
| AgentCore Runtime stack rollback | All chat traffic | Re-run `./scripts/deploy.sh --agent`; ~5 min |
| Bedrock model unavailable in region | All chat traffic | Switch model in `agent/agent.ts` to a different region's Claude or fail over to a different model ID |
| S3 Vectors region outage | Recommendations fail; agent gracefully degrades to apologetic answer | Cross-region replication isn't supported; accept regional failure or pre-build a backup index |
| DynamoDB prompts table deleted | Runtime falls back to bundled `prompts.md` | Re-run `./scripts/deploy.sh --prompts` to recreate |
| Memory resource (AgentCore Memory) deleted | Lose long-term context for all customers | No clean rebuild — short-term events are also lost. Backup strategy: periodic export via `ListEvents` to S3 |

### Backup strategy

Things to back up periodically (weekly is plenty):

- **DynamoDB prompts table** — point-in-time recovery is free, enable it (`aws dynamodb update-continuous-backups`)
- **AgentCore Memory** — no native backup; periodic `ListEvents` export to S3 if you can't afford to lose conversation history
- **S3 Vectors data** — derivable from your source-of-truth catalog; just keep the source CSVs/PIM data backed up
- **The repo itself** — git history is your prompt and code backup

### Runbooks to write

Every on-call team needs these:

1. **Agent returning generic errors** — check guardrail blocks, runtime logs, IAM role policies, model access
2. **Agent slow** — check Bedrock throttling, embedding cache hit rate, S3 Vectors latency
3. **Wrong/stale prompt** — verify `--prompts` upload landed, check 60s cache TTL, force restart if needed
4. **Compromised credentials** — disable IAM user, rotate runtime role, audit CloudTrail for what was accessed

The [`scripts/troubleshoot.sh`](../scripts/troubleshoot.sh) script automates a lot of the diagnostic work — keep it in your runbooks as the first step.

---

## Pre-launch checklist

Run through this before customer traffic hits the agent:

### Must-haves

- [ ] Separate AWS account for production (not your dev account)
- [ ] CI pipeline deploys on merge to main (no manual `./scripts/deploy.sh` from laptops)
- [ ] OIDC federation, no long-lived access keys in CI
- [ ] CloudWatch alarms for 5xx rate, p99 latency, guardrail block rate
- [ ] Log retention set on all log groups (30d minimum)
- [ ] Budget alerts wired to a real human
- [ ] Bedrock model quotas raised to projected RPM (file the support ticket weeks early)
- [ ] Auth replaced with bearer-token / IdP (no IAM credentials in chat UI bundle)
- [ ] Input length limit at the gateway Lambda
- [ ] Rate limiting in front of the gateway
- [ ] DDB prompts table has point-in-time recovery enabled
- [ ] On-call rotation defined, runbooks written

### Nice-to-haves before launch

- [ ] Canary chat invocation every 5 min from CloudWatch synthetics (catches regressions before users do)
- [ ] Distributed tracing via OpenTelemetry (the agent already has `@opentelemetry/auto-instrumentations-node` installed; just configure the exporter)
- [ ] Blue/green deploy for the runtime — AgentCore supports endpoint versions, route a fraction of traffic to the new version before cutting over
- [ ] Synthetic eval suite — run 50 known prompts against staging on every merge, score the responses against expected behavior

### Things you'll regret skipping

- [ ] Tag every resource with `Project=PartySupplyChatAgent`, `Environment=prod`, `Owner=<team>` — required for cost attribution and incident response
- [ ] Document who owns what — when a model invocation fails at 3am, you want a clear path from alert → runbook → who to escalate
- [ ] Test the cleanup script in a scratch account before you ever need to run it in prod (it deletes a lot of resources)
