import type { Role } from "./types";

export const ENTITY_ACTIONS: Record<Role, readonly string[]> = {
	reader: ["get", "list"],
	writer: ["create", "get", "update", "list"],
	admin: ["create", "get", "update", "delete", "list"],
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
