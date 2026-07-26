# workflowy-remote-mcp

A remote MCP server that wraps the [official Workflowy REST API](https://workflowy.com/api-reference/). It runs on Cloudflare Workers and can be added to claude.ai (web/mobile/desktop) as a custom connector, letting you search, browse, and edit your Workflowy outline from Claude.

## Motivation

Two gaps drove this project:

1. **Existing Workflowy MCP servers are local (stdio) servers.** They work fine with desktop clients, but claude.ai on the web and mobile can only talk to *remote* MCP servers added as custom connectors — so if you want your outline available from a browser or your phone, a hosted server is the only option.
2. **You can't search.** The official REST API has no search endpoint, so existing MCP servers built on it can't offer search either. For a large outline, an LLM can't do anything useful without it. This server fills the gap by maintaining a D1 mirror of the whole outline with full-text search (FTS5).

A couple of further design choices follow from there:

- LLMs consume outlines best as Markdown, so `get_subtree` renders a whole subtree as a nested Markdown list in one call instead of forcing the model to walk the tree node by node
- Running on Cloudflare Workers + D1 + KV keeps it zero-maintenance and effectively free at personal scale

It is designed as a **single-user** server: authentication decides who may connect (GitHub OAuth + allowlist), while all requests operate on the one Workflowy account whose API key is stored as a Worker secret.

## Architecture

- **Reads** go to the official API by default. The D1 mirror serves only what the API cannot answer: full-text search (no search endpoint) and multi-level subtree walks (List returns one level at a time)
- **Writes** go straight to the official API, then are optimistically reflected into the D1 mirror
- **Mirror freshness** is maintained by a twice-daily cron plus on-demand `sync_now`. Reads never sync inline — a full sync takes minutes on a large outline, well past an MCP client's timeout
- **Auth** is OAuth 2.1 via [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider), with GitHub as the upstream IdP and an allowlist (`ALLOWED_GITHUB_USERS`) gating authorization
- The Workflowy API key lives in a Worker secret and is never exposed to clients

```
claude.ai ──OAuth 2.1──> Workers (OAuthProvider + McpAgent)
                              │
                              ├── reads:  Workflowy API, except
                              │           search + deep subtree: D1 mirror (FTS5 trigram)
                              └── writes: Workflowy API ──on success──> D1 upsert
```

## MCP tools

| Tool | Kind | Description |
|---|---|---|
| `search_nodes` | read | Full-text search over name/note, returns ancestor paths. Mirror-backed |
| `get_subtree` | read | Renders a node's descendants as nested Markdown (up to 500 nodes). `max_depth=1` is API-only and always current; deeper walks read the mirror and report its last sync time |
| `get_node` | read | Single node detail plus immediate children. API-only, always current |
| `create_node` | write | Create a node |
| `update_node` | write | Update name / note |
| `complete_node` / `uncomplete_node` | write | Complete / uncomplete |
| `move_node` | write | Move to another parent / position |
| `sync_now` | ops | Force a full mirror refresh |

**Delete is intentionally not exposed** (the official DELETE endpoint is irreversible).

### Node identifiers

Every `node_id` / `parent_id` accepts the same vocabulary, resolved in
`src/node-id.ts`:

| Form | Example |
|---|---|
| Full UUID | `6e9c5b0a-1234-4abc-8def-f06c631642eb` |
| 12-digit short id | `f06c631642eb` |
| Workflowy URL | `https://workflowy.com/#/f06c631642eb` |
| Calendar target | `today`, `tomorrow`, `next_week`, `calendar`, `2026`, `2026-07`, `2026-07-25` |
| Inbox | `inbox` |
| Top level of the outline | `None` |
| User-defined shortcut key | `rd` |

Identifiers are resolved by the official API, which is the authority on this
vocabulary. Calendar targets resolve existing nodes only — reads never create
a date node.

Two narrower rules apply where the vocabulary is asymmetric upstream:

- A `node_id` addressing a single node (the `:id` path segment of Retrieve,
  Update, Move, Complete, Uncomplete) accepts only full UUIDs, short ids and
  calendar targets. URLs are reduced to a short id, and shortcut keys are
  resolved to a UUID first; `None` is rejected, since the outline root is not
  a writable node. A `parent_id` takes the whole table above as-is.
- `get_subtree` with `max_depth>=2` reads the mirror anyway, so a UUID the
  mirror already holds short-circuits there with no HTTP call. Every other
  read resolves through the API, so that what it returns is never a stale
  mirror row.

## Setup

### 1. Create a GitHub OAuth App

Create a [GitHub OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app):

- Homepage URL: `https://workflowy-mcp.<your-subdomain>.workers.dev`
- Authorization callback URL: `https://workflowy-mcp.<your-subdomain>.workers.dev/callback`
- Note the Client ID and generate a Client secret

### 2. Create the KV namespace and D1 database

```bash
npm install
cp wrangler.jsonc.example wrangler.jsonc

# KV namespace for OAuth token storage
npx wrangler kv namespace create OAUTH_KV
# Put the returned id into kv_namespaces[0].id in wrangler.jsonc

# D1 database for the mirror
npx wrangler d1 create workflowy-mirror
# Put the returned database_id into d1_databases[0].database_id in wrangler.jsonc

# Apply the schema (remote)
npm run db:migrate:remote
```

### 3. Set secrets

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # e.g. openssl rand -hex 32
npx wrangler secret put WORKFLOWY_API_KEY       # get one at https://workflowy.com/api-key
npx wrangler secret put ALLOWED_GITHUB_USERS    # comma-separated GitHub usernames, e.g. yourusername,teammate1
```

If `ALLOWED_GITHUB_USERS` is unset, all authorization attempts are rejected (fail-closed).

### 4. Deploy

```bash
npm run deploy
```

Or set up GitHub Actions and let pushes to `main` deploy for you — see [Continuous deployment](#continuous-deployment).

## Continuous deployment

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yaml` | pull requests, pushes to `main` | `type-check` + `test` |
| `deploy.yaml` | pushes to `main`, manual dispatch | `type-check` + `test`, then `wrangler deploy` |
| `migrate-d1.yaml` | manual dispatch only | Applies `schema.sql` to the remote D1 database |

`deploy.yaml` re-runs the checks itself rather than depending on the CI run, so a manual dispatch cannot skip them.

### Repository secrets

Set these under Settings → Secrets and variables → Actions. The two id secrets exist because `wrangler.jsonc` is gitignored — it holds account-specific resource ids, so CI rebuilds it from `wrangler.jsonc.example` with the ids substituted in. Changes to bindings, crons or migrations therefore stay reviewable in the example file rather than hidden in a secret.

| Secret | Where to find it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens, using the **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages, right-hand sidebar |
| `CF_KV_ID` | `id` of the `OAUTH_KV` namespace in your local `wrangler.jsonc` |
| `CF_D1_DATABASE_ID` | `database_id` of the `DB` binding in your local `wrangler.jsonc` |

`deploy.yaml` and `migrate-d1.yaml` both target a `production` environment, so you can require a reviewer for deploys under Settings → Environments.

The five Worker secrets from [Set secrets](#3-set-secrets) are **not** managed by these workflows. `wrangler deploy` leaves existing secrets alone, so set them once with `wrangler secret put` and they persist across deploys.

### Dependencies

This is a deployed Worker, not a published package, so every dependency is **pinned exactly** in `package.json` and `package-lock.json` is committed. CI installs with `npm ci`, so a build never silently picks up a different version than the one that was reviewed.

Renovate (`renovate.json5`) keeps them current under the same policy:

- Ordinary updates wait **7 days** after publication (`minimumReleaseAge`). Compromised releases are usually detected and pulled within days, and 7 days also clears npm's 72-hour unpublish window.
- **Security** updates bypass that wait — a known exposure outweighs the supply-chain risk of a fresh release.
- Minor and patch updates arrive as one grouped PR; majors get their own.
- `rangeStrategy: "pin"` keeps pins pinned rather than widening them into ranges.

Renovate is a GitHub App and must be installed on the repository separately; the config file alone does nothing.

`npm audit` currently reports 4 moderate advisories, all reached through `agents` → `@modelcontextprotocol/sdk` → `@hono/node-server`. The advisory is a path traversal in that package's `serve-static` on Windows; this Worker never imports it and does not run on Node, so it is not exposed. `npm audit fix` proposes `agents@0.3.4`, which is older than the pinned `0.17.4` — the advisory range is expressed in a way npm's comparison mishandles, so applying it would be a downgrade.

### D1 migrations are deliberately manual

`schema.sql` opens with `DROP TABLE`, so applying it wipes the mirror. That is recoverable — the next `sync_now` or scheduled run rebuilds it from Workflowy — but it should never happen as a side effect of a deploy. `migrate-d1.yaml` is dispatch-only and requires typing `DROP AND RECREATE` to confirm.

## Adding the connector to claude.ai

1. claude.ai → Settings → Connectors → **Add custom connector**
2. Enter `https://workflowy-mcp.<your-subdomain>.workers.dev/mcp` as the URL
3. You will be redirected to GitHub to sign in
4. If your GitHub user is on the allowlist, the connection completes and the tools become available

Notes:

- Keep the connector name simple, e.g. `Workflowy`. Names with parenthetical annotations like `(my own)` can prevent the model from finding the tools in chat
- If the connector is connected but tools are not callable from a chat, check that the connector is enabled in the tools menu (search & tools) under the chat input box

## Local development

Create a separate GitHub OAuth App for local use (callback URL: `http://localhost:8788/callback`).

```bash
cp .dev.vars.example .dev.vars   # fill in the values
npm run db:migrate:local         # apply the schema to local D1
npm run dev                      # serves http://localhost:8788
```

Connect [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) to `http://localhost:8788/mcp` to exercise the full OAuth flow:

```bash
npx @modelcontextprotocol/inspector@latest
```

TypeScript types for bindings are generated from your local `wrangler.jsonc`:

```bash
npm run cf-typegen
```

### Tests

```bash
npm test          # vitest, running inside workerd
npm run type-check
```

Files named `*-bench.test.ts` are throughput probes rather than assertions — they write ~25k rows and take minutes — so they are excluded by default. Run one deliberately:

```bash
BENCH=1 npx vitest run test/sync-bench.test.ts --disable-console-intercept
```

Tests run under `@cloudflare/vitest-pool-workers`, so D1 behaves as it does in production (FTS5, the trigram tokenizer, batch semantics). The pool is configured with a bare D1 binding rather than `wrangler.jsonc`, whose Durable Objects, KV and OAuth provider the unit tests do not exercise. `test/` has its own `tsconfig.json` because it needs the `cloudflare:test` types.

## Design notes

### Rate limits

`GET /nodes-export` (full sync) is rate-limited upstream to **1 request/minute**. To respect this, a sync is skipped — without touching the endpoint — if the previous attempt was less than 60 seconds ago (`attempted_too_recently`, which also applies to `sync_now`) or if another sync is still running (`already_running`).

### No sync on reads

Read tools never sync. They used to: `search_nodes` and `get_subtree` ran an inline full sync when `last_synced_at` was older than 15 minutes. On a real outline (~25k nodes) that took minutes — longer than an MCP client waits — so the read timed out while the sync completed unseen.

Sync has since been made substantially faster (see [Mirror consistency during sync](#mirror-consistency-during-sync)), but a full sync against production still takes ~29s at 24.8k nodes — well beyond what a read should block on. Reads therefore still never sync. Even were it instant, a sync is gated on `GET /nodes-export`, whose latency is not ours to control and whose 1 req/min budget reads would be spending on the caller's behalf, at moments nothing in the response explains.

The mirror is refreshed by the twice-daily cron and by `sync_now`. Reads answer from whatever it currently holds, and `get_subtree` states its last sync time so a caller who needs certainty can run `sync_now` first.

### Reads: which layer answers what

`get_node` and `get_subtree` with `max_depth=1` go entirely to the API — one Retrieve to resolve the identifier, one List for the children — and issue **no D1 query at all**.

`get_subtree` with `max_depth>=2` resolves its starting point through the API and then recurses the **mirror**, appending the mirror's last sync time to its output. List returns a single level, so walking a depth-N subtree through the API would cost one HTTP call per node; the mirror recursion is the right shape for that read. When the starting point resolves but has no mirror row — a node created since the last sync — the tool falls back to one level from List and says so rather than returning a silently empty subtree. It never triggers `nodes-export` to paper over the gap.

All three read tools return the same node shape (`snake_case`, flat `layout_mode`), regardless of which layer answered.

### Full-text search

The mirror uses the FTS5 **trigram tokenizer** (verified to work on D1 both locally and remotely). It supports substring matching for both Japanese and English, but trigram matching cannot handle queries shorter than 3 code points; those queries automatically fall back to a LIKE scan over the plain-text FTS columns.

The FTS table stores plain text with inline HTML tags stripped from name/note.

### Mirror consistency during sync

A full sync must never leave the mirror unreadable, because D1 gives it no transaction to hide behind: the export is written over many separate `batch()` calls spanning ~29s, and reads land between them.

So `fullSync` does **not** wipe `nodes`. Rows are upserted in place and only ids missing from the export are deleted afterwards, which keeps every row continuously visible and means a node is never absent from the mirror while it still exists upstream.

`nodes_fts` is the exception: it *is* rebuilt wholesale, because it holds no data of its own — only an index derived from `nodes`. It is contentless fts5 whose `id` column is `UNINDEXED`, so `DELETE ... WHERE id = ?` is a full table scan; at 24.8k nodes those per-id deletes measured **~35s locally**, against ~0.5s for the inserts and ~0.1s for a single whole-table wipe — and locally is the *favourable* case for them, since each one avoids a network round-trip. Rebuilding costs `search_nodes` its hits for the few hundred milliseconds it takes, while `get_node` and `get_subtree` never touch the index and are unaffected.

### Batch width: measure it deployed, not locally

Batch width must be tuned against the deployed Worker. Local miniflare will actively mislead you here: its D1 is in-process, so there is no round-trip to amortise and every width from 100 to 5000 lands within 3% of the rest. Deployed, each `batch()` is a network call and the write phase is ~96% of sync time.

Measured against production at 24.8k nodes (~50k statements):

| statements per `batch()` | round-trips | full sync |
|---|---|---|
| 500 | 100 | 68–76s |
| 1000 | 50 | 55s |
| **2500** | **20** | **29s** |
| 5000 | 10 | 31s |

Returns flatten past ~2500, so that is the setting: as fast as 5000, with half the time spent inside any single `batch()` call and correspondingly more headroom under D1's 30s-per-call cap.

Timings come from `last_sync_phases` in `sync_meta`, written as each phase completes rather than accumulated and stored at the end — a sync killed by the Worker's wall-clock limit never reaches its return statement, so anything buffered until then is lost. Read it with:

```bash
npx wrangler d1 execute workflowy-mirror --remote \
  --command "SELECT value FROM sync_meta WHERE key='last_sync_phases'"
```

The local `test/*-bench.test.ts` probes remain useful for comparing *what statements do* (they are how the FTS delete was found), but not for anything latency-bound. They are excluded from `npm test`; run one with `BENCH=1 npx vitest run test/sync-bench.test.ts --disable-console-intercept`.

Only one sync may run at a time, enforced by a leased lock in `sync_meta` claimed via a single conditional write (a `SELECT`-then-`INSERT` pair could interleave). The 60-second debounce cannot do this on its own: a full sync takes longer than that window, so a caller arriving mid-sync would sail straight past it. Overlapping callers get `skippedReason: "already_running"` without spending the export budget.

### Mirror consistency after writes

Write tools upsert the affected node into D1 on success, but sibling ordering (e.g. priorities reshuffled by `move_node`) may remain stale until the next full sync.

## Future extensions (out of scope)

- Nightly Markdown export from the D1 mirror to a GitHub repository (knowledge vault)
- Incremental sync (full refresh is sufficient for now)
- Privacy filter (excluding specific subtrees). All read queries go through the shared functions in `src/queries.ts`, so a filter can be added in one place
