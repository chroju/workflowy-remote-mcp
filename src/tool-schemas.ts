import { z } from "zod";

export const searchNodesSchema = {
	query: z.string().describe("検索クエリ文字列。ノードの name/note に対して全文検索する"),
	limit: z.number().int().min(1).max(100).default(20).describe("返す件数の上限"),
	include_completed: z
		.boolean()
		.default(false)
		.describe("完了済みノードも検索結果に含めるかどうか"),
};

export const getSubtreeSchema = {
	node_id: z.string().describe("起点となるノードの UUID"),
	max_depth: z.number().int().min(1).max(20).default(5).describe("再帰的に辿る最大深さ"),
};

export const getNodeSchema = {
	node_id: z.string().describe("取得するノードの UUID"),
};

export const createNodeSchema = {
	parent_id: z
		.string()
		.describe(
			'親ノードの UUID、または特殊ターゲット("inbox" / "today" / "tomorrow" / "YYYY-MM-DD" / "None"=ルート)',
		),
	name: z
		.string()
		.describe("ノード名。Markdown記法(**bold**, - [ ] todo, # 見出し など)がパースされる"),
	note: z.string().optional().describe("ノートのテキスト"),
	position: z.enum(["top", "bottom"]).optional().describe("兄弟内での挿入位置"),
};

export const updateNodeSchema = {
	node_id: z.string().describe("更新するノードの UUID"),
	name: z.string().optional().describe("新しいノード名"),
	note: z.string().optional().describe("新しいノートのテキスト"),
};

export const completeNodeSchema = {
	node_id: z.string().describe("完了にするノードの UUID"),
};

export const uncompleteNodeSchema = {
	node_id: z.string().describe("未完了に戻すノードの UUID"),
};

export const moveNodeSchema = {
	node_id: z.string().describe("移動するノードの UUID"),
	parent_id: z.string().describe("移動先の親ノードの UUID、または特殊ターゲット"),
	position: z.enum(["top", "bottom"]).optional().describe("移動先での挿入位置"),
};

export const syncNowSchema = {};
