import { z } from "zod";

/**
 * Every node_id / parent_id accepts the same identifier vocabulary, resolved
 * by src/node-id.ts. Kept in one constant so the description stays in sync
 * across tools.
 */
const NODE_IDENTIFIER_DESC =
	'node identifier. Accepts a UUID, a 12-character short id, a Workflowy URL ("https://workflowy.com/#/xxxxxxxxxxxx"), a calendar target ("today" / "tomorrow" / "next_week" / "calendar" / "YYYY" / "YYYY-MM" / "YYYY-MM-DD"), "inbox", "None" (the top level of the outline), or a user-defined shortcut key';

export const searchNodesSchema = {
	query: z.string().describe("Search query. Matched full-text against node name and note."),
	limit: z.number().int().min(1).max(100).default(20).describe("Maximum number of results."),
	include_completed: z
		.boolean()
		.default(false)
		.describe("Whether to include completed nodes in the results."),
};

export const getSubtreeSchema = {
	node_id: z.string().describe(`Starting ${NODE_IDENTIFIER_DESC}.`),
	max_depth: z.number().int().min(1).max(20).default(5).describe("Maximum depth to walk."),
};

export const getNodeSchema = {
	node_id: z.string().describe(`The ${NODE_IDENTIFIER_DESC} to fetch.`),
};

export const createNodeSchema = {
	parent_id: z.string().describe(`Parent ${NODE_IDENTIFIER_DESC}.`),
	name: z
		.string()
		.describe(
			"Node name. Markdown syntax (**bold**, - [ ] todo, # heading, and so on) is parsed.",
		),
	note: z.string().optional().describe("Note text."),
	position: z.enum(["top", "bottom"]).optional().describe("Insert position among siblings."),
};

export const updateNodeSchema = {
	node_id: z.string().describe(`The ${NODE_IDENTIFIER_DESC} to update.`),
	name: z.string().optional().describe("New node name."),
	note: z.string().optional().describe("New note text."),
};

export const completeNodeSchema = {
	node_id: z.string().describe(`The ${NODE_IDENTIFIER_DESC} to complete.`),
};

export const uncompleteNodeSchema = {
	node_id: z.string().describe(`The ${NODE_IDENTIFIER_DESC} to uncomplete.`),
};

export const moveNodeSchema = {
	node_id: z.string().describe(`The ${NODE_IDENTIFIER_DESC} to move.`),
	parent_id: z.string().describe(`Destination parent ${NODE_IDENTIFIER_DESC}.`),
	position: z.enum(["top", "bottom"]).optional().describe("Insert position at the destination."),
};

export const syncNowSchema = {};
