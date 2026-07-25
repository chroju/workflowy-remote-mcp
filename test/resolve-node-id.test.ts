import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { NodeIdentifierError, NodeNotFoundError, resolveNodeId } from "../src/node-id";
import type { WorkflowyNode } from "../src/workflowy-client";
import { WorkflowyApiError } from "../src/workflowy-client";

const UUID = "6e9c5b0a-1234-4abc-8def-f06c631642eb";
const SHORT_ID = "f06c631642eb";

function node(overrides: Partial<WorkflowyNode> = {}): WorkflowyNode {
	return {
		id: UUID,
		parent_id: null,
		name: "Test node",
		note: null,
		priority: 0,
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		...overrides,
	};
}

/** Records every getNode call so tests can assert the API call count. */
function fakeClient(handler: (id: string) => WorkflowyNode | Promise<WorkflowyNode>) {
	const calls: string[] = [];
	return {
		calls,
		client: {
			getNode: async (id: string) => {
				calls.push(id);
				return handler(id);
			},
		},
	};
}

function notFound(id: string): never {
	throw new WorkflowyApiError(404, "Not Found", "", `Workflowy API error: 404 Not Found - ${id}`);
}

beforeEach(async () => {
	await env.DB.exec("DROP TABLE IF EXISTS nodes");
	await env.DB.exec(
		"CREATE TABLE nodes (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL DEFAULT '', note TEXT, priority INTEGER NOT NULL DEFAULT 0, layout_mode TEXT NOT NULL DEFAULT 'bullets', created_at INTEGER, modified_at INTEGER, completed_at INTEGER)",
	);
});

describe("resolveNodeId", () => {
	it("resolves a full UUID from the mirror without calling the API", async () => {
		await env.DB.prepare("INSERT INTO nodes (id, name) VALUES (?, ?)").bind(UUID, "Mirrored").run();
		const { client, calls } = fakeClient(() => notFound(UUID));

		const result = await resolveNodeId(env.DB, client, UUID);

		expect(result.id).toBe(UUID);
		expect(result.node).toBeNull();
		expect(calls).toEqual([]);
	});

	it("falls back to the API when a UUID is missing from the mirror", async () => {
		const fetched = node();
		const { client, calls } = fakeClient(() => fetched);

		const result = await resolveNodeId(env.DB, client, UUID);

		expect(result.id).toBe(UUID);
		expect(result.node).toEqual(fetched);
		expect(calls).toEqual([UUID]);
	});

	it("resolves a 12-digit short id through the API in a single call", async () => {
		const fetched = node();
		const { client, calls } = fakeClient(() => fetched);

		const result = await resolveNodeId(env.DB, client, SHORT_ID);

		expect(result.id).toBe(UUID);
		expect(result.node).toEqual(fetched);
		expect(calls).toEqual([SHORT_ID]);
	});

	it("resolves a Workflowy URL in a single call", async () => {
		const fetched = node();
		const { client, calls } = fakeClient(() => fetched);

		const result = await resolveNodeId(env.DB, client, `https://workflowy.com/#/${SHORT_ID}`);

		expect(result.id).toBe(UUID);
		expect(calls).toEqual([SHORT_ID]);
	});

	it("resolves calendar keywords through the API", async () => {
		const fetched = node({ name: "<time>2026-07-25</time>" });
		const { client, calls } = fakeClient(() => fetched);

		const result = await resolveNodeId(env.DB, client, "today");

		expect(result.id).toBe(UUID);
		expect(result.node).toEqual(fetched);
		expect(calls).toEqual(["today"]);
	});

	it("resolves a date target through the API", async () => {
		const { client, calls } = fakeClient(() => node());

		await resolveNodeId(env.DB, client, "2026-07-24");

		expect(calls).toEqual(["2026-07-24"]);
	});

	it("returns the root sentinel without calling the API", async () => {
		const { client, calls } = fakeClient(() => notFound("None"));

		const result = await resolveNodeId(env.DB, client, "None");

		expect(result.kind).toBe("root");
		expect(result.id).toBe("None");
		expect(result.node).toBeNull();
		expect(calls).toEqual([]);
	});

	it("passes an unknown string to the API as a shortcut key candidate", async () => {
		const { client, calls } = fakeClient(() => node());

		await resolveNodeId(env.DB, client, "rd");

		expect(calls).toEqual(["rd"]);
	});

	it("throws NodeIdentifierError for input that cannot be an identifier", async () => {
		const { client, calls } = fakeClient(() => node());

		await expect(resolveNodeId(env.DB, client, "   ")).rejects.toBeInstanceOf(NodeIdentifierError);
		expect(calls).toEqual([]);
	});

	it("throws NodeNotFoundError when the API returns 404", async () => {
		const { client } = fakeClient((id) => notFound(id));

		await expect(resolveNodeId(env.DB, client, SHORT_ID)).rejects.toBeInstanceOf(NodeNotFoundError);
	});

	it("does not mention the mirror in error messages", async () => {
		const { client } = fakeClient((id) => notFound(id));

		await expect(resolveNodeId(env.DB, client, SHORT_ID)).rejects.toThrow(
			/^(?!.*mirror).*$/is,
		);
		await expect(resolveNodeId(env.DB, client, "")).rejects.toThrow(/^(?!.*mirror).*$/is);
	});

	it("propagates non-404 API errors unchanged", async () => {
		const { client } = fakeClient(() => {
			throw new WorkflowyApiError(500, "Server Error", "boom", "Workflowy API error: 500");
		});

		await expect(resolveNodeId(env.DB, client, SHORT_ID)).rejects.toBeInstanceOf(WorkflowyApiError);
	});
});
