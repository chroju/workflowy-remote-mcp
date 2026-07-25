import { describe, expect, it } from "vitest";
import {
	NodeIdentifierError,
	NodeNotFoundError,
	fetchResolvedNode,
	nodeUrl,
	normalizeNodeIdentifier,
	resolveNodeId,
	shortIdOf,
} from "./node-id";
import { WorkflowyApiError } from "./workflowy-client";
import type { WorkflowyClient, WorkflowyNode } from "./workflowy-client";

const DAILY_NOTE_UUID = "a1b2c3d4-5566-7788-99aa-db48cc88ed2c";

function node(overrides: Partial<WorkflowyNode> = {}): WorkflowyNode {
	return {
		id: DAILY_NOTE_UUID,
		parent_id: null,
		name: "2026-07-25",
		note: null,
		priority: 0,
		createdAt: null,
		modifiedAt: null,
		completedAt: null,
		...overrides,
	};
}

/**
 * Records every identifier sent upstream so the tests can assert both the
 * result and how many round trips it took to get there.
 */
function fakeClient(
	handlers: {
		getNode?: (id: string) => WorkflowyNode | null;
		listTargets?: () => unknown;
	} = {},
) {
	const retrieved: string[] = [];
	const client = {
		async getNode(id: string) {
			retrieved.push(id);
			const found = handlers.getNode?.(id) ?? null;
			if (!found) {
				throw new WorkflowyApiError(404, "Not Found", "{}", "not found");
			}
			return found;
		},
		async listTargets() {
			return handlers.listTargets?.() ?? { targets: [] };
		},
	} as unknown as WorkflowyClient;
	return { client, retrieved };
}

describe("normalizeNodeIdentifier", () => {
	it("extracts the short id from an outline URL", () => {
		for (const input of [
			"https://workflowy.com/#/db48cc88ed2c",
			"http://workflowy.com/#/db48cc88ed2c",
			"https://beta.workflowy.com/#/db48cc88ed2c",
			"workflowy.com/#/db48cc88ed2c",
			"#/db48cc88ed2c",
			"  https://workflowy.com/#/db48cc88ed2c  ",
			"https://workflowy.com/#/db48cc88ed2c?q=%23ai",
		]) {
			expect(normalizeNodeIdentifier(input)).toMatchObject({
				value: "db48cc88ed2c",
				kind: "short_id",
			});
		}
	});

	it("lower-cases hex identifiers and keeps full UUIDs on the local path", () => {
		expect(normalizeNodeIdentifier("DB48CC88ED2C")).toMatchObject({
			value: "db48cc88ed2c",
			kind: "short_id",
		});
		expect(normalizeNodeIdentifier(DAILY_NOTE_UUID.toUpperCase())).toMatchObject({
			value: DAILY_NOTE_UUID,
			kind: "uuid",
		});
	});

	it("re-dashes a 32-character UUID", () => {
		expect(normalizeNodeIdentifier(DAILY_NOTE_UUID.replace(/-/g, ""))).toMatchObject({
			value: DAILY_NOTE_UUID,
			kind: "uuid",
		});
	});

	it("canonicalises reserved targets regardless of case", () => {
		expect(normalizeNodeIdentifier("none").value).toBe("None");
		expect(normalizeNodeIdentifier("NONE").value).toBe("None");
		expect(normalizeNodeIdentifier("Inbox").value).toBe("inbox");
		for (const target of ["calendar", "today", "tomorrow", "next_week"]) {
			expect(normalizeNodeIdentifier(target)).toMatchObject({ value: target, kind: "reserved" });
		}
	});

	it("accepts calendar targets at year, month and day granularity", () => {
		for (const target of ["2026", "2026-07", "2026-07-25"]) {
			expect(normalizeNodeIdentifier(target)).toMatchObject({ value: target, kind: "calendar" });
		}
	});

	it("treats unrecognised short strings as shortcut keys", () => {
		expect(normalizeNodeIdentifier("rd")).toMatchObject({ value: "rd", kind: "shortcut" });
	});

	it("rejects input that cannot be an identifier", () => {
		for (const input of [
			"",
			"   ",
			"日次ノート を探す",
			"2026-13-01",
			"2026-07-32",
			// Hex, but no valid id is this long or this short-of-twelve.
			"f06c631642e",
			"f06c631642ebc",
			"a".repeat(80),
		]) {
			expect(() => normalizeNodeIdentifier(input)).toThrow(NodeIdentifierError);
		}
	});

	it("reports the caller's original input in the error, not the normalised form", () => {
		expect(() => normalizeNodeIdentifier("https://workflowy.com/#/f06c631642e")).toThrow(
			"識別子の形式が不正です: https://workflowy.com/#/f06c631642e",
		);
	});
});

describe("resolveNodeId", () => {
	it("resolves a full UUID without contacting the API", async () => {
		const { client, retrieved } = fakeClient();
		const resolved = await resolveNodeId(client, DAILY_NOTE_UUID);
		expect(resolved).toMatchObject({ id: DAILY_NOTE_UUID, listKey: DAILY_NOTE_UUID, node: null });
		expect(retrieved).toEqual([]);
	});

	it("resolves a URL to a full UUID in a single retrieve", async () => {
		const { client, retrieved } = fakeClient({
			getNode: (id) => (id === "db48cc88ed2c" ? node() : null),
		});
		const resolved = await resolveNodeId(client, "https://workflowy.com/#/db48cc88ed2c");
		expect(resolved.id).toBe(DAILY_NOTE_UUID);
		expect(retrieved).toEqual(["db48cc88ed2c"]);
	});

	it("hands back the retrieved node so callers need not fetch it twice", async () => {
		const { client, retrieved } = fakeClient({ getNode: () => node() });
		const resolved = await resolveNodeId(client, "today");
		expect(resolved.node?.name).toBe("2026-07-25");
		await fetchResolvedNode(client, resolved);
		expect(retrieved).toEqual(["today"]);
	});

	it("resolves calendar targets", async () => {
		const { client, retrieved } = fakeClient({ getNode: () => node() });
		expect((await resolveNodeId(client, "2026-07-24")).id).toBe(DAILY_NOTE_UUID);
		expect(retrieved).toEqual(["2026-07-24"]);
	});

	it("treats None as a container with no node body", async () => {
		const { client, retrieved } = fakeClient();
		const resolved = await resolveNodeId(client, "None");
		expect(resolved).toMatchObject({ id: null, listKey: "None" });
		expect(retrieved).toEqual([]);
	});

	it("falls back to listing for inbox when retrieve does not support it", async () => {
		const { client } = fakeClient({ getNode: () => null });
		const resolved = await resolveNodeId(client, "inbox");
		expect(resolved).toMatchObject({ id: null, listKey: "inbox" });
	});

	it("looks a shortcut key up in /targets when retrieve misses", async () => {
		const { client, retrieved } = fakeClient({
			getNode: (id) => (id === DAILY_NOTE_UUID ? node() : null),
			listTargets: () => ({ targets: [{ key: "rd", id: DAILY_NOTE_UUID }] }),
		});
		const resolved = await resolveNodeId(client, "rd");
		expect(resolved.id).toBe(DAILY_NOTE_UUID);
		expect(retrieved).toEqual(["rd", DAILY_NOTE_UUID]);
	});

	it("raises a not-found error that names neither the store nor a status code", async () => {
		const { client } = fakeClient({ getNode: () => null });
		await expect(resolveNodeId(client, "db48cc88ed2c")).rejects.toThrow(NodeNotFoundError);
		await expect(resolveNodeId(client, "db48cc88ed2c")).rejects.toThrow(
			"ノードが存在しないか、アクセス権がありません: db48cc88ed2c",
		);
	});

	it("lets non-404 API failures surface unchanged", async () => {
		const client = {
			async getNode() {
				throw new WorkflowyApiError(500, "Server Error", "boom", "boom");
			},
		} as unknown as WorkflowyClient;
		await expect(resolveNodeId(client, "today")).rejects.toThrow(WorkflowyApiError);
	});
});

describe("shortIdOf / nodeUrl", () => {
	it("round-trips a UUID back to the URL it came from", () => {
		expect(shortIdOf(DAILY_NOTE_UUID)).toBe("db48cc88ed2c");
		expect(nodeUrl(DAILY_NOTE_UUID)).toBe("https://workflowy.com/#/db48cc88ed2c");
		expect(normalizeNodeIdentifier(nodeUrl(DAILY_NOTE_UUID)).value).toBe("db48cc88ed2c");
	});
});
