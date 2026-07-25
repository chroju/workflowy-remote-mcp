import type { RenderableNode } from "./markdown";
import { renderSubtreeMarkdown } from "./markdown";
import type { NodeFetcher, ResolvedNode } from "./node-id";
import { ROOT_SENTINEL, resolveNodeId } from "./node-id";
import type { NodeRow } from "./queries";
import { apiNodeToRow, getAncestorPath, getChildren, getNodeById, toRenderableNode } from "./queries";
import type { WorkflowyNode } from "./workflowy-client";

/**
 * Tool bodies, kept out of index.ts so they can be exercised directly against
 * a D1 binding and a stub client instead of through a live McpAgent.
 */

export interface NodeReader extends NodeFetcher {
	listChildren(parentId: string): Promise<WorkflowyNode[]>;
}

const UNSYNCED_NOTICE =
	"_(このノードはミラー未同期のため、直下の1階層のみを公式APIから取得して表示しています。深い階層まで読むには sync_now を実行してください)_";

/**
 * The node a subtree render starts from. Prefer the mirror row (it carries
 * layout_mode and completion state), fall back to the node the resolver
 * already fetched, and synthesise a placeholder for the root sentinel, which
 * has no node of its own but whose children are addressable by parent_id.
 */
function subtreeRoot(resolved: ResolvedNode, mirroredRow: NodeRow | null): RenderableNode {
	if (mirroredRow) return toRenderableNode(mirroredRow);
	if (resolved.node) return toRenderableNode(apiNodeToRow(resolved.node));
	return {
		id: ROOT_SENTINEL,
		parent_id: null,
		name: "(トップレベル)",
		note: null,
		priority: 0,
		layout_mode: "bullets",
		completed_at: null,
	};
}

export async function getSubtree(
	db: D1Database,
	client: NodeReader,
	nodeId: string,
	maxDepth: number,
): Promise<string> {
	const resolved = await resolveNodeId(db, client, nodeId);
	const mirroredRow = await getNodeById(db, resolved.id);
	const root = subtreeRoot(resolved, mirroredRow);

	// A node the API knows but the mirror does not was created after the last
	// sync; recursing the mirror would silently return an empty subtree. Fall
	// back to one level from the API and say so. The root sentinel has no row
	// of its own, but its children are in the mirror as usual.
	if (resolved.kind !== "root" && !mirroredRow) {
		const children = await client.listChildren(resolved.id);
		const { markdown } = await renderSubtreeMarkdown(
			root,
			async () => children.map((child) => toRenderableNode(apiNodeToRow(child))),
			{ maxDepth: 1, includeCompleted: true },
		);
		return `${markdown}\n\n${UNSYNCED_NOTICE}`;
	}

	const { markdown } = await renderSubtreeMarkdown(
		root,
		async (parentId) => (await getChildren(db, parentId)).map(toRenderableNode),
		{ maxDepth, includeCompleted: true },
	);
	return markdown;
}

export interface GetNodeResult {
	node: NodeRow | WorkflowyNode | null;
	ancestor_path: string;
	children: WorkflowyNode[];
}

export async function getNode(
	db: D1Database,
	client: NodeReader,
	nodeId: string,
): Promise<GetNodeResult> {
	const resolved = await resolveNodeId(db, client, nodeId);

	// The root sentinel has no node of its own; only its children are meaningful.
	const node =
		resolved.kind === "root" ? null : (resolved.node ?? (await getNodeById(db, resolved.id)));
	const children = await client.listChildren(resolved.id);
	const ancestorPath = resolved.kind === "root" ? "" : await getAncestorPath(db, resolved.id);

	return { node, ancestor_path: ancestorPath, children };
}
