export interface VizNode {
	id: string;
	name: string;
	entity_type: string | null;
	namespace: string | null;
	summary: string;
	epistemic_status: string | null;
	confidence: number | null;
	created_at: string;
	created_by: string | null;
	degree: number;
	tags: string[];
}

export interface VizEdge {
	from: string;
	to: string;
	rel_type: string;
	created_at: string;
}

export interface Snapshot {
	nodes: VizNode[];
	edges: VizEdge[];
	has_more: boolean;
	next_cursor: string | null;
}

export interface Meta {
	graph_id: string;
	display_name: string;
	role: string;
	node_count: number;
	nodes_by_type: Record<string, number>;
	nodes_by_namespace: Record<string, number>;
	edges_by_type: Record<string, number>;
	tag_count: number;
	source_count: number;
}

export interface NodeDetail {
	properties: Record<string, unknown>;
	created_at: string;
	has_embedding: boolean;
	tags: Array<{ name: string; tag_group: string | null }>;
	sources: Array<{
		id: string;
		name: string;
		source_type: string | null;
		uri: string | null;
		confidence: number | null;
		excerpt: string | null;
	}>;
	relationships: Array<{
		rel_type: string;
		direction: "in" | "out";
		other_id: string;
		other_name: string;
		other_entity_type: string | null;
		created_at: string | null;
	}>;
}

export interface LiveEvent {
	id: string;
	seq?: number;
	ts: string;
	graph_id: string;
	email: string;
	tool: string;
	action?: string;
	args_preview?: string;
	node_ids: string[];
	edges: Array<{ from: string; to: string; rel_type?: string }>;
	cypher: Array<{ statement: string; params?: string }>;
	duration_ms: number;
	is_error: boolean;
}
