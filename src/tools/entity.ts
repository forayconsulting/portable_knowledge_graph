import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Neo4jClient } from "../neo4j/client";

export function registerEntityTool(server: McpServer, env: Env) {
	const neo4j = new Neo4jClient(env);

	server.tool(
		"entity",
		`CRUD operations for entities. Use this for individual entity operations. For bulk creation, use the ingest tool instead.

ACTIONS:
- create: Make a new entity. Requires name and entity_type at minimum. Returns the generated UUID.
- get: Fetch a single entity by ID with all its tags and sources.
- update: Modify fields on an existing entity. Only sends the fields you include.
- delete: Remove an entity and all its relationships.
- list: Browse entities with optional filters. Paginated.

ENTITY STRUCTURE:
- name: Human-readable label. This is full-text indexed so make it descriptive and searchable.
- entity_type: Must reference an existing __Schema:EntityType (e.g., "Concept", "Document", "Fact", "Note"). Call ontology(describe) first if you are unsure what types exist.
- namespace: Groups entities into a workspace. Use lowercase-hyphenated names like "engineering-docs" or "customer-research".
- summary: One to two sentence description. Full-text indexed. Keep it concise but informative.
- content: Long-form text body. Full-text indexed. Use for document text, detailed notes, etc.
- properties: Optional JSON object for structured metadata. Stored as a JSON string internally. Use flat key-value pairs with string/number values. Example: {"author": "Jane Smith", "year": 2024, "pages": 312}

IMPORTANT: You do not need to create entity types before creating entities if the type already exists. Call ontology(describe) once at the start to see available types. Only create new types if no existing type fits.`,
		{
			action: z.enum(["create", "get", "update", "delete", "list"]),
			id: z
				.string()
				.optional()
				.describe(
					"Entity ID (required for get/update/delete, auto-UUID on create)",
				),
			name: z.string().optional().describe("Human-readable name"),
			entity_type: z
				.string()
				.optional()
				.describe("Entity type (should match a __Schema:EntityType)"),
			namespace: z.string().optional().describe("Namespace partition"),
			summary: z.string().optional().describe("Short description"),
			content: z.string().optional().describe("Full text content"),
			properties: z
				.record(z.string(), z.unknown())
				.optional()
				.describe(
					'Structured metadata as flat key-value pairs. Values must be strings or numbers. Example: {"author": "Jane Smith", "year": 2024}. Stored as JSON string internally.',
				),
			created_by: z
				.string()
				.optional()
				.default("mcp:client")
				.describe("Provenance stamp (e.g., 'claude:session-abc')"),
			filter_type: z
				.string()
				.optional()
				.describe("Filter by entity_type (for list)"),
			filter_namespace: z
				.string()
				.optional()
				.describe("Filter by namespace (for list)"),
			limit: z.number().optional().default(50),
			offset: z.number().optional().default(0),
		},
		async (params) => {
			try {
				switch (params.action) {
					case "create": {
						const id = params.id ?? crypto.randomUUID();
						await neo4j.query(
							`CREATE (e:Entity {
                id: $id, name: $name, entity_type: $entity_type,
                namespace: $namespace, summary: $summary, content: $content,
                properties: $properties, created_by: $created_by,
                created_at: datetime(), updated_at: datetime()
              })
              RETURN e.id`,
							{
								id,
								name: params.name ?? "",
								entity_type: params.entity_type ?? "Note",
								namespace: params.namespace ?? null,
								summary: params.summary ?? null,
								content: params.content ?? null,
								properties: params.properties
									? JSON.stringify(params.properties)
									: null,
								created_by: params.created_by,
							},
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({ created: true, id }),
								},
							],
						};
					}

					case "get": {
						if (!params.id)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: id is required for get",
									},
								],
								isError: true,
							};
						const rows = await neo4j.query(
							`MATCH (e:Entity {id: $id})
               OPTIONAL MATCH (e)-[:TAGGED_WITH]->(t:Tag)
               OPTIONAL MATCH (e)-[:SOURCED_FROM]->(s:Source)
               RETURN e, collect(DISTINCT t.name) AS tags,
                      collect(DISTINCT {id: s.id, name: s.name}) AS sources`,
							{ id: params.id },
						);
						if (!rows.length)
							return {
								content: [
									{
										type: "text" as const,
										text: `Entity "${params.id}" not found`,
									},
								],
							};
						const [entity, tags, sources] = rows[0] as [
							Record<string, unknown>,
							string[],
							Array<{ id: string; name: string }>,
						];
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({ ...entity, tags, sources }, null, 2),
								},
							],
						};
					}

					case "update": {
						if (!params.id)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: id is required for update",
									},
								],
								isError: true,
							};
						const sets: string[] = ["e.updated_at = datetime()"];
						const p: Record<string, unknown> = { id: params.id };
						if (params.name !== undefined) {
							sets.push("e.name = $name");
							p.name = params.name;
						}
						if (params.entity_type !== undefined) {
							sets.push("e.entity_type = $entity_type");
							p.entity_type = params.entity_type;
						}
						if (params.namespace !== undefined) {
							sets.push("e.namespace = $namespace");
							p.namespace = params.namespace;
						}
						if (params.summary !== undefined) {
							sets.push("e.summary = $summary");
							p.summary = params.summary;
						}
						if (params.content !== undefined) {
							sets.push("e.content = $content");
							p.content = params.content;
						}
						if (params.properties !== undefined) {
							sets.push("e.properties = $properties");
							p.properties = JSON.stringify(params.properties);
						}
						await neo4j.query(
							`MATCH (e:Entity {id: $id}) SET ${sets.join(", ")} RETURN e.id`,
							p,
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({ updated: true, id: params.id }),
								},
							],
						};
					}

					case "delete": {
						if (!params.id)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: id is required for delete",
									},
								],
								isError: true,
							};
						await neo4j.query(
							"MATCH (e:Entity {id: $id}) DETACH DELETE e RETURN count(e)",
							{ id: params.id },
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({ deleted: true, id: params.id }),
								},
							],
						};
					}

					case "list": {
						const rows = await neo4j.query(
							`MATCH (e:Entity)
               WHERE ($filter_type IS NULL OR e.entity_type = $filter_type)
                 AND ($filter_namespace IS NULL OR e.namespace = $filter_namespace)
               OPTIONAL MATCH (e)-[:TAGGED_WITH]->(t:Tag)
               RETURN e.id, e.name, e.entity_type, e.namespace,
                      left(coalesce(e.summary, ''), 100),
                      collect(DISTINCT t.name) AS tags
               ORDER BY e.created_at DESC
               SKIP $offset LIMIT $limit`,
							{
								filter_type: params.filter_type ?? null,
								filter_namespace: params.filter_namespace ?? null,
								offset: params.offset,
								limit: params.limit,
							},
						);
						const entities = rows.map(
							([id, name, type, ns, summary, tags]) => ({
								id,
								name,
								entity_type: type,
								namespace: ns,
								summary,
								tags,
							}),
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(entities, null, 2),
								},
							],
						};
					}
				}
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Entity error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}
