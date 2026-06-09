import type { Role } from "./types";

export const ENTITY_ACTIONS: Record<Role, readonly string[]> = {
	reader: ["get", "list"],
	writer: ["create", "get", "update", "list"],
	// merge DETACH DELETEs the absorbed entity, so it sits at delete's tier
	admin: ["create", "get", "update", "delete", "list", "merge"],
};

const ANALYZE_ALL = [
	"stats",
	"shortest_path",
	"neighbors",
	"find_similar",
	"epistemic_gaps",
	"bridges",
	"search_similar",
	"validate",
	"find_duplicates",
] as const;

// All analyze actions are read-only, so every role gets the full set.
export const ANALYZE_ACTIONS: Record<Role, readonly string[]> = {
	reader: ANALYZE_ALL,
	writer: ANALYZE_ALL,
	admin: ANALYZE_ALL,
};

export const RELATE_ACTIONS: Record<Role, readonly string[]> = {
	reader: ["query"],
	writer: ["create", "query", "tag", "source"],
	admin: ["create", "query", "delete", "tag", "untag", "source"],
};

export const SOURCE_ACTIONS: Record<Role, readonly string[]> = {
	reader: ["get", "list", "trace"],
	writer: ["create", "get", "list", "link", "trace"],
	admin: ["create", "get", "list", "link", "trace"],
};

export const ONTOLOGY_ACTIONS: Record<Role, readonly string[]> = {
	reader: ["describe"],
	writer: [
		"describe",
		"batch_create",
		"create_type",
		"create_rel_type",
		"create_tag_group",
		"create_namespace",
	],
	admin: [
		"describe",
		"batch_create",
		"create_type",
		"create_rel_type",
		"create_tag_group",
		"create_namespace",
	],
};

export const NAMESPACE_ACTIONS: Record<Role, readonly string[]> = {
	reader: ["list", "stats"],
	writer: ["list", "create", "stats"],
	admin: ["list", "create", "stats", "delete"],
};

export const TOOL_ACCESS: Record<string, readonly Role[]> = {
	search: ["reader", "writer", "admin"],
	traverse: ["reader", "writer", "admin"],
	analyze: ["reader", "writer", "admin"],
	ingest: ["writer", "admin"],
	admin: ["admin"],
};
