import { WorkflowyApiError, type WorkflowyNode } from "./workflowy-client";

/**
 * Node identifier handling.
 *
 * Workflowy's official API accepts a wider vocabulary of node identifiers than
 * the D1 mirror does: besides full UUIDs it resolves the 12-digit short ids
 * that appear in `https://workflowy.com/#/xxxxxxxxxxxx` URLs, calendar targets
 * ("today", "2026-07-25", ...), "inbox", and user-defined shortcut keys.
 * Rather than reimplement that vocabulary against the mirror, everything the
 * mirror cannot answer by itself is delegated to the API.
 *
 * Note the vocabulary is asymmetric upstream: URLs, shortcut keys and "None"
 * are documented for List/Create/Move but not for Retrieve, so URLs are
 * normalised to a short id here before a single-node fetch.
 */

/** The root of the outline. It has no UUID; children are listed via parent_id=None. */
export const ROOT_SENTINEL = "None";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHORT_ID_RE = /^[0-9a-f]{12}$/;
const HEXISH_RE = /^[0-9A-Fa-f-]+$/;
const URL_RE = /^(?:https?:\/\/(?:www\.)?workflowy\.com)?\/?#\/([^/?#\s]+)\/?/;
const NAMED_TARGETS = new Set(["inbox", "calendar", "today", "tomorrow", "next_week"]);
const MAX_IDENTIFIER_LENGTH = 128;

export type NodeIdentifierKind = "uuid" | "short_id" | "root" | "keyword" | "shortcut" | "invalid";

export interface NodeIdentifier {
	kind: NodeIdentifierKind;
	value: string;
}

/** Raised when the input cannot be interpreted as a node identifier at all. */
export class NodeIdentifierError extends Error {
	constructor(public input: string) {
		super(`識別子の形式が不正です: ${input}`);
		this.name = "NodeIdentifierError";
	}
}

/** Raised when the identifier is well-formed but resolves to nothing. */
export class NodeNotFoundError extends Error {
	constructor(public input: string) {
		super(`ノードが存在しないか、アクセス権がありません: ${input}`);
		this.name = "NodeNotFoundError";
	}
}

/**
 * Strips whitespace, reduces a Workflowy URL (or bare `#/xxxx` fragment) to the
 * short id it points at, and lowercases anything that looks like hex so casing
 * never decides whether an id matches.
 */
export function normalizeNodeIdentifier(input: string): string {
	const trimmed = input.trim();
	const urlMatch = URL_RE.exec(trimmed);
	const candidate = urlMatch ? urlMatch[1] : trimmed;
	return HEXISH_RE.test(candidate) ? candidate.toLowerCase() : candidate;
}

/** True for `YYYY`, `YYYY-MM` and `YYYY-MM-DD` calendar targets. */
function isCalendarDate(value: string): boolean {
	const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
	if (!match) return false;

	const month = match[2] ? Number(match[2]) : null;
	const day = match[3] ? Number(match[3]) : null;
	if (month !== null && (month < 1 || month > 12)) return false;
	if (day !== null && (day < 1 || day > 31)) return false;
	return true;
}

export function classifyNodeIdentifier(input: string): NodeIdentifier {
	const value = normalizeNodeIdentifier(input);

	if (!value || value.length > MAX_IDENTIFIER_LENGTH) {
		return { kind: "invalid", value };
	}
	if (UUID_RE.test(value)) return { kind: "uuid", value };
	if (SHORT_ID_RE.test(value)) return { kind: "short_id", value };

	const lowered = value.toLowerCase();
	if (lowered === ROOT_SENTINEL.toLowerCase()) return { kind: "root", value: ROOT_SENTINEL };
	if (NAMED_TARGETS.has(lowered)) return { kind: "keyword", value: lowered };
	if (isCalendarDate(value)) return { kind: "keyword", value };

	// Anything else is passed to the API as a shortcut-key candidate; the API
	// is the only authority on which keys the user has defined.
	return { kind: "shortcut", value };
}

/**
 * Prepares an identifier for a write endpoint. The API accepts the whole
 * vocabulary on writes, so nothing needs resolving upfront -- but URLs are
 * only documented for List/Create/Move, so they are reduced to a short id
 * here. Rejecting malformed input locally also keeps a doomed request from
 * reaching the API at all.
 */
export function normalizeForApi(input: string): string {
	const identifier = classifyNodeIdentifier(input);
	if (identifier.kind === "invalid") {
		throw new NodeIdentifierError(input.trim());
	}
	return identifier.value;
}

/** The subset of WorkflowyClient the resolver needs, kept narrow for testing. */
export interface NodeFetcher {
	getNode(nodeId: string): Promise<WorkflowyNode>;
}

export interface ResolvedNode {
	/** Full UUID, or the literal "None" when kind is "root". */
	id: string;
	kind: NodeIdentifierKind;
	/** The node body, when resolution went through the API. Null for mirror hits and the root. */
	node: WorkflowyNode | null;
}

/**
 * Resolves any accepted identifier to a full UUID.
 *
 * A UUID already present in the mirror short-circuits with no HTTP call. Every
 * other form goes to the API, and the fetched node is returned alongside the id
 * so callers do not have to fetch the same node twice.
 */
export async function resolveNodeId(
	db: D1Database,
	client: NodeFetcher,
	input: string,
): Promise<ResolvedNode> {
	const identifier = classifyNodeIdentifier(input);

	if (identifier.kind === "invalid") {
		throw new NodeIdentifierError(input.trim());
	}
	if (identifier.kind === "root") {
		return { id: ROOT_SENTINEL, kind: "root", node: null };
	}
	if (identifier.kind === "uuid") {
		const row = await db
			.prepare("SELECT id FROM nodes WHERE id = ?")
			.bind(identifier.value)
			.first<{ id: string }>();
		if (row) return { id: row.id, kind: "uuid", node: null };
	}

	let node: WorkflowyNode;
	try {
		node = await client.getNode(identifier.value);
	} catch (err) {
		if (err instanceof WorkflowyApiError && err.status === 404) {
			throw new NodeNotFoundError(identifier.value);
		}
		throw err;
	}

	return { id: node.id, kind: identifier.kind, node };
}
