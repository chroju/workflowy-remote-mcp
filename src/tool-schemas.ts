import { z } from "zod";

/**
 * Every node_id / parent_id accepts the same identifier vocabulary, resolved
 * by src/node-id.ts. Kept in one constant so the description stays in sync
 * across tools.
 */
const NODE_IDENTIFIER_DESC =
	'ノード識別子。UUID / 12桁ショートID / Workflowy の URL ("https://workflowy.com/#/xxxxxxxxxxxx") / カレンダーターゲット ("today" / "tomorrow" / "next_week" / "calendar" / "YYYY" / "YYYY-MM" / "YYYY-MM-DD") / "inbox" / "None"(アウトラインのトップレベル) / ユーザー定義のショートカットキー が使える';

export const searchNodesSchema = {
	query: z.string().describe("検索クエリ文字列。ノードの name/note に対して全文検索する"),
	limit: z.number().int().min(1).max(100).default(20).describe("返す件数の上限"),
	include_completed: z
		.boolean()
		.default(false)
		.describe("完了済みノードも検索結果に含めるかどうか"),
};

export const getSubtreeSchema = {
	node_id: z.string().describe(`起点となる${NODE_IDENTIFIER_DESC}`),
	max_depth: z.number().int().min(1).max(20).default(5).describe("再帰的に辿る最大深さ"),
};

export const getNodeSchema = {
	node_id: z.string().describe(`取得する${NODE_IDENTIFIER_DESC}`),
};

export const createNodeSchema = {
	parent_id: z.string().describe(`親となる${NODE_IDENTIFIER_DESC}`),
	name: z
		.string()
		.describe("ノード名。Markdown記法(**bold**, - [ ] todo, # 見出し など)がパースされる"),
	note: z.string().optional().describe("ノートのテキスト"),
	position: z.enum(["top", "bottom"]).optional().describe("兄弟内での挿入位置"),
};

export const updateNodeSchema = {
	node_id: z.string().describe(`更新する${NODE_IDENTIFIER_DESC}`),
	name: z.string().optional().describe("新しいノード名"),
	note: z.string().optional().describe("新しいノートのテキスト"),
};

export const completeNodeSchema = {
	node_id: z.string().describe(`完了にする${NODE_IDENTIFIER_DESC}`),
};

export const uncompleteNodeSchema = {
	node_id: z.string().describe(`未完了に戻す${NODE_IDENTIFIER_DESC}`),
};

export const moveNodeSchema = {
	node_id: z.string().describe(`移動する${NODE_IDENTIFIER_DESC}`),
	parent_id: z.string().describe(`移動先の親となる${NODE_IDENTIFIER_DESC}`),
	position: z.enum(["top", "bottom"]).optional().describe("移動先での挿入位置"),
};

export const syncNowSchema = {};
