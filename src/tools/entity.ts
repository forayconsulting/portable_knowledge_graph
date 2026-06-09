import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	buildPropertyFilter,
	buildStalePropRemoval,
	promoteProperties,
} from "../neo4j/properties";
import {
	err,
	missingParams,
	ok,
	paginated,
	toolError,
} from "../shared/responses";
import type { SessionContext } from "../shared/types";

const ALL_ACTIONS = [
	"create",
	"get",
	"update",
	"delete",
	"list",
	"merge",
] as const;

const ACTION_DESCRIPTIONS: Record<string, string> = {
	create:
		"- create: Make a new entity. Requires name and entity_type at minimum. Returns the generated UUID.",
	get: '- get: Fetch a single entity by ID with all its tags and sources. Use detail: "compact" to omit content and properties.',
	update:
		"- update: Modify fields on an existing entity. Only sends the fields you include.",
	delete: "- delete: Remove an entity and all its relationships.",
	list: "- list: Browse entities with optional filters. Paginated; returns total_count and has_more.",
	merge:
		"- merge: Absorb a duplicate entity into another. Rewires all relationships, tags, and source links from merge_from_id onto id, then deletes merge_from_id. Use analyze(find_duplicates) to find candidates.",
};

const NOT_FOUND_SUGGESTION =
	"Use search or entity(list) to locate the correct entity id";

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
					"Entity ID (required for get/update/delete, auto-UUID on create; the surviving entity for merge)",
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
			detail: z
				.enum(["compact", "full"])
				.optional()
				.default("full")
				.describe(
					"Response detail for get/list. compact omits content and properties (get) or returns only id/name/entity_type (list).",
				),
			merge_from_id: z
				.string()
				.optional()
				.describe(
					"Entity to absorb and delete (for merge action; merged into id)",
				),
			fill_nulls: z
				.boolean()
				.optional()
				.default(true)
				.describe(
					"For merge: fill null fields on the surviving entity from the absorbed one",
				),
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
						return ok({ created: true, id });
					}

					case "get": {
						if (!params.id) return missingParams("get", ["id"]);
						const rows = await neo4j.query(
							`MATCH (e:Entity {id: $id})
               OPTIONAL MATCH (e)-[:TAGGED_WITH]->(t:Tag)
               OPTIONAL MATCH (e)-[:SOURCED_FROM]->(s:Source)
               RETURN e, collect(DISTINCT t.name) AS tags,
                      collect(DISTINCT {id: s.id, name: s.name}) AS sources`,
							{ id: params.id },
						);
						if (!rows.length)
							return err(`entity "${params.id}" not found`, {
								not_found: [`entity id "${params.id}"`],
								suggestion: NOT_FOUND_SUGGESTION,
							});
						const [entity, tags, rawSources] = rows[0] as [
							Record<string, unknown>,
							string[],
							Array<{ id: string | null; name: string | null }>,
						];
						// collect() over an unmatched OPTIONAL MATCH yields one
						// null-valued struct; drop it.
						const sources = rawSources.filter((s) => s.id !== null);
						// Never ship the raw embedding vector back to the client —
						// it is large and the client has no use for the floats.
						const { embedding, ...fields } = entity;
						const shaped: Record<string, unknown> = {
							...fields,
							has_embedding: embedding != null,
						};
						if (params.detail === "compact") {
							const content = shaped.content;
							delete shaped.content;
							delete shaped.properties;
							for (const key of Object.keys(shaped)) {
								if (key.startsWith("prop_")) delete shaped[key];
							}
							shaped.content_length =
								typeof content === "string" ? content.length : 0;
						}
						return ok({ ...shaped, tags, sources }, { pretty: true });
					}

					case "update": {
						if (!params.id) return missingParams("update", ["id"]);
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
							// Read the previous prop_keys so promoted properties that are
							// no longer present can be removed (set to null) rather than
							// accumulating forever. Also serves as the existence check.
							const prevRows = await neo4j.query(
								"MATCH (e:Entity {id: $id}) RETURN e.prop_keys",
								{ id: params.id },
							);
							if (!prevRows.length)
								return err(`entity "${params.id}" not found`, {
									not_found: [`entity id "${params.id}"`],
									suggestion: NOT_FOUND_SUGGESTION,
								});
							sets.push("e.properties = $properties");
							p.properties = JSON.stringify(params.properties);
							const promoted = promoteProperties(params.properties);
							sets.push("e.prop_keys = $prop_keys");
							p.prop_keys = promoted.propKeys;
							for (const clause of promoted.setClauses) {
								sets.push(clause);
							}
							Object.assign(p, promoted.params);
							const prevKeys = prevRows[0]?.[0] as string[] | null;
							sets.push(...buildStalePropRemoval(prevKeys, promoted.propKeys));
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
						const updatedRows = await neo4j.query(
							`MATCH (e:Entity {id: $id}) SET ${sets.join(", ")} RETURN e.id`,
							p,
						);
						if (!updatedRows.length)
							return err(`entity "${params.id}" not found`, {
								not_found: [`entity id "${params.id}"`],
								suggestion: NOT_FOUND_SUGGESTION,
							});
						return ok({ updated: true, id: params.id });
					}

					case "delete": {
						if (role !== "admin") {
							return err("Forbidden: delete requires admin role");
						}
						if (!params.id) return missingParams("delete", ["id"]);
						const rows = await neo4j.query(
							"MATCH (e:Entity {id: $id}) DETACH DELETE e RETURN count(e)",
							{ id: params.id },
						);
						const deleted = ((rows[0]?.[0] as number) ?? 0) > 0;
						if (!deleted)
							return err(`entity "${params.id}" not found`, {
								not_found: [`entity id "${params.id}"`],
								suggestion: NOT_FOUND_SUGGESTION,
							});
						return ok({ deleted: true, id: params.id });
					}

					case "merge": {
						// Merge DETACH DELETEs the absorbed entity, so it sits at the
						// same privilege tier as delete.
						if (role !== "admin") {
							return err("Forbidden: merge requires admin role");
						}
						if (!params.id || !params.merge_from_id)
							return missingParams("merge", ["id", "merge_from_id"]);
						if (params.id === params.merge_from_id)
							return err("id and merge_from_id must be different entities");

						const ids = { keep_id: params.id, drop_id: params.merge_from_id };
						// One POST = one atomic transaction. Every statement MATCHes
						// both entities so nothing partial happens if either is missing.
						const statements = [
							...(params.fill_nulls
								? [
										{
											statement: `MATCH (a:Entity {id: $keep_id}) MATCH (b:Entity {id: $drop_id})
                       SET a.summary = coalesce(a.summary, b.summary),
                           a.content = coalesce(a.content, b.content),
                           a.namespace = coalesce(a.namespace, b.namespace),
                           a.embedding = coalesce(a.embedding, b.embedding)
                       RETURN a.id`,
											parameters: ids,
										},
									]
								: []),
							{
								statement: `MATCH (a:Entity {id: $keep_id})
                 MATCH (b:Entity {id: $drop_id})-[r:RELATES_TO]->(t:Entity)
                 WHERE t.id <> $keep_id
                 MERGE (a)-[r2:RELATES_TO {type: r.type}]->(t)
                 ON CREATE SET r2.properties = r.properties,
                               r2.created_by = r.created_by,
                               r2.created_at = r.created_at
                 RETURN count(*) AS n`,
								parameters: ids,
							},
							{
								statement: `MATCH (a:Entity {id: $keep_id})
                 MATCH (s:Entity)-[r:RELATES_TO]->(b:Entity {id: $drop_id})
                 WHERE s.id <> $keep_id
                 MERGE (s)-[r2:RELATES_TO {type: r.type}]->(a)
                 ON CREATE SET r2.properties = r.properties,
                               r2.created_by = r.created_by,
                               r2.created_at = r.created_at
                 RETURN count(*) AS n`,
								parameters: ids,
							},
							{
								statement: `MATCH (a:Entity {id: $keep_id})
                 MATCH (b:Entity {id: $drop_id})-[:TAGGED_WITH]->(t:Tag)
                 MERGE (a)-[:TAGGED_WITH]->(t)
                 RETURN count(*) AS n`,
								parameters: ids,
							},
							{
								statement: `MATCH (a:Entity {id: $keep_id})
                 MATCH (b:Entity {id: $drop_id})-[r:SOURCED_FROM]->(s:Source)
                 MERGE (a)-[r2:SOURCED_FROM]->(s)
                 ON CREATE SET r2.confidence = r.confidence, r2.excerpt = r.excerpt
                 RETURN count(*) AS n`,
								parameters: ids,
							},
							{
								statement: `MATCH (a:Entity {id: $keep_id}) MATCH (b:Entity {id: $drop_id})
                 DETACH DELETE b RETURN 1`,
								parameters: ids,
							},
						];
						const result = await neo4j.execute(statements);
						const last = statements.length - 1;
						if (neo4j.rowCount(result, last) === 0) {
							const probe = await neo4j.execute([
								{
									statement: `OPTIONAL MATCH (a:Entity {id: $keep_id})
                   OPTIONAL MATCH (b:Entity {id: $drop_id})
                   RETURN a.id IS NOT NULL, b.id IS NOT NULL`,
									parameters: ids,
								},
							]);
							const [keepExists, dropExists] = (neo4j.rows(probe, 0)[0] ?? [
								false,
								false,
							]) as [boolean, boolean];
							const notFound: string[] = [];
							if (!keepExists) notFound.push(`id "${params.id}"`);
							if (!dropExists)
								notFound.push(`merge_from_id "${params.merge_from_id}"`);
							return err("merge aborted: entity not found", {
								not_found: notFound,
								suggestion: NOT_FOUND_SUGGESTION,
							});
						}
						const offset = params.fill_nulls ? 1 : 0;
						const countAt = (idx: number) =>
							(neo4j.rows(result, idx)[0]?.[0] as number) ?? 0;
						return ok({
							merged: true,
							kept: params.id,
							deleted: params.merge_from_id,
							rewired: {
								relates_to_out: countAt(offset),
								relates_to_in: countAt(offset + 1),
								tags: countAt(offset + 2),
								sources: countAt(offset + 3),
							},
						});
					}

					case "list": {
						const pf = buildPropertyFilter(params.property_filter, "e");
						const propWhere = pf.whereClauses.length
							? ` AND ${pf.whereClauses.join(" AND ")}`
							: "";
						const whereClause = `WHERE ($filter_type IS NULL OR e.entity_type = $filter_type)
                 AND ($filter_namespace IS NULL OR e.namespace = $filter_namespace)${propWhere}`;
						const filterParams = {
							filter_type: params.filter_type ?? null,
							filter_namespace: params.filter_namespace ?? null,
							...pf.params,
						};
						const result = await neo4j.execute([
							{
								statement: `MATCH (e:Entity) ${whereClause} RETURN count(e)`,
								parameters: filterParams,
							},
							{
								statement: `MATCH (e:Entity)
               ${whereClause}
               WITH e ORDER BY e.created_at DESC
               SKIP $offset LIMIT $limit
               OPTIONAL MATCH (e)-[:TAGGED_WITH]->(t:Tag)
               RETURN e.id, e.name, e.entity_type, e.namespace,
                      left(coalesce(e.summary, ''), 100),
                      collect(DISTINCT t.name) AS tags`,
								parameters: {
									...filterParams,
									offset: params.offset,
									limit: params.limit,
								},
							},
						]);
						const totalCount = (neo4j.rows(result, 0)[0]?.[0] as number) ?? 0;
						const entities = neo4j.rows(result, 1).map(
							params.detail === "compact"
								? ([id, name, type]) => ({ id, name, entity_type: type })
								: ([id, name, type, ns, summary, tags]) => ({
										id,
										name,
										entity_type: type,
										namespace: ns,
										summary,
										tags,
									}),
						);
						return paginated(entities, {
							total_count: totalCount,
							offset: params.offset,
							limit: params.limit,
							has_more: params.offset + entities.length < totalCount,
						});
					}

					default:
						return err(`Unknown action: ${params.action}`);
				}
			} catch (error) {
				return toolError("Entity", error);
			}
		},
	);
}
