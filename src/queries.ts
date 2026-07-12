import type { RenderableNode } from "./markdown";

export interface NodeRow {
	id: string;
	parent_id: string | null;
	name: string;
	note: string | null;
	priority: number;
	layout_mode: string;
	created_at: number | null;
	modified_at: number | null;
	completed_at: number | null;
}

export interface SearchHit {
	id: string;
	name: string;
	note_excerpt: string;
	ancestor_path: string;
	modified_at: number | null;
}

/**
 * Single choke point for all read queries against the D1 mirror. Keeping
 * every read-side tool routed through this module makes it straightforward
 * to layer a privacy filter (e.g. excluded subtrees) in later without
 * touching each tool individually.
 */

export async function getNodeById(db: D1Database, nodeId: string): Promise<NodeRow | null> {
	const row = await db
		.prepare("SELECT * FROM nodes WHERE id = ?")
		.bind(nodeId)
		.first<NodeRow>();
	return row ?? null;
}

export async function getChildren(db: D1Database, parentId: string): Promise<NodeRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM nodes WHERE parent_id = ? ORDER BY priority ASC")
		.bind(parentId)
		.all<NodeRow>();
	return results;
}

export async function getAncestorPath(db: D1Database, nodeId: string): Promise<string> {
	const names: string[] = [];
	let currentId: string | null = nodeId;
	let guard = 0;

	while (currentId && guard < 100) {
		guard++;
		const node: NodeRow | null = await getNodeById(db, currentId);
		if (!node) break;
		names.unshift(node.name);
		currentId = node.parent_id;
	}

	return names.join(" > ");
}

function ftsQueryLiteral(query: string): string {
	// fts5 trigram tokenizer treats the query as a raw substring match;
	// escape double quotes to keep it a valid fts5 string literal.
	return `"${query.replace(/"/g, '""')}"`;
}

export async function searchNodes(
	db: D1Database,
	query: string,
	options: { limit?: number; includeCompleted?: boolean } = {},
): Promise<SearchHit[]> {
	const limit = options.limit ?? 20;
	const includeCompleted = options.includeCompleted ?? false;

	const completedClause = includeCompleted ? "" : "AND n.completed_at IS NULL";

	// The trigram tokenizer cannot match queries shorter than 3 code points
	// (e.g. "パン"), so fall back to a LIKE scan over the plain-text FTS
	// shadow columns for short queries.
	const useLike = [...query].length < 3;
	const stmt = useLike
		? db
				.prepare(
					`SELECT n.id AS id, n.name AS name, n.note AS note, n.modified_at AS modified_at
					 FROM nodes_fts f
					 JOIN nodes n ON n.id = f.id
					 WHERE (f.name LIKE ? OR f.note LIKE ?) ${completedClause}
					 ORDER BY n.modified_at DESC
					 LIMIT ?`,
				)
				.bind(`%${query}%`, `%${query}%`, limit)
		: db
				.prepare(
					`SELECT n.id AS id, n.name AS name, n.note AS note, n.modified_at AS modified_at
					 FROM nodes_fts f
					 JOIN nodes n ON n.id = f.id
					 WHERE nodes_fts MATCH ? ${completedClause}
					 ORDER BY n.modified_at DESC
					 LIMIT ?`,
				)
				.bind(ftsQueryLiteral(query), limit);

	const { results } = await stmt.all<{
		id: string;
		name: string;
		note: string | null;
		modified_at: number | null;
	}>();

	const hits: SearchHit[] = [];
	for (const row of results) {
		const ancestorPath = await getAncestorPath(db, row.id);
		hits.push({
			id: row.id,
			name: row.name,
			note_excerpt: (row.note ?? "").slice(0, 200),
			ancestor_path: ancestorPath,
			modified_at: row.modified_at,
		});
	}
	return hits;
}

export function toRenderableNode(row: NodeRow): RenderableNode {
	return {
		id: row.id,
		parent_id: row.parent_id,
		name: row.name,
		note: row.note,
		priority: row.priority,
		layout_mode: row.layout_mode,
		completed_at: row.completed_at,
	};
}
