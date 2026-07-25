import { describe, expect, it } from "vitest";
import {
	NodeIdentifierError,
	classifyNodeIdentifier,
	normalizeForApi,
	normalizeNodeIdentifier,
} from "../src/node-id";

describe("normalizeNodeIdentifier", () => {
	it("trims surrounding whitespace", () => {
		expect(normalizeNodeIdentifier("  today  ")).toBe("today");
	});

	it("extracts the short id from a full Workflowy URL", () => {
		expect(normalizeNodeIdentifier("https://workflowy.com/#/f06c631642eb")).toBe("f06c631642eb");
	});

	it("extracts the short id from a bare fragment", () => {
		expect(normalizeNodeIdentifier("#/f06c631642eb")).toBe("f06c631642eb");
	});

	it("keeps a trailing slash out of the extracted id", () => {
		expect(normalizeNodeIdentifier("https://workflowy.com/#/f06c631642eb/")).toBe("f06c631642eb");
	});

	it("lowercases hex identifiers", () => {
		expect(normalizeNodeIdentifier("F06C631642EB")).toBe("f06c631642eb");
		expect(normalizeNodeIdentifier("6E9C5B0A-1234-4ABC-8DEF-F06C631642EB")).toBe(
			"6e9c5b0a-1234-4abc-8def-f06c631642eb",
		);
	});

	it("leaves non-hex identifiers untouched apart from trimming", () => {
		expect(normalizeNodeIdentifier("None")).toBe("None");
		expect(normalizeNodeIdentifier("Inbox")).toBe("Inbox");
	});
});

describe("classifyNodeIdentifier", () => {
	it("recognises a full UUID", () => {
		expect(classifyNodeIdentifier("6e9c5b0a-1234-4abc-8def-f06c631642eb")).toEqual({
			kind: "uuid",
			value: "6e9c5b0a-1234-4abc-8def-f06c631642eb",
		});
	});

	it("recognises a 12-digit short id", () => {
		expect(classifyNodeIdentifier("f06c631642eb")).toEqual({
			kind: "short_id",
			value: "f06c631642eb",
		});
	});

	it("recognises the root sentinel case-insensitively", () => {
		expect(classifyNodeIdentifier("None").kind).toBe("root");
		expect(classifyNodeIdentifier("none").kind).toBe("root");
	});

	it("recognises calendar and inbox keywords", () => {
		for (const keyword of ["inbox", "calendar", "today", "tomorrow", "next_week"]) {
			expect(classifyNodeIdentifier(keyword)).toEqual({ kind: "keyword", value: keyword });
		}
	});

	it("normalises keyword casing", () => {
		expect(classifyNodeIdentifier("Today")).toEqual({ kind: "keyword", value: "today" });
	});

	it("recognises calendar date targets", () => {
		expect(classifyNodeIdentifier("2026")).toEqual({ kind: "keyword", value: "2026" });
		expect(classifyNodeIdentifier("2026-07")).toEqual({ kind: "keyword", value: "2026-07" });
		expect(classifyNodeIdentifier("2026-07-25")).toEqual({ kind: "keyword", value: "2026-07-25" });
	});

	it("rejects impossible calendar dates", () => {
		expect(classifyNodeIdentifier("2026-13").kind).toBe("shortcut");
		expect(classifyNodeIdentifier("2026-07-32").kind).toBe("shortcut");
	});

	it("treats anything else as a shortcut key candidate", () => {
		expect(classifyNodeIdentifier("rd")).toEqual({ kind: "shortcut", value: "rd" });
	});

	it("rejects empty input", () => {
		expect(classifyNodeIdentifier("").kind).toBe("invalid");
		expect(classifyNodeIdentifier("   ").kind).toBe("invalid");
	});

	it("rejects strings too long to be a shortcut key", () => {
		expect(classifyNodeIdentifier("x".repeat(200)).kind).toBe("invalid");
	});

	it("classifies a URL by its extracted short id", () => {
		expect(classifyNodeIdentifier("https://workflowy.com/#/f06c631642eb")).toEqual({
			kind: "short_id",
			value: "f06c631642eb",
		});
	});
});

describe("normalizeForApi", () => {
	it("reduces a URL to the short id the API accepts", () => {
		expect(normalizeForApi("https://workflowy.com/#/f06c631642eb")).toBe("f06c631642eb");
	});

	it("passes the API's own vocabulary through untouched", () => {
		expect(normalizeForApi("today")).toBe("today");
		expect(normalizeForApi("inbox")).toBe("inbox");
		expect(normalizeForApi("None")).toBe("None");
		expect(normalizeForApi("2026-07-25")).toBe("2026-07-25");
		expect(normalizeForApi("rd")).toBe("rd");
	});

	it("rejects input that cannot be an identifier before any request is made", () => {
		expect(() => normalizeForApi("  ")).toThrow(NodeIdentifierError);
	});
});
