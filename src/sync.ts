import { stripHtml } from "./markdown";
import type { LayoutMode, WorkflowyNode } from "./workflowy-client";
import { WorkflowyClient } from "./workflowy-client";

const MIN_RETRY_INTERVAL_SECONDS = 60;
/**
 * Statements per `db.batch()` round-trip.
 *
 * D1 caps bound parameters per *statement* (100; the widest here binds 9) and
 * caps *duration* per batch call at 30s -- it sets no ceiling on statement
 * count. Round-trip latency dominates a full sync, so this is sized to cut
 * those trips while leaving ample headroom under the 30s cap.
 */
const BATCH_SIZE = 500;

/**
 * How long a sync may hold the lock before another attempt may steal it.
 *
 * A full sync of a large outline takes minutes (export fetch plus a few
 * hundred batch round-trips), so this must comfortably exceed that, or two
 * syncs overlap again -- the exact failure this lock exists to prevent. It
 * only needs to be short enough that a worker killed mid-sync does not wedge
 * syncing for long.
 */
const LOCK_TTL_SECONDS = 15 * 60;
const LOCK_KEY = "sync_lock_until";

/** Where the mirror's contents come from. Injectable so tests can skip HTTP. */
export type NodeSource = (apiKey: string) => Promise<WorkflowyNode[]>;

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

/**
 * Claims the sync lock, or reports that another sync holds it.
 *
 * Both statements are single writes evaluated server-side, so the read of the
 * current holder and the claim cannot interleave the way a SELECT-then-INSERT
 * pair can. The INSERT takes the lock when no row exists yet; the UPDATE takes
 * it over only once the previous holder's lease has expired. `meta.changes`
 * tells us which, if either, actually wrote.
 */
async function acquireSyncLock(db: D1Database, nowSeconds: number): Promise<boolean> {
	const expiresAt = nowSeconds + LOCK_TTL_SECONDS;

	const inserted = await db
		.prepare("INSERT OR IGNORE INTO sync_meta (key, value) VALUES (?, ?)")
		.bind(LOCK_KEY, String(expiresAt))
		.run();
	if (inserted.meta.changes > 0) return true;

	const stolen = await db
		.prepare("UPDATE sync_meta SET value = ? WHERE key = ? AND CAST(value AS INTEGER) <= ?")
		.bind(String(expiresAt), LOCK_KEY, nowSeconds)
		.run();
	return stolen.meta.changes > 0;
}

async function releaseSyncLock(db: D1Database): Promise<void> {
	// Expire the lease rather than deleting the row, so the next acquire takes
	// the UPDATE path and the lock never depends on a row's absence.
	await db.prepare("UPDATE sync_meta SET value = '0' WHERE key = ?").bind(LOCK_KEY).run();
}

export interface SyncResult {
	synced: boolean;
	skippedReason?: "attempted_too_recently" | "already_running";
	nodeCount?: number;
	removedCount?: number;
	lastSyncedAt: number | null;
	error?: string;
}

/**
 * Full refresh: fetches all nodes from Workflowy's export endpoint (rate
 * limited to 1 req/min upstream) and reconciles the D1 mirror against it.
 *
 * Only one sync may run at a time. The debounce below cannot enforce that on
 * its own: a full sync of a large outline takes longer than the debounce
 * window, so a second caller arriving mid-sync would sail past it.
 */
export async function fullSync(
	db: D1Database,
	apiKey: string,
	fetchNodes: NodeSource = (key) => new WorkflowyClient(key).exportAllNodes(),
): Promise<SyncResult> {
	const nowSeconds = Math.floor(Date.now() / 1000);

	const lastAttempt = await getSyncMeta(db, "last_sync_attempt_at");
	if (lastAttempt && nowSeconds - Number(lastAttempt) < MIN_RETRY_INTERVAL_SECONDS) {
		return {
			synced: false,
			skippedReason: "attempted_too_recently",
			lastSyncedAt: await getLastSyncedAt(db),
		};
	}

	if (!(await acquireSyncLock(db, nowSeconds))) {
		return {
			synced: false,
			skippedReason: "already_running",
			lastSyncedAt: await getLastSyncedAt(db),
		};
	}

	try {
		return await runFullSync(db, apiKey, nowSeconds, fetchNodes);
	} finally {
		await releaseSyncLock(db);
	}
}

async function runFullSync(
	db: D1Database,
	apiKey: string,
	nowSeconds: number,
	fetchNodes: NodeSource,
): Promise<SyncResult> {
	await setSyncMeta(db, "last_sync_attempt_at", String(nowSeconds));

	let nodes: WorkflowyNode[];
	try {
		nodes = await fetchNodes(apiKey);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await setSyncMeta(db, "last_sync_status", `error: ${message}`);
		return { synced: false, lastSyncedAt: await getLastSyncedAt(db), error: message };
	}

	// Deliberately no "DELETE FROM nodes" first. The wipe and the inserts that
	// follow are separate, non-atomic D1 calls, so a wipe-then-refill leaves
	// the mirror empty or half-filled for the whole duration -- minutes, for a
	// large outline -- and every read landing in that window sees a truncated
	// outline or no outline at all. Upserting each row in place keeps the
	// mirror continuously readable; rows that vanished upstream are removed at
	// the end, once the new contents are already in.
	const statements: D1PreparedStatement[] = [];
	const upsertNode = db.prepare(
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
	);
	// nodes_fts is a contentless fts5 table with no unique constraint, so an
	// upsert is not available: delete the id before reinserting it.
	const deleteFts = db.prepare("DELETE FROM nodes_fts WHERE id = ?");
	const insertFts = db.prepare("INSERT INTO nodes_fts (id, name, note) VALUES (?, ?, ?)");

	for (const node of nodes) {
		const layoutMode: LayoutMode = node.data?.layoutMode ?? "bullets";
		statements.push(
			upsertNode.bind(
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
		statements.push(deleteFts.bind(node.id));
		statements.push(
			insertFts.bind(node.id, stripHtml(node.name), stripHtml(node.note)),
		);
	}

	for (let i = 0; i < statements.length; i += BATCH_SIZE) {
		await db.batch(statements.slice(i, i + BATCH_SIZE));
	}

	const removedCount = await removeVanishedNodes(db, nodes);

	const syncedAt = Math.floor(Date.now() / 1000);
	await setSyncMeta(db, "last_synced_at", String(syncedAt));
	await setSyncMeta(db, "last_sync_status", "ok");

	return { synced: true, nodeCount: nodes.length, removedCount, lastSyncedAt: syncedAt };
}

/**
 * Drops mirror rows for nodes the export no longer contains -- deleted or
 * moved out of reach since the last sync.
 *
 * Runs only after every upsert has landed, so a node is never absent from the
 * mirror at a moment when it still exists upstream. The id set is compared in
 * memory because D1 has no temp tables and a bound IN-list of ~25k ids would
 * blow past the statement's variable limit.
 */
async function removeVanishedNodes(db: D1Database, nodes: WorkflowyNode[]): Promise<number> {
	const live = new Set(nodes.map((node) => node.id));
	const { results } = await db.prepare("SELECT id FROM nodes").all<{ id: string }>();
	const stale = results.map((row) => row.id).filter((id) => !live.has(id));
	if (stale.length === 0) return 0;

	const deleteNode = db.prepare("DELETE FROM nodes WHERE id = ?");
	const deleteFts = db.prepare("DELETE FROM nodes_fts WHERE id = ?");
	const statements = stale.flatMap((id) => [deleteNode.bind(id), deleteFts.bind(id)]);

	for (let i = 0; i < statements.length; i += BATCH_SIZE) {
		await db.batch(statements.slice(i, i + BATCH_SIZE));
	}
	return stale.length;
}

export async function getLastSyncedAt(db: D1Database): Promise<number | null> {
	const value = await getSyncMeta(db, "last_synced_at");
	return value ? Number(value) : null;
}

/*
 * There is deliberately no ensureFresh() here.
 *
 * Read tools used to sync inline when the mirror looked stale. On a large
 * outline that sync takes minutes -- longer than an MCP client will wait -- so
 * the read timed out while the sync completed unseen. Moving it to waitUntil
 * would fix the timeout but leaves reads quietly spending the 1req/min export
 * budget and refreshing at moments the caller cannot predict.
 *
 * The mirror is refreshed on a schedule (cron) and on demand (sync_now).
 * Reads answer from whatever the mirror currently holds; get_subtree states
 * its last sync time, so a caller who needs certainty can run sync_now first.
 */
