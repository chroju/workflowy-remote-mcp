import { stripHtml } from "./markdown";
import type { LayoutMode, WorkflowyNode } from "./workflowy-client";
import { WorkflowyClient } from "./workflowy-client";

const STALE_AFTER_SECONDS = 15 * 60;
const MIN_RETRY_INTERVAL_SECONDS = 60;
const BATCH_SIZE = 100;

async function getSyncMeta(db: D1Database, key: string): Promise<string | null> {
	const row = await db
		.prepare("SELECT value FROM sync_meta WHERE key = ?")
		.bind(key)
		.first<{ value: string }>();
	return row?.value ?? null;
}

async function setSyncMeta(db: D1Database, key: string, value: string): Promise<void> {
	await db
		.prepare(
			"INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.bind(key, value)
		.run();
}

export interface SyncResult {
	synced: boolean;
	skippedReason?: "too_recent" | "attempted_too_recently";
	nodeCount?: number;
	lastSyncedAt: number | null;
	error?: string;
}

/**
 * Full refresh: fetches all nodes from Workflowy's export endpoint (rate
 * limited to 1 req/min upstream) and replaces the D1 mirror wholesale.
 */
export async function fullSync(db: D1Database, apiKey: string): Promise<SyncResult> {
	const nowSeconds = Math.floor(Date.now() / 1000);

	const lastAttempt = await getSyncMeta(db, "last_sync_attempt_at");
	if (lastAttempt && nowSeconds - Number(lastAttempt) < MIN_RETRY_INTERVAL_SECONDS) {
		return {
			synced: false,
			skippedReason: "attempted_too_recently",
			lastSyncedAt: await getLastSyncedAt(db),
		};
	}

	await setSyncMeta(db, "last_sync_attempt_at", String(nowSeconds));

	const client = new WorkflowyClient(apiKey);

	let nodes: WorkflowyNode[];
	try {
		nodes = await client.exportAllNodes();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await setSyncMeta(db, "last_sync_status", `error: ${message}`);
		return { synced: false, lastSyncedAt: await getLastSyncedAt(db), error: message };
	}

	await db.batch([db.prepare("DELETE FROM nodes"), db.prepare("DELETE FROM nodes_fts")]);

	const statements: D1PreparedStatement[] = [];
	const insertNode = db.prepare(
		"INSERT INTO nodes (id, parent_id, name, note, priority, layout_mode, created_at, modified_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const insertFts = db.prepare("INSERT INTO nodes_fts (id, name, note) VALUES (?, ?, ?)");

	for (const node of nodes) {
		const layoutMode: LayoutMode = node.data?.layoutMode ?? "bullets";
		statements.push(
			insertNode.bind(
				node.id,
				node.parent_id,
				node.name ?? "",
				node.note ?? null,
				node.priority ?? 0,
				layoutMode,
				node.createdAt ?? null,
				node.modifiedAt ?? null,
				node.completedAt ?? null,
			),
		);
		statements.push(
			insertFts.bind(node.id, stripHtml(node.name), stripHtml(node.note)),
		);
	}

	for (let i = 0; i < statements.length; i += BATCH_SIZE) {
		await db.batch(statements.slice(i, i + BATCH_SIZE));
	}

	const syncedAt = Math.floor(Date.now() / 1000);
	await setSyncMeta(db, "last_synced_at", String(syncedAt));
	await setSyncMeta(db, "last_sync_status", "ok");

	return { synced: true, nodeCount: nodes.length, lastSyncedAt: syncedAt };
}

async function getLastSyncedAt(db: D1Database): Promise<number | null> {
	const value = await getSyncMeta(db, "last_synced_at");
	return value ? Number(value) : null;
}

/**
 * Hook called before read tools run: triggers an inline fullSync if the
 * mirror is stale (>15min old), respecting the 60s retry debounce.
 */
export async function ensureFresh(db: D1Database, apiKey: string): Promise<SyncResult> {
	const lastSyncedAt = await getLastSyncedAt(db);
	const nowSeconds = Math.floor(Date.now() / 1000);

	if (lastSyncedAt !== null && nowSeconds - lastSyncedAt < STALE_AFTER_SECONDS) {
		return { synced: false, skippedReason: "too_recent", lastSyncedAt };
	}

	return fullSync(db, apiKey);
}
