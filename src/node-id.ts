import { WorkflowyApiError, WorkflowyClient } from "./workflowy-client";
import type { WorkflowyNode } from "./workflowy-client";

/**
 * Node identifier handling.
 *
 * Workflowy's official API accepts a much wider vocabulary of node
 * identifiers than a raw UUID: the 12-character short id that appears in
 * outline URLs, calendar targets such as `today` or `2026-07-25`, the
 * container targets `None` and `inbox`, and user-defined shortcut keys.
 * Everything that takes a node identifier routes through this module so the
 * whole server accepts that same vocabulary.
 *
 * Two important asymmetries in the upstream API shape the design here:
 *
 *  - `GET /nodes/:id` (Retrieve) documents full UUIDs, short ids and
 *    calendar targets, but *not* URLs, shortcut keys, `None` or `inbox` —
 *    those appear only for List/Create/Move. URLs are therefore normalised
 *    locally before anything is sent upstream, and the container targets are
 *    resolved by listing rather than retrieving.
 *  - `GET /nodes-export` is rate limited to one request per minute, so
 *    resolution never falls back to a full sync.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNDASHED_UUID_RE = /^[0-9a-f]{32}$/;
const SHORT_ID_RE = /^[0-9a-f]{12}$/;
const HEX_RE = /^[0-9a-f]+$/;
const CALENDAR_RE = /^\d{4}(-(?:0[1-9]|1[0-2])(-(?:0[1-9]|[12]\d|3[01]))?)?$/;
const DATE_SHAPED_RE = /^\d{4}-\d{1,2}(-\d{1,2})?$/;

/** Canonical spelling, keyed by lower-cased input. */
const RESERVED_TARGETS = new Map([
	["none", "None"],
	["inbox", "inbox"],
	["calendar", "calendar"],
	["today", "today"],
	["tomorrow", "tomorrow"],
	["next_week", "next_week"],
]);

/** Targets that name a container but have no retrievable node body. */
const CONTAINER_TARGETS = new Set(["None", "inbox"]);

/** Sentinel used as the parent key for the top level of the outline. */
export const ROOT_TARGET = "None";

const MAX_IDENTIFIER_LENGTH = 64;

export type IdentifierKind = "uuid" | "short_id" | "calendar" | "reserved" | "shortcut";

export interface NormalizedIdentifier {
	/** The identifier to send upstream, in its canonical spelling. */
	value: string;
	kind: IdentifierKind;
	/** The caller's original input, kept for error messages. */
	input: string;
}

export interface ResolvedNodeId {
	/** Full UUID, or null for a container target that has no node of its own. */
	id: string | null;
	/** Identifier to pass as `parent_id` when listing this target's children. */
	listKey: string;
	/** Node body, when resolution already had to fetch it. Reuse it. */
	node: WorkflowyNode | null;
	kind: IdentifierKind;
	input: string;
}

/** The input cannot be read as a node identifier at all. */
export class NodeIdentifierError extends Error {
	constructor(public input: string) {
		super(`識別子の形式が不正です: ${input}`);
		this.name = "NodeIdentifierError";
	}
}

/** The identifier was well formed but names nothing we can reach. */
export class NodeNotFoundError extends Error {
	constructor(public input: string) {
		super(`ノードが存在しないか、アクセス権がありません: ${input}`);
		this.name = "NodeNotFoundError";
	}
}

/**
 * Pulls the node identifier out of a Workflowy outline URL. Accepts full
 * URLs (`https://workflowy.com/#/abc123abc123`), protocol-relative and
 * host-relative forms, and the bare `#/abc123abc123` fragment. Returns the
 * input unchanged when it does not look like a URL.
 */
function stripUrlWrapper(raw: string): string {
	let value = raw;

	const hostMatch = value.match(/^(?:https?:\/\/)?(?:[\w-]+\.)*workflowy\.com\/(.*)$/i);
	if (hostMatch) {
		value = hostMatch[1];
	}

	if (value.startsWith("#/")) {
		value = value.slice(2);
	}

	// Drop any query string or trailing fragment the URL carried.
	value = value.split(/[?#]/)[0];

	// Share links and other nested paths: the node key is the last segment.
	const segments = value.split("/").filter(Boolean);
	if (segments.length > 0) {
		value = segments[segments.length - 1];
	}

	return value;
}

function dashifyUuid(undashed: string): string {
	return [
		undashed.slice(0, 8),
		undashed.slice(8, 12),
		undashed.slice(12, 16),
		undashed.slice(16, 20),
		undashed.slice(20),
	].join("-");
}

/**
 * Normalises a caller-supplied identifier without contacting the API.
 * Throws {@link NodeIdentifierError} when the input cannot be an identifier.
 */
export function normalizeNodeIdentifier(raw: string): NormalizedIdentifier {
	const input = raw ?? "";
	let value = stripUrlWrapper(input.trim());

	if (value === "") {
		throw new NodeIdentifierError(input);
	}
	if (value.length > MAX_IDENTIFIER_LENGTH || /\s/.test(value)) {
		throw new NodeIdentifierError(input);
	}

	const reserved = RESERVED_TARGETS.get(value.toLowerCase());
	if (reserved) {
		return { value: reserved, kind: "reserved", input };
	}

	const lowered = value.toLowerCase();
	if (UUID_RE.test(lowered)) {
		return { value: lowered, kind: "uuid", input };
	}
	if (UNDASHED_UUID_RE.test(lowered)) {
		return { value: dashifyUuid(lowered), kind: "uuid", input };
	}
	if (SHORT_ID_RE.test(lowered)) {
		return { value: lowered, kind: "short_id", input };
	}

	if (CALENDAR_RE.test(value)) {
		return { value, kind: "calendar", input };
	}
	// Date-shaped but out of range (e.g. "2026-13-01") is a typo, not a shortcut key.
	if (DATE_SHAPED_RE.test(value)) {
		throw new NodeIdentifierError(input);
	}

	// A long run of hex that is not a valid id length is a truncated or
	// mangled id rather than a shortcut key; say so instead of burning an
	// API call on it. Short hex-ish strings stay eligible as shortcut keys.
	if (HEX_RE.test(lowered) && lowered.length >= 8) {
		throw new NodeIdentifierError(input);
	}

	return { value, kind: "shortcut", input };
}

/**
 * The 12-character key Workflowy puts in outline URLs, which is the tail of
 * the node's UUID.
 */
export function shortIdOf(uuid: string): string {
	return uuid.replace(/-/g, "").slice(-12);
}

/** Permalink for a node, so callers can hand the user a clickable URL. */
export function nodeUrl(uuid: string): string {
	return `https://workflowy.com/#/${shortIdOf(uuid)}`;
}

async function retrieveOrNull(
	client: WorkflowyClient,
	identifier: string,
): Promise<WorkflowyNode | null> {
	try {
		return await client.getNode(identifier);
	} catch (err) {
		if (err instanceof WorkflowyApiError && (err.status === 404 || err.status === 400)) {
			return null;
		}
		throw err;
	}
}

/**
 * Maps a user-defined shortcut key to a node id via `GET /targets`. The
 * response shape is not pinned down by the API reference, so this reads it
 * defensively and gives up quietly rather than failing the whole call.
 */
async function lookupShortcutTarget(
	client: WorkflowyClient,
	key: string,
): Promise<string | null> {
	let payload: unknown;
	try {
		payload = await client.listTargets();
	} catch {
		return null;
	}
	if (!payload || typeof payload !== "object") return null;

	const wanted = key.toLowerCase();

	const entries: unknown[] = Array.isArray(payload)
		? payload
		: Array.isArray((payload as { targets?: unknown }).targets)
			? ((payload as { targets: unknown[] }).targets)
			: [];

	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const keys = [record.key, record.shortcut, record.target, record.name].filter(
			(candidate): candidate is string => typeof candidate === "string",
		);
		if (!keys.some((candidate) => candidate.toLowerCase() === wanted)) continue;
		const id = [record.id, record.node_id, record.item_id].find(
			(candidate): candidate is string => typeof candidate === "string",
		);
		if (id) return id;
	}

	// Fall back to a flat `{ "<key>": "<node id>" }` map.
	if (!Array.isArray(payload)) {
		for (const [candidate, id] of Object.entries(payload as Record<string, unknown>)) {
			if (candidate.toLowerCase() === wanted && typeof id === "string") return id;
		}
	}

	return null;
}

/**
 * Turns any accepted identifier into a full UUID, contacting the API only
 * when the input is not already a UUID. The node body fetched along the way
 * is returned so callers do not have to retrieve the same node twice.
 */
export async function resolveNodeId(
	client: WorkflowyClient,
	raw: string,
): Promise<ResolvedNodeId> {
	const { value, kind, input } = normalizeNodeIdentifier(raw);

	if (kind === "uuid") {
		return { id: value, listKey: value, node: null, kind, input };
	}

	// The top level of the outline is not a node and cannot be retrieved.
	if (value === ROOT_TARGET) {
		return { id: null, listKey: ROOT_TARGET, node: null, kind, input };
	}

	let node = await retrieveOrNull(client, value);

	if (!node && kind === "shortcut") {
		const targetId = await lookupShortcutTarget(client, value);
		if (targetId) {
			node = await retrieveOrNull(client, targetId);
		}
	}

	if (!node) {
		// `inbox` is documented for List but not for Retrieve, so a failed
		// retrieve still leaves a listable container.
		if (CONTAINER_TARGETS.has(value)) {
			return { id: null, listKey: value, node: null, kind, input };
		}
		throw new NodeNotFoundError(input);
	}

	return { id: node.id, listKey: node.id, node, kind, input };
}

/**
 * Returns the node body for an already-resolved identifier, retrieving it
 * only if resolution did not already have it in hand.
 */
export async function fetchResolvedNode(
	client: WorkflowyClient,
	resolved: ResolvedNodeId,
): Promise<WorkflowyNode> {
	if (resolved.node) return resolved.node;
	if (resolved.id === null) throw new NodeNotFoundError(resolved.input);

	const node = await retrieveOrNull(client, resolved.id);
	if (!node) throw new NodeNotFoundError(resolved.input);
	return node;
}
