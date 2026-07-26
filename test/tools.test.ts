import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { apiNodeToRow } from "../src/queries";
import { getNode, getSubtree, resolveForWrite } from "../src/tools";
import type { WorkflowyNode } from "../src/workflowy-client";
import { WorkflowyApiError } from "../src/workflowy-client";

const ROOT_UUID = "11111111-1111-4111-8111-111111111111";
const CHILD_UUID = "22222222-2222-4222-8222-222222222222";
const GRANDCHILD_UUID = "33333333-3333-4333-8333-333333333333";
const UNSYNCED_UUID = "44444444-4444-4444-8444-444444444444";
const SHORT_ID = "f06c631642eb";

function apiNode(overrides: Partial<WorkflowyNode> = {}): WorkflowyNode {
	return {
		id: ROOT_UUID,
		parent_id: null,
		name: "API node",
		note: null,
		priority: 0,
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		...overrides,
	};
}

interface StubOptions {
	nodes?: Record<string, WorkflowyNode>;
	children?: Record<string, WorkflowyNode[]>;
}

/** Stub client that records every call so tests can assert the call count. */
function stubClient(options: StubOptions = {}) {
	const getNodeCalls: string[] = [];
	const listChildrenCalls: string[] = [];
	return {
		getNodeCalls,
		listChildrenCalls,
		client: {
			async getNode(id: string) {
				getNodeCalls.push(id);
				const node = options.nodes?.[id];
				if (!node) throw new WorkflowyApiError(404, "Not Found", "", "404");
				return node;
			},
			async listChildren(parentId: string) {
				listChildrenCalls.push(parentId);
				return options.children?.[parentId] ?? [];
			},
		},
	};
}

async function insert(row: {
	id: string;
	parent_id?: string | null;
	name?: string;
	priority?: number;
	layout_mode?: string;
}) {
	await env.DB.prepare(
		"INSERT INTO nodes (id, parent_id, name, priority, layout_mode) VALUES (?, ?, ?, ?, ?)",
	)
		.bind(
			row.id,
			row.parent_id ?? null,
			row.name ?? "node",
			row.priority ?? 0,
			row.layout_mode ?? "bullets",
		)
		.run();
}

beforeEach(async () => {
	await env.DB.exec("DROP TABLE IF EXISTS nodes");
	await env.DB.exec(
		"CREATE TABLE nodes (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL DEFAULT '', note TEXT, priority INTEGER NOT NULL DEFAULT 0, layout_mode TEXT NOT NULL DEFAULT 'bullets', created_at INTEGER, modified_at INTEGER, completed_at INTEGER)",
	);
	await env.DB.exec("DROP TABLE IF EXISTS sync_meta");
	await env.DB.exec("CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT)");
});

describe("getNode", () => {
	it("resolves a short id in a single getNode call", async () => {
		const target = apiNode({ id: ROOT_UUID, name: "<time>2026-07-25</time>" });
		const { client, getNodeCalls } = stubClient({ nodes: { [SHORT_ID]: target } });

		const result = await getNode(env.DB, client, SHORT_ID);

		expect(result.node).toEqual(apiNodeToRow(target));
		expect(getNodeCalls).toEqual([SHORT_ID]);
	});

	it("resolves a Workflowy URL in a single getNode call", async () => {
		const target = apiNode();
		const { client, getNodeCalls } = stubClient({ nodes: { [SHORT_ID]: target } });

		const result = await getNode(env.DB, client, `https://workflowy.com/#/${SHORT_ID}`);

		expect(result.node).toEqual(apiNodeToRow(target));
		expect(getNodeCalls).toEqual([SHORT_ID]);
	});

	it("resolves calendar targets", async () => {
		const today = apiNode({ name: "today node" });
		const { client, getNodeCalls } = stubClient({ nodes: { today } });

		const result = await getNode(env.DB, client, "today");

		expect(result.node).toEqual(apiNodeToRow(today));
		expect(getNodeCalls).toEqual(["today"]);
	});

	it("lists children from the API, not the mirror", async () => {
		await insert({ id: ROOT_UUID, name: "stale root" });
		await insert({ id: CHILD_UUID, parent_id: ROOT_UUID, name: "stale child" });
		const fresh = apiNode({ id: CHILD_UUID, parent_id: ROOT_UUID, name: "fresh child" });
		const { client, listChildrenCalls } = stubClient({
			nodes: { [ROOT_UUID]: apiNode({ id: ROOT_UUID }) },
			children: { [ROOT_UUID]: [fresh] },
		});

		const result = await getNode(env.DB, client, ROOT_UUID);

		expect(result.children).toEqual([apiNodeToRow(fresh)]);
		expect(listChildrenCalls).toEqual([ROOT_UUID]);
	});

	it("returns snake_case mirror-shaped fields, not the API's camelCase", async () => {
		const target = apiNode({
			id: ROOT_UUID,
			createdAt: 1700000000,
			modifiedAt: 1700000001,
			data: { layoutMode: "todo" },
		});
		const { client } = stubClient({ nodes: { [SHORT_ID]: target } });

		const result = await getNode(env.DB, client, SHORT_ID);

		expect(result.node).toMatchObject({
			created_at: 1700000000,
			modified_at: 1700000001,
			layout_mode: "todo",
		});
		expect(result.node).not.toHaveProperty("createdAt");
		expect(result.node).not.toHaveProperty("data");
	});

	it("has no ancestor_path key at all", async () => {
		await insert({ id: ROOT_UUID, name: "Context" });
		await insert({ id: CHILD_UUID, parent_id: ROOT_UUID, name: "Project" });
		const { client } = stubClient({
			nodes: { [CHILD_UUID]: apiNode({ id: CHILD_UUID, parent_id: ROOT_UUID }) },
		});

		const result = await getNode(env.DB, client, CHILD_UUID);

		expect(result).not.toHaveProperty("ancestor_path");
	});

	it("issues no D1 query for a mirrored UUID", async () => {
		await insert({ id: ROOT_UUID, name: "mirrored" });
		const target = apiNode({ id: ROOT_UUID, name: "fresh from API" });
		const { client, getNodeCalls } = stubClient({ nodes: { [ROOT_UUID]: target } });

		const result = await getNode(env.DB, client, ROOT_UUID);

		// The mirror row exists but must not short-circuit the API fetch,
		// otherwise the returned node would be the stale mirrored copy.
		expect(result.node).toEqual(apiNodeToRow(target));
		expect(getNodeCalls).toEqual([ROOT_UUID]);
	});

	it("returns the top level for the root sentinel without a getNode call", async () => {
		const top = apiNode({ id: CHILD_UUID, name: "top level" });
		const { client, getNodeCalls, listChildrenCalls } = stubClient({
			children: { None: [top] },
		});

		const result = await getNode(env.DB, client, "None");

		expect(result.node).toBeNull();
		expect(result.children).toEqual([apiNodeToRow(top)]);
		expect(getNodeCalls).toEqual([]);
		expect(listChildrenCalls).toEqual(["None"]);
	});

	it("reports a missing node without leaking the mirror", async () => {
		const { client } = stubClient();

		await expect(getNode(env.DB, client, SHORT_ID)).rejects.toThrow(
			"Node does not exist or is not accessible: f06c631642eb",
		);
	});
});

describe("getSubtree", () => {
	it("resolves the starting point then recurses the mirror", async () => {
		await insert({ id: ROOT_UUID, name: "Root" });
		await insert({ id: CHILD_UUID, parent_id: ROOT_UUID, name: "Child" });
		await insert({ id: GRANDCHILD_UUID, parent_id: CHILD_UUID, name: "Grandchild" });
		const { client, getNodeCalls, listChildrenCalls } = stubClient({
			nodes: { [SHORT_ID]: apiNode({ id: ROOT_UUID }) },
		});

		const markdown = await getSubtree(env.DB, client, SHORT_ID, 3);

		expect(markdown).toContain("# Root");
		expect(markdown).toContain("- Child");
		expect(markdown).toContain("  - Grandchild");
		// One call to resolve the short id; the walk itself stays in the mirror.
		expect(getNodeCalls).toEqual([SHORT_ID]);
		expect(listChildrenCalls).toEqual([]);
	});

	it("recurses the mirror with no API call for a mirrored UUID", async () => {
		await insert({ id: ROOT_UUID, name: "Root" });
		await insert({ id: CHILD_UUID, parent_id: ROOT_UUID, name: "Child" });
		const { client, getNodeCalls } = stubClient();

		const markdown = await getSubtree(env.DB, client, ROOT_UUID, 3);

		expect(markdown).toContain("- Child");
		expect(getNodeCalls).toEqual([]);
	});

	it("renders the top level for the root sentinel", async () => {
		await insert({ id: ROOT_UUID, name: "Top A", priority: 0 });
		await insert({ id: CHILD_UUID, name: "Top B", priority: 1 });
		await insert({ id: GRANDCHILD_UUID, parent_id: ROOT_UUID, name: "Nested" });
		const { client, getNodeCalls } = stubClient();

		const markdown = await getSubtree(env.DB, client, "None", 3);

		expect(markdown).toContain("- Top A");
		expect(markdown).toContain("- Top B");
		expect(markdown).toContain("  - Nested");
		expect(getNodeCalls).toEqual([]);
	});

	it("falls back to one API level when the node is not yet mirrored", async () => {
		const unsynced = apiNode({ id: UNSYNCED_UUID, name: "Brand new" });
		const child = apiNode({ id: CHILD_UUID, parent_id: UNSYNCED_UUID, name: "New child" });
		const { client, listChildrenCalls } = stubClient({
			nodes: { [UNSYNCED_UUID]: unsynced },
			children: { [UNSYNCED_UUID]: [child] },
		});

		const markdown = await getSubtree(env.DB, client, UNSYNCED_UUID, 5);

		expect(markdown).toContain("# Brand new");
		expect(markdown).toContain("- New child");
		expect(markdown).toContain("only its immediate children");
		expect(listChildrenCalls).toEqual([UNSYNCED_UUID]);
	});

	it("does not mention the mirror when the identifier does not resolve", async () => {
		const { client } = stubClient();

		await expect(getSubtree(env.DB, client, SHORT_ID, 3)).rejects.toThrow(/^(?!.*mirror).*$/is);
	});

	it("answers max_depth=1 from the API with no D1 query", async () => {
		// A mirror row exists and disagrees with the API; the API must win.
		await insert({ id: ROOT_UUID, name: "stale root" });
		await insert({ id: CHILD_UUID, parent_id: ROOT_UUID, name: "stale child" });
		const fresh = apiNode({ id: CHILD_UUID, parent_id: ROOT_UUID, name: "fresh child" });
		const { client, getNodeCalls, listChildrenCalls } = stubClient({
			nodes: { [ROOT_UUID]: apiNode({ id: ROOT_UUID, name: "fresh root" }) },
			children: { [ROOT_UUID]: [fresh] },
		});

		const markdown = await getSubtree(env.DB, client, ROOT_UUID, 1);

		expect(markdown).toContain("# fresh root");
		expect(markdown).toContain("- fresh child");
		expect(markdown).not.toContain("stale");
		expect(getNodeCalls).toEqual([ROOT_UUID]);
		expect(listChildrenCalls).toEqual([ROOT_UUID]);
		// No mirror read at all, so no sync-time footer either.
		expect(markdown).not.toContain("Mirror last synced");
	});

	it("renders the top level from the API for max_depth=1", async () => {
		const top = apiNode({ id: CHILD_UUID, name: "Top from API" });
		const { client, getNodeCalls } = stubClient({ children: { None: [top] } });

		const markdown = await getSubtree(env.DB, client, "None", 1);

		expect(markdown).toContain("- Top from API");
		expect(getNodeCalls).toEqual([]);
	});

	it("reports the mirror's last sync time on a deep walk", async () => {
		await insert({ id: ROOT_UUID, name: "Root" });
		await insert({ id: CHILD_UUID, parent_id: ROOT_UUID, name: "Child" });
		await env.DB.prepare("INSERT INTO sync_meta (key, value) VALUES (?, ?)")
			.bind("last_synced_at", "1700000000")
			.run();
		const { client } = stubClient();

		const markdown = await getSubtree(env.DB, client, ROOT_UUID, 3);

		expect(markdown).toContain("Mirror last synced");
		expect(markdown).toContain("2023-11-14T22:13:20.000Z");
	});

	it("says so when the mirror has never synced", async () => {
		await insert({ id: ROOT_UUID, name: "Root" });
		const { client } = stubClient();

		const markdown = await getSubtree(env.DB, client, ROOT_UUID, 3);

		expect(markdown).toContain("Mirror last synced: never");
	});
});

describe("read tools never sync", () => {
	// Reads answer from whatever the mirror holds. Syncing inline made them
	// wait minutes on a large outline and time out; syncing behind the request
	// would spend the 1req/min export budget at unpredictable moments. Both are
	// regressions this guards against, at the seam where they would reappear.
	it("exposes no ensureFresh to call", async () => {
		const sync = await import("../src/sync");

		expect(sync).not.toHaveProperty("ensureFresh");
	});

	it("does not touch sync_meta on a deep get_subtree beyond reading it", async () => {
		await insert({ id: ROOT_UUID, name: "Root" });
		await insert({ id: CHILD_UUID, parent_id: ROOT_UUID, name: "Child" });
		await env.DB.prepare("INSERT INTO sync_meta (key, value) VALUES (?, ?)")
			.bind("last_synced_at", "1700000000")
			.run();
		const { client } = stubClient();

		await getSubtree(env.DB, client, ROOT_UUID, 3);

		// An inline sync would have stamped last_sync_attempt_at and moved
		// last_synced_at forward.
		const { results } = await env.DB.prepare("SELECT key, value FROM sync_meta ORDER BY key").all<{
			key: string;
			value: string;
		}>();
		expect(results).toEqual([{ key: "last_synced_at", value: "1700000000" }]);
	});
});

describe("resolveForWrite", () => {
	it("passes a UUID through without an API call", async () => {
		const { client, getNodeCalls } = stubClient();

		expect(await resolveForWrite(env.DB, client, ROOT_UUID)).toBe(ROOT_UUID);
		expect(getNodeCalls).toEqual([]);
	});

	it("passes a short id through: the :id path segment accepts it", async () => {
		const { client, getNodeCalls } = stubClient();

		expect(await resolveForWrite(env.DB, client, SHORT_ID)).toBe(SHORT_ID);
		expect(getNodeCalls).toEqual([]);
	});

	it("passes calendar targets through without an API call", async () => {
		const { client, getNodeCalls } = stubClient();

		expect(await resolveForWrite(env.DB, client, "today")).toBe("today");
		expect(await resolveForWrite(env.DB, client, "2026-07-26")).toBe("2026-07-26");
		expect(getNodeCalls).toEqual([]);
	});

	it("reduces a URL to the short id the path accepts", async () => {
		const { client, getNodeCalls } = stubClient();

		expect(await resolveForWrite(env.DB, client, `https://workflowy.com/#/${SHORT_ID}`)).toBe(
			SHORT_ID,
		);
		expect(getNodeCalls).toEqual([]);
	});

	it("resolves a shortcut key to a UUID, since the path cannot take one", async () => {
		const { client, getNodeCalls } = stubClient({
			nodes: { rd: apiNode({ id: CHILD_UUID }) },
		});

		expect(await resolveForWrite(env.DB, client, "rd")).toBe(CHILD_UUID);
		expect(getNodeCalls).toEqual(["rd"]);
	});

	it("refuses the outline root, which is not a writable node", async () => {
		const { client, getNodeCalls } = stubClient();

		await expect(resolveForWrite(env.DB, client, "None")).rejects.toThrow(/Malformed node identifier/);
		expect(getNodeCalls).toEqual([]);
	});

	it("rejects structurally impossible input before any API call", async () => {
		const { client, getNodeCalls } = stubClient();

		await expect(resolveForWrite(env.DB, client, "   ")).rejects.toThrow(/Malformed node identifier/);
		expect(getNodeCalls).toEqual([]);
	});
});
