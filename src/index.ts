import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { GitHubHandler } from "./github-handler";
import { stripHtml } from "./markdown";
import { NodeIdentifierError, NodeNotFoundError, normalizeForApi } from "./node-id";
import { searchNodes } from "./queries";
import { fullSync } from "./sync";
import { getNode, getSubtree, resolveForWrite } from "./tools";
import {
	completeNodeSchema,
	createNodeSchema,
	getNodeSchema,
	getSubtreeSchema,
	moveNodeSchema,
	searchNodesSchema,
	syncNowSchema,
	uncompleteNodeSchema,
	updateNodeSchema,
} from "./tool-schemas";
import { WorkflowyApiError, WorkflowyClient } from "./workflowy-client";
import type { Props } from "./utils";

function formatApiError(err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
	if (err instanceof NodeIdentifierError || err instanceof NodeNotFoundError) {
		return { content: [{ type: "text", text: err.message }], isError: true };
	}
	if (err instanceof WorkflowyApiError) {
		return {
			content: [
				{
					type: "text",
					text: `Workflowy API error (status ${err.status} ${err.statusText}):\n${err.body}`,
				},
			],
			isError: true,
		};
	}
	const message = err instanceof Error ? err.message : String(err);
	return { content: [{ type: "text", text: `Unexpected error: ${message}` }], isError: true };
}

function upsertNodeFromApi(db: D1Database, node: {
	id: string;
	parent_id: string | null;
	name: string;
	note: string | null;
	priority: number;
	data?: { layoutMode?: string };
	createdAt: number | null;
	modifiedAt: number | null;
	completedAt: number | null;
}) {
	return db
		.prepare(
			`INSERT INTO nodes (id, parent_id, name, note, priority, layout_mode, created_at, modified_at, completed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   parent_id = excluded.parent_id,
			   name = excluded.name,
			   note = excluded.note,
			   priority = excluded.priority,
			   layout_mode = excluded.layout_mode,
			   created_at = excluded.created_at,
			   modified_at = excluded.modified_at,
			   completed_at = excluded.completed_at`,
		)
		.bind(
			node.id,
			node.parent_id,
			node.name ?? "",
			node.note ?? null,
			node.priority ?? 0,
			node.data?.layoutMode ?? "bullets",
			node.createdAt ?? null,
			node.modifiedAt ?? null,
			node.completedAt ?? null,
		)
		.run();
}

async function upsertFtsForNode(db: D1Database, id: string, name: string, note: string | null) {
	await db
		.prepare("DELETE FROM nodes_fts WHERE id = ?")
		.bind(id)
		.run();
	await db
		.prepare("INSERT INTO nodes_fts (id, name, note) VALUES (?, ?, ?)")
		.bind(id, stripHtml(name), stripHtml(note))
		.run();
}

export class WorkflowyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "Workflowy MCP Server",
		version: "1.0.0",
	});

	async init() {
		const db = this.env.DB;
		const apiKey = this.env.WORKFLOWY_API_KEY;
		const client = new WorkflowyClient(apiKey);

		// --- Read tools ---

		this.server.registerTool(
			"search_nodes",
			{
				description:
					'Full-text search across the whole Workflowy outline. Searches the D1 mirror and returns each hit\'s id, name, note excerpt (first 200 characters), ancestor path (names from the root joined with " > ") and last modified time. Queries in any language are supported. Results come from the mirror rather than the official API, so very recent edits may be missing; run sync_now first to be certain the results are current.',
				inputSchema: searchNodesSchema,
			},
			async ({ query, limit, include_completed }) => {
				try {
					// No inline sync: the mirror is refreshed by cron and sync_now.
					// Syncing here would make the search wait minutes on a large
					// outline, past the client's timeout, to no benefit.
					const hits = await searchNodes(db, query, {
						limit,
						includeCompleted: include_completed,
					});
					return {
						content: [{ type: "text", text: JSON.stringify(hits, null, 2) }],
					};
				} catch (err) {
					return formatApiError(err);
				}
			},
		);

		this.server.registerTool(
			"get_subtree",
			{
				description:
					"Render the subtree under a node as a nested Markdown bullet list. The starting point can be given as a UUID, a URL, a 12-character short id, a calendar target, and so on. With max_depth=1 the children come straight from the official API and are always current. With max_depth>=2 the D1 mirror is walked recursively, so the result may be stale; the mirror's last sync time is appended at the end, and sync_now refreshes it. Todos render as checkboxes, headings as bold, code blocks as fenced code, and quote blocks as blockquotes. Output is truncated past 500 nodes, with a note saying so.",
				inputSchema: getSubtreeSchema,
			},
			async ({ node_id, max_depth }) => {
				try {
					// No inline sync here either; a deep walk reports the mirror's
					// last sync time so the caller can run sync_now if it matters.
					const markdown = await getSubtree(db, client, node_id, max_depth);
					return { content: [{ type: "text", text: markdown }] };
				} catch (err) {
					return formatApiError(err);
				}
			},
		);

		this.server.registerTool(
			"get_node",
			{
				description:
					'Return the details of a single node (id, parent_id, name, note, priority, layout_mode, created_at, modified_at, completed_at) together with its immediate children. Both the node and its children come straight from the official API, so the result is always current and sync_now is not needed beforehand. URLs, 12-character short ids and calendar targets can be passed as-is. Use search_nodes when the ancestor path is needed. Passing "None" (the top level) as node_id returns a null node with the top-level nodes as children.',
				inputSchema: getNodeSchema,
			},
			async ({ node_id }) => {
				try {
					// Nothing here reads the mirror: both the node and its children
					// come from the API, so its staleness cannot affect the answer.
					const result = await getNode(db, client, node_id);
					return {
						content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					};
				} catch (err) {
					return formatApiError(err);
				}
			},
		);

		// --- Write tools ---

		this.server.registerTool(
			"create_node",
			{
				description:
					'Create a new node. parent_id accepts a UUID, a URL, a 12-character short id, a calendar target, "inbox" or "None" (the root). Writes go straight to the official API and, on success, are applied to the D1 mirror as well.',
				inputSchema: createNodeSchema,
			},
			async ({ parent_id, name, note, position }) => {
				try {
					const node = await client.createNode({
						parent_id: normalizeForApi(parent_id),
						name,
						note,
						position,
					});
					await upsertNodeFromApi(db, node);
					await upsertFtsForNode(db, node.id, node.name, node.note);
					return { content: [{ type: "text", text: JSON.stringify(node, null, 2) }] };
				} catch (err) {
					return formatApiError(err);
				}
			},
		);

		this.server.registerTool(
			"update_node",
			{
				description:
					"Update the name and/or note of an existing node. Writes go straight to the official API and, on success, are applied to the D1 mirror as well.",
				inputSchema: updateNodeSchema,
			},
			async ({ node_id, name, note }) => {
				try {
					const node = await client.updateNode(await resolveForWrite(db, client, node_id), {
							name,
						note,
					});
					await upsertNodeFromApi(db, node);
					await upsertFtsForNode(db, node.id, node.name, node.note);
					return { content: [{ type: "text", text: JSON.stringify(node, null, 2) }] };
				} catch (err) {
					return formatApiError(err);
				}
			},
		);

		this.server.registerTool(
			"complete_node",
			{
				description:
					"Mark a node as completed. Writes go straight to the official API and, on success, are applied to the D1 mirror as well.",
				inputSchema: completeNodeSchema,
			},
			async ({ node_id }) => {
				try {
					const node = await client.completeNode(await resolveForWrite(db, client, node_id));
					await upsertNodeFromApi(db, node);
					return { content: [{ type: "text", text: JSON.stringify(node, null, 2) }] };
				} catch (err) {
					return formatApiError(err);
				}
			},
		);

		this.server.registerTool(
			"uncomplete_node",
			{
				description:
					"Return a node to the uncompleted state. Writes go straight to the official API and, on success, are applied to the D1 mirror as well.",
				inputSchema: uncompleteNodeSchema,
			},
			async ({ node_id }) => {
				try {
					const node = await client.uncompleteNode(await resolveForWrite(db, client, node_id));
					await upsertNodeFromApi(db, node);
					return { content: [{ type: "text", text: JSON.stringify(node, null, 2) }] };
				} catch (err) {
					return formatApiError(err);
				}
			},
		);

		this.server.registerTool(
			"move_node",
			{
				description:
					"Move a node under a different parent, or to a different position among its siblings. Writes go straight to the official API and, on success, are applied to the D1 mirror as well.",
				inputSchema: moveNodeSchema,
			},
			async ({ node_id, parent_id, position }) => {
				try {
					// node_id lands in the URL path (narrow vocabulary); parent_id is a
					// body field and accepts shortcut keys, "None" and "inbox" as-is.
					const node = await client.moveNode(await resolveForWrite(db, client, node_id), {
						parent_id: normalizeForApi(parent_id),
						position,
					});
					await upsertNodeFromApi(db, node);
					return { content: [{ type: "text", text: JSON.stringify(node, null, 2) }] };
				} catch (err) {
					return formatApiError(err);
				}
			},
		);

		// --- Operational tools ---

		this.server.registerTool(
			"sync_now",
			{
				description:
					"Fully resynchronise the D1 mirror with the current state of Workflowy (fullSync). Skipped if a sync was already attempted within the last 60 seconds, or if another sync is in progress. Returns the last sync time along with the number of nodes synced and deleted. The mirror stays readable throughout the sync.",
				inputSchema: syncNowSchema,
			},
			async () => {
				const result = await fullSync(db, apiKey);
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
			},
		);
	}
}

const oauthProvider = new OAuthProvider({
	apiHandler: WorkflowyMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return oauthProvider.fetch(request, env, ctx);
	},
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(fullSync(env.DB, env.WORKFLOWY_API_KEY).then(() => undefined));
	},
} satisfies ExportedHandler<Env>;
