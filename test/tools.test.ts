import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getNode, getSubtree } from "../src/tools";
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
});

describe("getNode", () => {
	it("resolves a short id in a single getNode call", async () => {
		const target = apiNode({ id: ROOT_UUID, name: "<time>2026-07-25</time>" });
		const { client, getNodeCalls } = stubClient({ nodes: { [SHORT_ID]: target } });

		const result = await getNode(env.DB, client, SHORT_ID);

		expect(result.node).toEqual(target);
		expect(getNodeCalls).toEqual([SHORT_ID]);
	});

	it("resolves a Workflowy URL in a single getNode call", async () => {
		const target = apiNode();
		const { client, getNodeCalls } = stubClient({ nodes: { [SHORT_ID]: target } });

		const result = await getNode(env.DB, client, `https://workflowy.com/#/${SHORT_ID}`);

		expect(result.node).toEqual(target);
		expect(getNodeCalls).toEqual([SHORT_ID]);
	});

	it("resolves calendar targets", async () => {
		const today = apiNode({ name: "today node" });
		const { client, getNodeCalls } = stubClient({ nodes: { today } });

		const result = await getNode(env.DB, client, "today");

		expect(result.node).toEqual(today);
		expect(getNodeCalls).toEqual(["today"]);
	});

	it("lists children from the API, not the mirror", async () => {
		await insert({ id: ROOT_UUID, name: "stale root" });
		await insert({ id: CHILD_UUID, parent_id: ROOT_UUID, name: "stale child" });
		const fresh = apiNode({ id: CHILD_UUID, parent_id: ROOT_UUID, name: "fresh child" });
		const { client, listChildrenCalls } = stubClient({ children: { [ROOT_UUID]: [fresh] } });

		const result = await getNode(env.DB, client, ROOT_UUID);

		expect(result.children).toEqual([fresh]);
		expect(listChildrenCalls).toEqual([ROOT_UUID]);
	});

	it("returns the top level for the root sentinel without a getNode call", async () => {
		const top = apiNode({ id: CHILD_UUID, name: "top level" });
		const { client, getNodeCalls, listChildrenCalls } = stubClient({
			children: { None: [top] },
		});

		const result = await getNode(env.DB, client, "None");

		expect(result.node).toBeNull();
		expect(result.children).toEqual([top]);
		expect(getNodeCalls).toEqual([]);
		expect(listChildrenCalls).toEqual(["None"]);
	});

	it("includes the ancestor path from the mirror", async () => {
		await insert({ id: ROOT_UUID, name: "Context" });
		await insert({ id: CHILD_UUID, parent_id: ROOT_UUID, name: "Project" });
		const { client } = stubClient();

		const result = await getNode(env.DB, client, CHILD_UUID);

		expect(result.ancestor_path).toBe("Context > Project");
	});

	it("reports a missing node without leaking the mirror", async () => {
		const { client } = stubClient();

		await expect(getNode(env.DB, client, SHORT_ID)).rejects.toThrow(
			"ノードが存在しないか、アクセス権がありません: f06c631642eb",
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
		expect(markdown).toContain("1階層のみ");
		expect(listChildrenCalls).toEqual([UNSYNCED_UUID]);
	});

	it("does not mention the mirror when the identifier does not resolve", async () => {
		const { client } = stubClient();

		await expect(getSubtree(env.DB, client, SHORT_ID, 3)).rejects.toThrow(/^(?!.*mirror).*$/is);
	});
});
