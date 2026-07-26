import { env } from "cloudflare:test";
import { beforeEach, describe, it } from "vitest";
import { stripHtml } from "../src/markdown";
import type { WorkflowyNode } from "../src/workflowy-client";

/**
 * Throughput probe, not an assertion-bearing test. Run explicitly:
 *   npx vitest run test/sync-bench.test.ts
 *
 * Local D1 (miniflare) has no network hop, so absolute numbers are far below
 * production. What transfers is the *shape*: how cost scales with batch width
 * and how much the FTS delete+insert pair adds per node.
 */

const NODE_COUNT = 24_800;

function nodes(count: number): WorkflowyNode[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
		parent_id: null,
		name: `Node ${i} <b>bold</b> some searchable text`,
		note: i % 3 === 0 ? `note body for ${i} with a bit more text to index` : null,
		priority: i,
		createdAt: 1700000000,
		modifiedAt: 1700000001,
		completedAt: null,
	}));
}

async function resetTables() {
	await env.DB.exec("DROP TABLE IF EXISTS nodes");
	await env.DB.exec("DROP TABLE IF EXISTS nodes_fts");
	await env.DB.exec(
		"CREATE TABLE nodes (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL DEFAULT '', note TEXT, priority INTEGER NOT NULL DEFAULT 0, layout_mode TEXT NOT NULL DEFAULT 'bullets', created_at INTEGER, modified_at INTEGER, completed_at INTEGER)",
	);
	await env.DB.exec(
		"CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, name, note, tokenize='trigram')",
	);
}

function buildStatements(all: WorkflowyNode[], withFts: boolean): D1PreparedStatement[] {
	const upsertNode = env.DB.prepare(
		`INSERT INTO nodes (id, parent_id, name, note, priority, layout_mode, created_at, modified_at, completed_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   parent_id = excluded.parent_id, name = excluded.name, note = excluded.note,
		   priority = excluded.priority, layout_mode = excluded.layout_mode,
		   created_at = excluded.created_at, modified_at = excluded.modified_at,
		   completed_at = excluded.completed_at`,
	);
	const deleteFts = env.DB.prepare("DELETE FROM nodes_fts WHERE id = ?");
	const insertFts = env.DB.prepare("INSERT INTO nodes_fts (id, name, note) VALUES (?, ?, ?)");

	const out: D1PreparedStatement[] = [];
	for (const n of all) {
		out.push(
			upsertNode.bind(
				n.id,
				n.parent_id,
				n.name ?? "",
				n.note ?? null,
				n.priority ?? 0,
				"bullets",
				n.createdAt ?? null,
				n.modifiedAt ?? null,
				n.completedAt ?? null,
			),
		);
		if (withFts) {
			out.push(deleteFts.bind(n.id));
			out.push(insertFts.bind(n.id, stripHtml(n.name), stripHtml(n.note)));
		}
	}
	return out;
}

async function runBatched(statements: D1PreparedStatement[], size: number): Promise<number> {
	const start = performance.now();
	for (let i = 0; i < statements.length; i += size) {
		await env.DB.batch(statements.slice(i, i + size));
	}
	return performance.now() - start;
}

beforeEach(resetTables);

describe("sync throughput", () => {
	it("measures batch width", async () => {
		const all = nodes(NODE_COUNT);
		for (const size of [100, 500, 1000, 2000, 5000]) {
			await resetTables();
			const statements = buildStatements(all, true);
			const ms = await runBatched(statements, size);
			const trips = Math.ceil(statements.length / size);
			console.log(
				`batch=${String(size).padStart(4)}  trips=${String(trips).padStart(4)}  ${ms.toFixed(0)}ms`,
			);
		}
	}, 600_000);

	it("isolates what makes the FTS write expensive", async () => {
		const all = nodes(NODE_COUNT);

		// (a) Insert only, into an empty table: no delete, nothing to displace.
		await resetTables();
		const insertOnly = env.DB.prepare("INSERT INTO nodes_fts (id, name, note) VALUES (?, ?, ?)");
		const aStmts = all.map((n) =>
			insertOnly.bind(n.id, stripHtml(n.name), stripHtml(n.note)),
		);
		const a = await runBatched(aStmts, 1000);

		// (b) The per-id DELETE we currently pair with every insert, against the
		// table (a) just filled. nodes_fts has no index on the id column.
		const delOnly = env.DB.prepare("DELETE FROM nodes_fts WHERE id = ?");
		const b = await runBatched(all.map((n) => delOnly.bind(n.id)), 1000);

		// (c) Wiping the whole FTS table in one statement, then re-inserting.
		await resetTables();
		await runBatched(aStmts, 1000);
		const wipeStart = performance.now();
		await env.DB.exec("DELETE FROM nodes_fts");
		const c = performance.now() - wipeStart;

		console.log(
			`fts insert=${a.toFixed(0)}ms  per-id delete=${b.toFixed(0)}ms  whole-table wipe=${c.toFixed(0)}ms`,
		);
	}, 600_000);

	it("measures the FTS share of the work", async () => {
		const all = nodes(NODE_COUNT);

		await resetTables();
		const withFts = await runBatched(buildStatements(all, true), 1000);

		await resetTables();
		const withoutFts = await runBatched(buildStatements(all, false), 1000);

		console.log(
			`nodes+fts=${withFts.toFixed(0)}ms  nodes only=${withoutFts.toFixed(0)}ms  ` +
				`fts share=${(((withFts - withoutFts) / withFts) * 100).toFixed(0)}%`,
		);
	}, 600_000);
});
