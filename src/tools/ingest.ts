import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { promoteProperties } from "../neo4j/properties";
import type { Neo4jStatement } from "../neo4j/types";
import { err, ok, toolError } from "../shared/responses";
import type { SessionContext } from "../shared/types";

const BATCH_SIZE = 100;

// Each batch is one POST to the /tx/commit endpoint, which Neo4j runs as a
// single atomic transaction. Cross-batch atomicity via explicit /tx ...
// /tx/{id}/commit was considered and rejected: on Workers it adds subrequests,
// rollback plumbing, and sensitivity to Neo4j's transaction idle timeout.
// MERGE-based statements make retries safe, so on failure we report exactly
// which items committed and which remain instead.

export function registerIngestTool(server: McpServer, ctx: SessionContext) {
	const { neo4j } = ctx;

	server.tool(
		"ingest",
		`Bulk create entities and relationships. Use this instead of calling entity(create) in a loop.

WHEN TO USE: Whenever you need to create more than 2-3 entities. This batches operations for efficiency.

ACTIONS:
- entities: Create multiple entities at once. Each can include tags inline. Uses MERGE so re-running is safe (upserts).
- relationships: Create multiple typed relationships between existing entities. Entities must already exist by ID or name. Uses MERGE on (from, to, type) so re-running is safe; the response reports created vs skipped (already existed) vs unmatched (entity not found).

EPISTEMIC STATUS VALUES:
- grounded: Multiple corroborating sources or direct evidence support this entity.
- provisional: Single-source and unverified; the default for newly ingested entities.
- speculative: Inferred or weakly supported; based on reasoning rather than direct evidence.
- contested: Sources actively disagree about this entity's claims or classification.

Set epistemic_status and confidence per entity. If omitted, defaults to provisional / 0.5. The assessed_by field records who made the assessment (defaults to the ingest call's created_by).

WORKFLOW FOR DOCUMENT INGESTION:
1. Call ontology(describe) ONCE to see existing types. Do not call it repeatedly.
2. If you need new entity types or relationship types, create them all in one ontology(batch_create) call.
3. Read/analyze the source material yourself. Extract entities, concepts, facts, relationships.
4. Call ingest(entities) with ALL your extracted entities in a single call. Include tags inline per entity. Assign epistemic_status based on source quality.
5. Call ingest(relationships) with ALL relationships in a single call.
6. Optionally create a Source record and link entities to it for provenance.

ENTITY FORMAT: Each entity needs at minimum: name (string) and entity_type (string matching an existing type).
Optional: namespace, summary, content, properties (flat key-value object with string/number values), tags (array of tag name strings).

RELATIONSHIP FORMAT: Each needs: from_id or from_name, to_id or to_name, relationship_type (string matching an existing type).
Optional: properties (flat key-value object).

IMPORTANT: The properties field accepts an object like {"key": "value"} but values must be primitives (strings, numbers). No nested objects.`,
		{
			action: z.enum(["entities", "relationships"]),
			entities: z
				.array(
					z.object({
						id: z
							.string()
							.optional()
							.describe("Entity ID (auto-UUID if omitted)"),
						name: z.string(),
						entity_type: z.string(),
						namespace: z.string().optional(),
						summary: z.string().optional(),
						content: z.string().optional(),
						properties: z.record(z.string(), z.unknown()).optional(),
						epistemic_status: z
							.enum(["grounded", "provisional", "speculative", "contested"])
							.optional()
							.default("provisional")
							.describe("Epistemic status"),
						confidence: z
							.number()
							.min(0)
							.max(1)
							.optional()
							.default(0.5)
							.describe("Confidence score 0.0-1.0"),
						assessed_by: z
							.string()
							.optional()
							.describe(
								"Who assessed epistemic status (defaults to created_by)",
							),
						embedding: z
							.array(z.number())
							.optional()
							.describe("Embedding vector"),
						tags: z
							.array(z.string())
							.optional()
							.describe("Tag names to attach"),
					}),
				)
				.optional()
				.describe("Entities to create (for entities action)"),
			relationships: z
				.array(
					z.object({
						from_id: z.string().optional(),
						from_name: z.string().optional(),
						to_id: z.string().optional(),
						to_name: z.string().optional(),
						relationship_type: z.string(),
						properties: z.record(z.string(), z.unknown()).optional(),
					}),
				)
				.optional()
				.describe("Relationships to create (for relationships action)"),
			namespace: z
				.string()
				.optional()
				.describe("Default namespace for all entities"),
			created_by: z
				.string()
				.optional()
				.default("mcp:ingest")
				.describe("Provenance stamp for all created nodes"),
		},
		async (params) => {
			try {
				switch (params.action) {
					case "entities": {
						if (!params.entities?.length)
							return err("entities array is required");

						// Group each entity's MERGE with its tag statements so a batch
						// boundary never splits an entity from its tags.
						const groups: { ids: string[]; statements: Neo4jStatement[] }[] =
							[];
						const allIds: string[] = [];

						for (const e of params.entities) {
							const id = e.id ?? crypto.randomUUID();
							allIds.push(id);
							const promoted = promoteProperties(e.properties);
							const propSetClause = promoted.setClauses.length
								? `, e.prop_keys = $prop_keys, ${promoted.setClauses.join(", ")}`
								: ", e.prop_keys = $prop_keys";
							const statements: Neo4jStatement[] = [
								{
									statement: `MERGE (e:Entity {id: $id})
                  SET e.name = $name, e.entity_type = $entity_type,
                      e.namespace = $namespace, e.summary = $summary,
                      e.content = $content, e.properties = $properties,
                      e.embedding = $embedding, e.created_by = $created_by,
                      e.epistemic_status = $epistemic_status,
                      e.confidence = $confidence,
                      e.assessed_by = $assessed_by,
                      e.created_at = coalesce(e.created_at, datetime()),
                      e.updated_at = datetime()${propSetClause}
                  RETURN e.id`,
									parameters: {
										id,
										name: e.name,
										entity_type: e.entity_type,
										namespace: e.namespace ?? params.namespace ?? null,
										summary: e.summary ?? null,
										content: e.content ?? null,
										properties: e.properties
											? JSON.stringify(e.properties)
											: null,
										embedding: e.embedding ?? null,
										created_by: params.created_by,
										epistemic_status: e.epistemic_status,
										confidence: e.confidence,
										assessed_by: e.assessed_by ?? params.created_by,
										prop_keys: promoted.propKeys,
										...promoted.params,
									},
								},
							];
							for (const tag of e.tags ?? []) {
								statements.push({
									statement: `MATCH (e:Entity {id: $id})
                    MERGE (t:Tag {name: $tag})
                    MERGE (e)-[:TAGGED_WITH]->(t)`,
									parameters: { id, tag },
								});
							}
							groups.push({ ids: [id], statements });
						}

						// Flush batches at entity-group boundaries.
						const batches: { ids: string[]; statements: Neo4jStatement[] }[] =
							[];
						let current: { ids: string[]; statements: Neo4jStatement[] } = {
							ids: [],
							statements: [],
						};
						for (const g of groups) {
							if (
								current.statements.length > 0 &&
								current.statements.length + g.statements.length > BATCH_SIZE
							) {
								batches.push(current);
								current = { ids: [], statements: [] };
							}
							current.ids.push(...g.ids);
							current.statements.push(...g.statements);
						}
						if (current.statements.length) batches.push(current);

						const succeededIds: string[] = [];
						let statementCount = 0;
						for (let i = 0; i < batches.length; i++) {
							try {
								await neo4j.execute(batches[i].statements);
								succeededIds.push(...batches[i].ids);
								statementCount += batches[i].statements.length;
							} catch (error) {
								return ok({
									partial: true,
									ingested_count: succeededIds.length,
									succeeded_ids: succeededIds,
									failed_batch_index: i,
									failed_ids: batches[i].ids,
									remaining_count:
										params.entities.length -
										succeededIds.length -
										batches[i].ids.length,
									error: error instanceof Error ? error.message : String(error),
									suggestion:
										"Re-run ingest with only the failed and remaining entities; MERGE makes retries safe",
								});
							}
						}

						return ok({
							ingested: true,
							entity_count: params.entities.length,
							statement_count: statementCount,
							ids: allIds,
						});
					}

					case "relationships": {
						if (!params.relationships?.length)
							return err("relationships array is required");

						// MERGE keys on {type} only — properties is a JSON string and
						// would defeat idempotency if part of the merge key.
						const stmts: Neo4jStatement[] = params.relationships.map((r) => {
							const fromMatch = r.from_id
								? "MATCH (a:Entity {id: $from_id})"
								: "MATCH (a:Entity {name: $from_name})";
							const toMatch = r.to_id
								? "MATCH (b:Entity {id: $to_id})"
								: "MATCH (b:Entity {name: $to_name})";
							return {
								statement: `${fromMatch} ${toMatch}
                  MERGE (a)-[r:RELATES_TO {type: $rel_type}]->(b)
                  ON CREATE SET r.properties = $properties,
                                r.created_by = $created_by,
                                r.created_at = datetime(), r._new = true
                  WITH a, b, r, coalesce(r._new, false) AS was_created
                  REMOVE r._new
                  RETURN a.id, b.id, was_created`,
								parameters: {
									from_id: r.from_id ?? null,
									from_name: r.from_name ?? null,
									to_id: r.to_id ?? null,
									to_name: r.to_name ?? null,
									rel_type: r.relationship_type,
									properties: r.properties
										? JSON.stringify(r.properties)
										: null,
									created_by: params.created_by,
								},
							};
						});

						let created = 0;
						let skipped = 0;
						const unmatched: Array<{
							index: number;
							from: string;
							to: string;
						}> = [];
						const fanoutWarnings: Array<{
							index: number;
							from: string;
							to: string;
							edges: number;
						}> = [];
						let processed = 0;

						for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
							const batch = stmts.slice(i, i + BATCH_SIZE);
							let result: Awaited<ReturnType<typeof neo4j.execute>>;
							try {
								result = await neo4j.execute(batch);
							} catch (error) {
								return ok({
									partial: true,
									requested: params.relationships.length,
									created,
									skipped,
									unmatched,
									processed_count: processed,
									failed_batch_index: Math.floor(i / BATCH_SIZE),
									remaining_count: stmts.length - i,
									error: error instanceof Error ? error.message : String(error),
									suggestion:
										"Re-run ingest with the unprocessed relationships; MERGE makes retries safe",
								});
							}
							for (let j = 0; j < batch.length; j++) {
								const globalIndex = i + j;
								const r = params.relationships[globalIndex];
								const from = r.from_id ?? r.from_name ?? "";
								const to = r.to_id ?? r.to_name ?? "";
								const rows = neo4j.rows(result, j);
								if (rows.length === 0) {
									unmatched.push({ index: globalIndex, from, to });
								} else {
									// Name-based MATCH can hit multiple nodes with the same name
									if (rows.length > 1) {
										fanoutWarnings.push({
											index: globalIndex,
											from,
											to,
											edges: rows.length,
										});
									}
									for (const row of rows) {
										if (row[2] === true) created++;
										else skipped++;
									}
								}
								processed++;
							}
						}

						return ok({
							requested: params.relationships.length,
							created,
							skipped,
							unmatched,
							...(fanoutWarnings.length
								? {
										fanout_warnings: fanoutWarnings,
										fanout_note:
											"name-based matching hit multiple entities with the same name; one edge was merged per pair",
									}
								: {}),
							...(unmatched.length
								? {
										suggestion:
											"Unmatched entities do not exist; create them first with ingest(entities) or check the ids/names",
									}
								: {}),
						});
					}
				}
			} catch (error) {
				return toolError("Ingest", error);
			}
		},
	);
}
