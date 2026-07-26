import { env } from "cloudflare:test";
import { beforeEach, describe, it } from "vitest";
import { fullSync } from "../src/sync";
import type { WorkflowyNode } from "../src/workflowy-client";

/**
 * End-to-end timing of fullSync itself, at production scale. Excluded from
 * `npm test`; run explicitly:
 *   npx vitest run test/fullsync-bench.test.ts --disable-console-intercept
 */

const NODE_COUNT = 24_800;

function nodes(count: number, offset = 0): WorkflowyNode[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `${String(i + offset).padStart(8, "0")}-1111-4111-8111-111111111111`,
		parent_id: null,
		name: `Node ${i} <b>bold</b> some searchable text`,
		note: i % 3 === 0 ? `note body for ${i} with a bit more text to index` : null,
		priority: i,
		createdAt: 1700000000,
		modifiedAt: 1700000001,
		completedAt: null,
	}));
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

describe("fullSync end to end", () => {
	it("times a cold sync and a warm resync", async () => {
		const all = nodes(NODE_COUNT);

		const cold = performance.now();
		const first = await fullSync(env.DB, "key", async () => all);
		const coldMs = performance.now() - cold;

		await env.DB.prepare("DELETE FROM sync_meta WHERE key = 'last_sync_attempt_at'").run();

		// Resync over the same data: every row takes the ON CONFLICT path.
		const warm = performance.now();
		const second = await fullSync(env.DB, "key", async () => all);
		const warmMs = performance.now() - warm;

		await env.DB.prepare("DELETE FROM sync_meta WHERE key = 'last_sync_attempt_at'").run();

		// A sync where 200 nodes vanished upstream, exercising the delete path.
		const shrunk = all.slice(0, NODE_COUNT - 200);
		const shrinkStart = performance.now();
		const third = await fullSync(env.DB, "key", async () => shrunk);
		const shrinkMs = performance.now() - shrinkStart;

		console.log(
			`cold=${coldMs.toFixed(0)}ms (${first.nodeCount} nodes)  ` +
				`warm=${warmMs.toFixed(0)}ms (${second.nodeCount})  ` +
				`with-deletes=${shrinkMs.toFixed(0)}ms (removed ${third.removedCount})`,
		);
	}, 900_000);
});
