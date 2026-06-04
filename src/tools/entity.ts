import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildPropertyFilter, promoteProperties } from "../neo4j/properties";
import type { SessionContext } from "../shared/types";

const ALL_ACTIONS = ["create", "get", "update", "delete", "list"] as const;

const ACTION_DESCRIPTIONS: Record<string, string> = {
	create:
		"- create: Make a new entity. Requires name and entity_type at minimum. Returns the generated UUID.",
	get: "- get: Fetch a single entity by ID with all its tags and sources.",
	update:
		"- update: Modify fields on an existing entity. Only sends the fields you include.",
	delete: "- delete: Remove an entity and all its relationships.",
	list: "- list: Browse entities with optional filters. Paginated.",
};

export function registerEntityTool(
	server: McpServer,
	ctx: SessionContext,
	allowedActions?: readonly string[],
) {
	const { neo4j, role } = ctx;
	const actions = allowedActions ?? ALL_ACTIONS;
	const actionDocs = actions.map((a) => ACTION_DESCRIPTIONS[a]).join("\n");

	server.tool(
		"entity",
		`CRUD operations for entities. Use this for individual entity operations. For bulk creation, use the ingest tool instead.

ACTIONS:
${actionDocs}

ENTITY STRUCTURE:
- name: Human-readable label. This is full-text indexed so make it descriptive and searchable.
- entity_type: Must reference an existing __Schema:EntityType (e.g., "Concept", "Document", "Fact", "Note"). Call ontology(describe) first if you are unsure what types exist.
- namespace: Groups entities into a workspace. Use lowercase-hyphenated names like "engineering-docs" or "customer-research".
- summary: One to two sentence description. Full-text indexed. Keep it concise but informative.
- content: Long-form text body. Full-text indexed. Use for document text, detailed notes, etc.
- properties: Optional JSON object for structured metadata. Flat key-value pairs with string/number/boolean values are promoted to queryable node properties (prefixed with prop_). Example: {"author": "Jane Smith", "year": 2024, "pages": 312}
- epistemic_status: One of "grounded", "provisional", "speculative", "contested". Defaults to "provisional".
- confidence: Float from 0.0 to 1.0. Defaults to 0.5.
- assessed_by: Who assessed the epistemic status. Defaults to the value of created_by.

IMPORTANT: You do not need to create entity types before creating entities if the type already exists. Call ontology(describe) once at the start to see available types. Only create new types if no existing type fits.`,
		{
			action: z.enum(actions as unknown as [string, ...string[]]),
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
			epistemic_status: z
				.enum(["grounded", "provisional", "speculative", "contested"])
				.optional()
				.default("provisional")
				.describe(
					"Epistemic status: grounded, provisional, speculative, or contested",
				),
			confidence: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.default(0.5)
				.describe("Confidence score from 0.0 to 1.0"),
			assessed_by: z
				.string()
				.optional()
				.describe("Who assessed the epistemic status (defaults to created_by)"),
			embedding: z
				.array(z.number())
				.optional()
				.describe(
					"Embedding vector (e.g. 1536-dim float array from text-embedding-3-small). Client-supplied; server stores and queries it via vector_search.",
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
			property_filter: z
				.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
				.optional()
				.describe(
					'Filter by promoted properties (for list). Keys are property names without the prop_ prefix. Example: {"author": "Jane Smith"}',
				),
			limit: z.number().optional().default(50),
			offset: z.number().optional().default(0),
		},
		async (params) => {
			try {
				switch (params.action) {
					case "create": {
						const id = params.id ?? crypto.randomUUID();
						const promoted = promoteProperties(params.properties);
						const propSetClause = [
							"e.prop_keys = $prop_keys",
							...promoted.setClauses,
						].join(", ");
						await neo4j.query(
							`CREATE (e:Entity {
                id: $id, name: $name, entity_type: $entity_type,
                namespace: $namespace, summary: $summary, content: $content,
                properties: $properties, embedding: $embedding,
                created_by: $created_by,
                epistemic_status: $epistemic_status, confidence: $confidence,
                assessed_by: $assessed_by,
                created_at: datetime(), updated_at: datetime()
              })
              SET ${propSetClause}
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
								embedding: params.embedding ?? null,
								created_by: params.created_by,
								epistemic_status: params.epistemic_status,
								confidence: params.confidence,
								assessed_by: params.assessed_by ?? params.created_by,
								prop_keys: promoted.propKeys,
								...promoted.params,
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
							const promoted = promoteProperties(params.properties);
							sets.push("e.prop_keys = $prop_keys");
							p.prop_keys = promoted.propKeys;
							for (const clause of promoted.setClauses) {
								sets.push(clause);
							}
							Object.assign(p, promoted.params);
						}
						if (params.epistemic_status !== undefined) {
							sets.push("e.epistemic_status = $epistemic_status");
							p.epistemic_status = params.epistemic_status;
						}
						if (params.confidence !== undefined) {
							sets.push("e.confidence = $confidence");
							p.confidence = params.confidence;
						}
						if (params.assessed_by !== undefined) {
							sets.push("e.assessed_by = $assessed_by");
							p.assessed_by = params.assessed_by;
						}
						if (params.embedding !== undefined) {
							sets.push("e.embedding = $embedding");
							p.embedding = params.embedding;
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
						if (role !== "admin") {
							return {
								content: [
									{
										type: "text" as const,
										text: "Forbidden: delete requires admin role",
									},
								],
								isError: true,
							};
						}
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
						const pf = buildPropertyFilter(params.property_filter, "e");
						const propWhere = pf.whereClauses.length
							? ` AND ${pf.whereClauses.join(" AND ")}`
							: "";
						const rows = await neo4j.query(
							`MATCH (e:Entity)
               WHERE ($filter_type IS NULL OR e.entity_type = $filter_type)
                 AND ($filter_namespace IS NULL OR e.namespace = $filter_namespace)${propWhere}
               WITH e ORDER BY e.created_at DESC
               SKIP $offset LIMIT $limit
               OPTIONAL MATCH (e)-[:TAGGED_WITH]->(t:Tag)
               RETURN e.id, e.name, e.entity_type, e.namespace,
                      left(coalesce(e.summary, ''), 100),
                      collect(DISTINCT t.name) AS tags`,
							{
								filter_type: params.filter_type ?? null,
								filter_namespace: params.filter_namespace ?? null,
								offset: params.offset,
								limit: params.limit,
								...pf.params,
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

					default:
						return {
							content: [
								{
									type: "text" as const,
									text: `Unknown action: ${params.action}`,
								},
							],
							isError: true,
						};
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
