# workflowy-mcp

A remote MCP server that wraps the [official Workflowy REST API](https://workflowy.com/api-reference/). It runs on Cloudflare Workers and can be added to claude.ai (web/mobile/desktop) as a custom connector, letting you search, browse, and edit your Workflowy outline from Claude.

## Architecture

- **Reads** are served from a D1 mirror with FTS5 full-text search, because the official API has no search endpoint
- **Writes** go straight to the official API, then are optimistically reflected into the D1 mirror
- **Mirror freshness** is maintained by lazy sync on read-tool calls (15-minute threshold) plus a twice-daily cron
- **Auth** is OAuth 2.1 via [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider), with GitHub as the upstream IdP and an allowlist (`ALLOWED_GITHUB_USERS`) gating authorization
- The Workflowy API key lives in a Worker secret and is never exposed to clients

```
claude.ai ──OAuth 2.1──> Workers (OAuthProvider + McpAgent)
                              │
                              ├── reads:  D1 mirror (FTS5 trigram)
                              └── writes: Workflowy API ──on success──> D1 upsert
```

## MCP tools

| Tool | Kind | Description |
|---|---|---|
| `search_nodes` | read | Full-text search over name/note, returns ancestor paths |
| `get_subtree` | read | Renders a node's descendants as nested Markdown (up to 500 nodes) |
| `get_node` | read | Single node detail plus immediate children |
| `create_node` | write | Create a node; `parent_id` accepts special targets like "inbox" / "today" |
| `update_node` | write | Update name / note |
| `complete_node` / `uncomplete_node` | write | Complete / uncomplete |
| `move_node` | write | Move to another parent / position |
| `sync_now` | ops | Force a full mirror refresh |

**Delete is intentionally not exposed** (the official DELETE endpoint is irreversible).

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

## Design notes

### Rate limits

`GET /nodes-export` (full sync) is rate-limited upstream to **1 request/minute**. To respect this, sync attempts are skipped if the previous attempt was less than 60 seconds ago (this also applies to `sync_now`).

### Lazy sync threshold

Read tools (`search_nodes` / `get_subtree` / `get_node`) check `last_synced_at` before running and perform an inline full sync if it is older than **15 minutes**. Within that window they serve straight from D1, so changes made in Workflowy itself may not be visible yet. Call `sync_now` first if you need the latest state.

### Full-text search

The mirror uses the FTS5 **trigram tokenizer** (verified to work on D1 both locally and remotely). It supports substring matching for both Japanese and English, but trigram matching cannot handle queries shorter than 3 code points; those queries automatically fall back to a LIKE scan over the plain-text FTS columns.

The FTS table stores plain text with inline HTML tags stripped from name/note.

### Mirror consistency after writes

Write tools upsert the affected node into D1 on success, but sibling ordering (e.g. priorities reshuffled by `move_node`) may remain stale until the next full sync.

## Future extensions (out of scope)

- Nightly Markdown export from the D1 mirror to a GitHub repository (knowledge vault)
- Incremental sync (full refresh is sufficient for now)
- Privacy filter (excluding specific subtrees). All read queries go through the shared functions in `src/queries.ts`, so a filter can be added in one place
