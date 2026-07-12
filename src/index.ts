import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { GitHubHandler } from "./github-handler";
import { renderSubtreeMarkdown, stripHtml } from "./markdown";
import { getAncestorPath, getChildren, getNodeById, searchNodes, toRenderableNode } from "./queries";
import { ensureFresh, fullSync } from "./sync";
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

		// --- 読み系ツール ---

		this.server.registerTool(
			"search_nodes",
			{
				description:
					"Workflowy のアウトライン全体を全文検索する。D1 ミラーから検索し、ヒットしたノードの id・name・note抜粋(先頭200字)・祖先パス(ルートからの name を \" > \" 連結)・最終更新日時を返す。日本語・英語どちらのクエリにも対応。",
				inputSchema: searchNodesSchema,
			},
			async ({ query, limit, include_completed }) => {
				try {
					await ensureFresh(db, apiKey);
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
					"指定ノード配下を D1 ミラーから再帰的に組み立て、Markdown のネスト箇条書きとしてレンダリングして返す。todo は チェックボックス、見出しは太字、code-block はコードフェンス、quote-block は引用として表現される。ノード数が500件を超える場合は打ち切ってその旨を伝える。",
				inputSchema: getSubtreeSchema,
			},
			async ({ node_id, max_depth }) => {
				try {
					await ensureFresh(db, apiKey);
					const root = await getNodeById(db, node_id);
					if (!root) {
						return {
							content: [{ type: "text", text: `Node not found in mirror: ${node_id}` }],
							isError: true,
						};
					}
					const { markdown } = await renderSubtreeMarkdown(
						toRenderableNode(root),
						async (parentId) => (await getChildren(db, parentId)).map(toRenderableNode),
						{ maxDepth: max_depth, includeCompleted: true },
					);
					return { content: [{ type: "text", text: markdown }] };
				} catch (err) {
					return formatApiError(err);
				}
			},
		);

		this.server.registerTool(
			"get_node",
			{
				description: "単一ノードの詳細情報(id, name, note, layoutMode, 各種日時)と直下の子ノード一覧を返す。",
				inputSchema: getNodeSchema,
			},
			async ({ node_id }) => {
				try {
					await ensureFresh(db, apiKey);
					const node = await getNodeById(db, node_id);
					if (!node) {
						return {
							content: [{ type: "text", text: `Node not found in mirror: ${node_id}` }],
							isError: true,
						};
					}
					const children = await getChildren(db, node_id);
					const ancestorPath = await getAncestorPath(db, node_id);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({ node, ancestor_path: ancestorPath, children }, null, 2),
							},
						],
					};
				} catch (err) {
					return formatApiError(err);
				}
			},
		);

		// --- 書き系ツール ---

		this.server.registerTool(
			"create_node",
			{
				description:
					'新しいノードを作成する。parent_id には UUID のほか "inbox" / "today" / "tomorrow" / "YYYY-MM-DD" / "None"(ルート) が使える。公式APIへ直行し、成功したら D1 ミラーにも反映する。',
				inputSchema: createNodeSchema,
			},
			async ({ parent_id, name, note, position }) => {
				try {
					const node = await client.createNode({ parent_id, name, note, position });
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
				description: "既存ノードの name / note を更新する。公式APIへ直行し、成功したら D1 ミラーにも反映する。",
				inputSchema: updateNodeSchema,
			},
			async ({ node_id, name, note }) => {
				try {
					const node = await client.updateNode(node_id, { name, note });
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
				description: "ノードを完了状態にする。公式APIへ直行し、成功したら D1 ミラーにも反映する。",
				inputSchema: completeNodeSchema,
			},
			async ({ node_id }) => {
				try {
					const node = await client.completeNode(node_id);
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
				description: "ノードを未完了状態に戻す。公式APIへ直行し、成功したら D1 ミラーにも反映する。",
				inputSchema: uncompleteNodeSchema,
			},
			async ({ node_id }) => {
				try {
					const node = await client.uncompleteNode(node_id);
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
				description: "ノードを別の親の配下、または兄弟内の別位置へ移動する。公式APIへ直行し、成功したら D1 ミラーにも反映する。",
				inputSchema: moveNodeSchema,
			},
			async ({ node_id, parent_id, position }) => {
				try {
					const node = await client.moveNode(node_id, { parent_id, position });
					await upsertNodeFromApi(db, node);
					return { content: [{ type: "text", text: JSON.stringify(node, null, 2) }] };
				} catch (err) {
					return formatApiError(err);
				}
			},
		);

		// --- 運用系ツール ---

		this.server.registerTool(
			"sync_now",
			{
				description:
					"D1 ミラーを Workflowy の現在の状態に強制的に全量同期する(fullSync)。直近60秒以内に同期を試みていた場合はスキップされる。最終同期時刻と同期件数を返す。",
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
