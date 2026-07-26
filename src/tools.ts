import type { RenderableNode } from "./markdown";
import { renderSubtreeMarkdown } from "./markdown";
import type { NodeFetcher, ResolvedNode } from "./node-id";
import {
	NodeIdentifierError,
	ROOT_SENTINEL,
	needsResolutionForPath,
	normalizeForApi,
	resolveNodeId,
} from "./node-id";
import type { NodeRow } from "./queries";
import { apiNodeToRow, getChildren, getNodeById, toRenderableNode } from "./queries";
import { getLastSyncedAt } from "./sync";
import type { WorkflowyNode } from "./workflowy-client";

/**
 * Tool bodies, kept out of index.ts so they can be exercised directly against
 * a D1 binding and a stub client instead of through a live McpAgent.
 *
 * Reads go to the official API by default. The mirror is only consulted for
 * the two things the API cannot answer: full-text search (no search endpoint)
 * and multi-level subtree walks (List returns one level at a time).
 */

export interface NodeReader extends NodeFetcher {
	listChildren(parentId: string): Promise<WorkflowyNode[]>;
}

const UNSYNCED_NOTICE =
	"_(This node is not in the mirror yet, so only its immediate children were fetched from the official API. Run sync_now to read deeper levels.)_";

function formatSyncedAt(lastSyncedAt: number | null): string {
	if (lastSyncedAt === null) {
		return "_(Mirror last synced: never)_";
	}
	return `_(Mirror last synced: ${new Date(lastSyncedAt * 1000).toISOString()})_`;
}

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
		name: "(top level)",
		note: null,
		priority: 0,
		layout_mode: "bullets",
		completed_at: null,
	};
}

/**
 * Renders one level straight from the List API, with no mirror query at all.
 * Used for max_depth=1, where the API alone is authoritative and fresher.
 */
async function renderSingleLevel(
	client: NodeReader,
	resolved: ResolvedNode,
	root: RenderableNode,
): Promise<string> {
	const children = await client.listChildren(resolved.id);
	const { markdown } = await renderSubtreeMarkdown(
		root,
		async () => children.map((child) => toRenderableNode(apiNodeToRow(child))),
		{ maxDepth: 1, includeCompleted: true },
	);
	return markdown;
}

export async function getSubtree(
	db: D1Database,
	client: NodeReader,
	nodeId: string,
	maxDepth: number,
): Promise<string> {
	// max_depth=1 is answered entirely by the API, so the mirror shortcut would
	// only add a D1 query it never uses. Deeper walks read the mirror anyway.
	const useMirrorShortcut = maxDepth > 1;
	const resolved = await resolveNodeId(db, client, nodeId, { useMirrorShortcut });

	// A single level needs no recursion, so the List API answers it outright.
	// This keeps the common shallow read off D1 entirely and always fresh.
	if (maxDepth <= 1) {
		return renderSingleLevel(client, resolved, subtreeRoot(resolved, null));
	}

	const mirroredRow = await getNodeById(db, resolved.id);
	const root = subtreeRoot(resolved, mirroredRow);

	// A node the API knows but the mirror does not was created after the last
	// sync; recursing the mirror would silently return an empty subtree. Fall
	// back to one level from the API and say so. The root sentinel has no row
	// of its own, but its children are in the mirror as usual.
	if (resolved.kind !== "root" && !mirroredRow) {
		const markdown = await renderSingleLevel(client, resolved, root);
		return `${markdown}\n\n${UNSYNCED_NOTICE}`;
	}

	const { markdown } = await renderSubtreeMarkdown(
		root,
		async (parentId) => (await getChildren(db, parentId)).map(toRenderableNode),
		{ maxDepth, includeCompleted: true },
	);

	// Deep walks come from the mirror, which lags the outline by up to an hour.
	// get_node and max_depth=1 are always current, so state the freshness here
	// to keep that asymmetry visible to the caller.
	return `${markdown}\n\n${formatSyncedAt(await getLastSyncedAt(db))}`;
}

/**
 * Resolves an identifier that will be spliced into a single-node API path
 * (`/nodes/:id` and its /move, /complete, /uncomplete variants).
 *
 * Shortcut keys and "None" are only valid as a `parent_id`, never as that path
 * segment, so they are turned into a real UUID via one Retrieve-equivalent
 * lookup first. Everything the path already accepts -- UUID, short id,
 * calendar target -- is passed through untouched, costing no extra call.
 */
export async function resolveForWrite(
	db: D1Database,
	client: NodeFetcher,
	nodeId: string,
): Promise<string> {
	// Throws NodeIdentifierError on structurally impossible input.
	const normalized = normalizeForApi(nodeId);

	if (!needsResolutionForPath(normalized)) {
		return normalized;
	}
	// The outline root is not a node, so it can never be the target of a write.
	if (normalized === ROOT_SENTINEL) {
		throw new NodeIdentifierError(nodeId.trim());
	}
	// A shortcut key: only the API knows what it points at.
	const resolved = await resolveNodeId(db, client, normalized);
	return resolved.id;
}

export interface GetNodeResult {
	node: NodeRow | null;
	children: NodeRow[];
}

/**
 * Single node plus its direct children, both straight from the official API.
 *
 * Everything is normalised to the mirror's row shape (snake_case, flat
 * layout_mode) so that get_node, get_subtree and search_nodes all describe a
 * node the same way regardless of which source answered.
 */
export async function getNode(
	db: D1Database,
	client: NodeReader,
	nodeId: string,
): Promise<GetNodeResult> {
	// No mirror shortcut: the resolver's API fetch is the node body we return,
	// so this issues no D1 query at all.
	const resolved = await resolveNodeId(db, client, nodeId);

	// The root sentinel has no node of its own; only its children are meaningful.
	const node = resolved.node ? apiNodeToRow(resolved.node) : null;
	const children = (await client.listChildren(resolved.id)).map(apiNodeToRow);

	return { node, children };
}
