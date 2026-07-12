const BASE_URL = "https://workflowy.com/api/v1";

export type LayoutMode =
	| "bullets"
	| "todo"
	| "h1"
	| "h2"
	| "h3"
	| "code-block"
	| "quote-block";

export interface WorkflowyNode {
	id: string;
	parent_id: string | null;
	name: string;
	note: string | null;
	priority: number;
	data?: { layoutMode?: LayoutMode };
	createdAt: number | null;
	modifiedAt: number | null;
	completedAt: number | null;
}

export class WorkflowyApiError extends Error {
	constructor(
		public status: number,
		public statusText: string,
		public body: string,
		message: string,
	) {
		super(message);
		this.name = "WorkflowyApiError";
	}
}

async function request<T>(
	apiKey: string,
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const resp = await fetch(`${BASE_URL}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			...init.headers,
		},
	});

	if (!resp.ok) {
		const body = await resp.text();
		throw new WorkflowyApiError(
			resp.status,
			resp.statusText,
			body,
			`Workflowy API error: ${resp.status} ${resp.statusText} - ${body}`,
		);
	}

	if (resp.status === 204) {
		return undefined as T;
	}

	return (await resp.json()) as T;
}

/**
 * Response shapes (verified against the official API reference):
 * - GET  /nodes-export           -> {"nodes": [...]}
 * - GET  /nodes?parent_id=...    -> {"nodes": [...]}
 * - GET  /nodes/:id              -> {"node": {...}}
 * - POST /nodes (create)         -> {"item_id": "..."}
 * - POST update/move/(un)complete -> {"status": "ok"}
 *
 * Write methods therefore re-fetch the node after a successful mutation so
 * callers always get the full node back for the optimistic D1 upsert.
 */
export class WorkflowyClient {
	constructor(private apiKey: string) {}

	async createNode(params: {
		parent_id: string;
		name: string;
		note?: string;
		layoutMode?: LayoutMode;
		position?: "top" | "bottom";
	}): Promise<WorkflowyNode> {
		const created = await request<{ item_id: string }>(this.apiKey, "/nodes", {
			method: "POST",
			body: JSON.stringify(params),
		});
		return this.getNode(created.item_id);
	}

	async updateNode(
		nodeId: string,
		params: { name?: string; note?: string; layoutMode?: LayoutMode },
	): Promise<WorkflowyNode> {
		await request(this.apiKey, `/nodes/${nodeId}`, {
			method: "POST",
			body: JSON.stringify(params),
		});
		return this.getNode(nodeId);
	}

	async getNode(nodeId: string): Promise<WorkflowyNode> {
		const data = await request<{ node: WorkflowyNode }>(this.apiKey, `/nodes/${nodeId}`);
		return data.node ?? (data as unknown as WorkflowyNode);
	}

	async listChildren(parentId: string): Promise<WorkflowyNode[]> {
		const data = await request<{ nodes: WorkflowyNode[] }>(
			this.apiKey,
			`/nodes?parent_id=${encodeURIComponent(parentId)}`,
		);
		return data.nodes ?? (data as unknown as WorkflowyNode[]);
	}

	async moveNode(
		nodeId: string,
		params: { parent_id: string; position?: "top" | "bottom" },
	): Promise<WorkflowyNode> {
		await request(this.apiKey, `/nodes/${nodeId}/move`, {
			method: "POST",
			body: JSON.stringify(params),
		});
		return this.getNode(nodeId);
	}

	async completeNode(nodeId: string): Promise<WorkflowyNode> {
		await request(this.apiKey, `/nodes/${nodeId}/complete`, {
			method: "POST",
		});
		return this.getNode(nodeId);
	}

	async uncompleteNode(nodeId: string): Promise<WorkflowyNode> {
		await request(this.apiKey, `/nodes/${nodeId}/uncomplete`, {
			method: "POST",
		});
		return this.getNode(nodeId);
	}

	async exportAllNodes(): Promise<WorkflowyNode[]> {
		const data = await request<{ nodes: WorkflowyNode[] }>(this.apiKey, "/nodes-export");
		return data.nodes ?? (data as unknown as WorkflowyNode[]);
	}

	async listTargets(): Promise<unknown> {
		return request(this.apiKey, "/targets");
	}
}
