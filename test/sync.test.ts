import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { fullSync } from "../src/sync";
import type { WorkflowyNode } from "../src/workflowy-client";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

function node(id: string, overrides: Partial<WorkflowyNode> = {}): WorkflowyNode {
	return {
		id,
		parent_id: null,
		name: `node ${id.slice(0, 4)}`,
		note: null,
		priority: 0,
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		...overrides,
	};
}

/** A node source that records how many times it was asked for the export. */
function source(nodes: WorkflowyNode[]) {
	const calls: number[] = [];
	return {
		calls,
		fetch: async () => {
			calls.push(1);
			return nodes;
		},
	};
}

async function ids(): Promise<string[]> {
	const { results } = await env.DB.prepare("SELECT id FROM nodes ORDER BY id").all<{
		id: string;
	}>();
	return results.map((r) => r.id);
}

async function ftsIds(): Promise<string[]> {
	const { results } = await env.DB.prepare("SELECT id FROM nodes_fts ORDER BY id").all<{
		id: string;
	}>();
	return results.map((r) => r.id);
}

beforeEach(async () => {
	await env.DB.exec("DROP TABLE IF EXISTS nodes");
	await env.DB.exec("DROP TABLE IF EXISTS nodes_fts");
	await env.DB.exec("DROP TABLE IF EXISTS sync_meta");
	await env.DB.exec(
		"CREATE TABLE nodes (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL DEFAULT '', note TEXT, priority INTEGER NOT NULL DEFAULT 0, layout_mode TEXT NOT NULL DEFAULT 'bullets', created_at INTEGER, modified_at INTEGER, completed_at INTEGER)",
	);
	await env.DB.exec(
		"CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, name, note, tokenize='trigram')",
	);
	await env.DB.exec("CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT)");
});

describe("fullSync", () => {
	it("populates an empty mirror", async () => {
		const { fetch } = source([node(A), node(B)]);

		const result = await fullSync(env.DB, "key", fetch);

		expect(result.synced).toBe(true);
		expect(result.nodeCount).toBe(2);
		expect(await ids()).toEqual([A, B]);
		expect(await ftsIds()).toEqual([A, B]);
	});

	it("is idempotent: a second sync over the same data does not collide", async () => {
		// The bug this guards: re-inserting an existing id used to fail the whole
		// batch with SQLITE_CONSTRAINT_PRIMARYKEY.
		const { fetch } = source([node(A), node(B)]);
		await fullSync(env.DB, "key", fetch);
		await env.DB.prepare("DELETE FROM sync_meta WHERE key = 'last_sync_attempt_at'").run();

		const result = await fullSync(env.DB, "key", fetch);

		expect(result.synced).toBe(true);
		expect(await ids()).toEqual([A, B]);
		// No duplicate fts rows either: fts5 has no unique constraint to catch them.
		expect(await ftsIds()).toEqual([A, B]);
	});

	it("updates changed rows in place", async () => {
		await fullSync(env.DB, "key", source([node(A, { name: "before" })]).fetch);
		await env.DB.prepare("DELETE FROM sync_meta WHERE key = 'last_sync_attempt_at'").run();

		await fullSync(env.DB, "key", source([node(A, { name: "after" })]).fetch);

		const row = await env.DB.prepare("SELECT name FROM nodes WHERE id = ?")
			.bind(A)
			.first<{ name: string }>();
		expect(row?.name).toBe("after");
	});

	it("drops vanished ids from the search index too", async () => {
		// nodes_fts is rebuilt from the export rather than pruned per id, so a
		// vanished node must not survive in the index and keep matching searches.
		await fullSync(env.DB, "key", source([node(A), node(B)]).fetch);
		await env.DB.prepare("DELETE FROM sync_meta WHERE key = 'last_sync_attempt_at'").run();

		await fullSync(env.DB, "key", source([node(A)]).fetch);

		expect(await ftsIds()).toEqual([A]);
	});

	it("rebuilds the index without per-id deletes", async () => {
		// The per-id DELETE this replaced is a full table scan on contentless
		// fts5 (id is UNINDEXED), which dominated sync time at ~25k nodes.
		await fullSync(env.DB, "key", source([node(A), node(B)]).fetch);
		await env.DB.prepare("DELETE FROM sync_meta WHERE key = 'last_sync_attempt_at'").run();

		const seen: string[] = [];
		const spy = new Proxy(env.DB, {
			get(target, prop, receiver) {
				if (prop === "prepare") {
					return (sql: string) => {
						seen.push(sql);
						return (target as D1Database).prepare(sql);
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as D1Database;

		await fullSync(spy, "key", source([node(A), node(B)]).fetch);

		expect(seen).toContain("DELETE FROM nodes_fts");
		expect(seen).not.toContain("DELETE FROM nodes_fts WHERE id = ?");
	});

	it("removes rows that vanished upstream", async () => {
		await fullSync(env.DB, "key", source([node(A), node(B), node(C)]).fetch);
		await env.DB.prepare("DELETE FROM sync_meta WHERE key = 'last_sync_attempt_at'").run();

		const result = await fullSync(env.DB, "key", source([node(A), node(C)]).fetch);

		expect(result.removedCount).toBe(1);
		expect(await ids()).toEqual([A, C]);
		expect(await ftsIds()).toEqual([A, C]);
	});

	it("never empties the mirror while refilling it", async () => {
		// Enough nodes that the write phase spans several batch round-trips, so
		// a concurrent reader has real opportunities to observe an interim state.
		const many = Array.from({ length: 250 }, (_, i) =>
			node(`${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`),
		);
		await fullSync(env.DB, "key", source(many).fetch);
		await env.DB.prepare("DELETE FROM sync_meta WHERE key = 'last_sync_attempt_at'").run();

		// Read the mirror repeatedly while the sync writes. A wipe-then-refill
		// leaves it empty or partial for the whole write phase; reconciling in
		// place must keep every row continuously visible.
		let syncing = true;
		const counts: number[] = [];
		const reader = (async () => {
			while (syncing) {
				const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM nodes").first<{
					n: number;
				}>();
				counts.push(row?.n ?? 0);
			}
		})();

		await fullSync(env.DB, "key", source(many).fetch);
		syncing = false;
		await reader;

		expect(counts.length).toBeGreaterThan(0);
		expect(Math.min(...counts)).toBe(many.length);
	});

	it("skips when another sync holds the lock", async () => {
		const nowSeconds = Math.floor(Date.now() / 1000);
		await env.DB.prepare("INSERT INTO sync_meta (key, value) VALUES ('sync_lock_until', ?)")
			.bind(String(nowSeconds + 600))
			.run();
		const { fetch, calls } = source([node(A)]);

		const result = await fullSync(env.DB, "key", fetch);

		expect(result.synced).toBe(false);
		expect(result.skippedReason).toBe("already_running");
		// The export endpoint is rate limited to 1 req/min; a skipped sync must
		// not spend that budget.
		expect(calls).toEqual([]);
	});

	it("takes over a lock whose lease has expired", async () => {
		const nowSeconds = Math.floor(Date.now() / 1000);
		await env.DB.prepare("INSERT INTO sync_meta (key, value) VALUES ('sync_lock_until', ?)")
			.bind(String(nowSeconds - 1))
			.run();

		const result = await fullSync(env.DB, "key", source([node(A)]).fetch);

		expect(result.synced).toBe(true);
	});

	it("releases the lock after a failed export", async () => {
		const failing = async () => {
			throw new Error("boom");
		};

		const failed = await fullSync(env.DB, "key", failing);
		expect(failed.error).toBe("boom");

		// A crashed sync must not wedge every later one.
		await env.DB.prepare("DELETE FROM sync_meta WHERE key = 'last_sync_attempt_at'").run();
		const result = await fullSync(env.DB, "key", source([node(A)]).fetch);
		expect(result.synced).toBe(true);
	});

	it("releases the lock after a successful sync", async () => {
		await fullSync(env.DB, "key", source([node(A)]).fetch);
		await env.DB.prepare("DELETE FROM sync_meta WHERE key = 'last_sync_attempt_at'").run();

		const result = await fullSync(env.DB, "key", source([node(A)]).fetch);

		expect(result.synced).toBe(true);
	});

	it("debounces repeated attempts before the lock is even considered", async () => {
		await fullSync(env.DB, "key", source([node(A)]).fetch);
		const { fetch, calls } = source([node(B)]);

		const result = await fullSync(env.DB, "key", fetch);

		expect(result.skippedReason).toBe("attempted_too_recently");
		expect(calls).toEqual([]);
	});
});
