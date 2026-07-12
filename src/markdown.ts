import type { LayoutMode } from "./workflowy-client";

/**
 * Strips inline HTML tags from Workflowy node text, leaving plain text
 * suitable for FTS indexing.
 */
export function stripHtml(input: string | null | undefined): string {
	if (!input) return "";
	return input
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/?[a-z][^>]*>/gi, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#039;/g, "'")
		.trim();
}

/**
 * Converts Workflowy's inline HTML (<b>, <i>, <s>, <code>, <a>) to Markdown
 * equivalents. Unsupported tags are stripped.
 */
export function htmlToMarkdown(input: string | null | undefined): string {
	if (!input) return "";
	let text = input;

	text = text.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, "[$2]($1)");
	text = text.replace(/<b>(.*?)<\/b>/gi, "**$1**");
	text = text.replace(/<strong>(.*?)<\/strong>/gi, "**$1**");
	text = text.replace(/<i>(.*?)<\/i>/gi, "*$1*");
	text = text.replace(/<em>(.*?)<\/em>/gi, "*$1*");
	text = text.replace(/<s>(.*?)<\/s>/gi, "~~$1~~");
	text = text.replace(/<strike>(.*?)<\/strike>/gi, "~~$1~~");
	text = text.replace(/<code>(.*?)<\/code>/gi, "`$1`");
	text = text.replace(/<br\s*\/?>/gi, "\n");

	// Strip any remaining/unsupported tags.
	text = text.replace(/<\/?[a-z][^>]*>/gi, "");

	text = text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#039;/g, "'");

	return text;
}

export interface RenderableNode {
	id: string;
	parent_id: string | null;
	name: string;
	note: string | null;
	priority: number;
	layout_mode: LayoutMode | string;
	completed_at: number | null;
}

export interface RenderSubtreeOptions {
	maxDepth?: number;
	maxNodes?: number;
	includeCompleted?: boolean;
}

/**
 * Renders a node and its descendants (fetched via `getChildren`) as nested
 * Markdown. The root node is rendered as an H1 heading; descendants become
 * nested bullet lists per the layoutMode-driven rules described in the
 * project spec.
 */
export async function renderSubtreeMarkdown(
	root: RenderableNode,
	getChildren: (parentId: string) => Promise<RenderableNode[]>,
	options: RenderSubtreeOptions = {},
): Promise<{ markdown: string; truncated: boolean; nodeCount: number }> {
	const maxDepth = options.maxDepth ?? 5;
	const maxNodes = options.maxNodes ?? 500;
	const includeCompleted = options.includeCompleted ?? true;

	let nodeCount = 1;
	let truncated = false;

	const lines: string[] = [];
	lines.push(`# ${htmlToMarkdown(root.name)}`);
	if (root.note) {
		lines.push("");
		lines.push(htmlToMarkdown(root.note));
	}

	async function walk(parentId: string, depth: number, indent: string): Promise<void> {
		if (depth > maxDepth || truncated) return;

		const children = await getChildren(parentId);
		const sorted = [...children].sort((a, b) => a.priority - b.priority);

		for (const child of sorted) {
			if (!includeCompleted && child.completed_at) continue;

			if (nodeCount >= maxNodes) {
				truncated = true;
				return;
			}
			nodeCount++;

			lines.push(renderNodeLine(child, indent));
			if (child.note) {
				lines.push(`${indent}  ${htmlToMarkdown(child.note)}`);
			}

			await walk(child.id, depth + 1, `${indent}  `);
			if (truncated) return;
		}
	}

	await walk(root.id, 1, "");

	if (truncated) {
		lines.push("");
		lines.push(`_(打ち切り: ノード数が上限 ${maxNodes} 件を超えたため以降は省略されました)_`);
	}

	return { markdown: lines.join("\n"), truncated, nodeCount };
}

function renderNodeLine(node: RenderableNode, indent: string): string {
	const text = htmlToMarkdown(node.name);
	const completed = Boolean(node.completed_at);
	const body = completed ? `~~${text}~~` : text;

	switch (node.layout_mode) {
		case "todo":
			return `${indent}- [${completed ? "x" : " "}] ${text}`;
		case "h1":
		case "h2":
		case "h3":
			return `${indent}- **${body}**`;
		case "code-block":
			return `${indent}- \`\`\`\n${indent}  ${text}\n${indent}  \`\`\``;
		case "quote-block":
			return `${indent}- > ${body}`;
		default:
			return `${indent}- ${body}`;
	}
}
