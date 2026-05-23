import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Neo4jClient } from "../neo4j/client";
import type { Neo4jStatement } from "../neo4j/types";

const BATCH_SIZE = 100;

export function registerIngestTool(server: McpServer, env: Env) {
	const neo4j = new Neo4jClient(env);

	server.tool(
		"ingest",
		`Bulk create entities and relationships. Use this instead of calling entity(create) in a loop.

WHEN TO USE: Whenever you need to create more than 2-3 entities. This batches operations for efficiency.

ACTIONS:
- entities: Create multiple entities at once. Each can include tags inline. Uses MERGE so re-running is safe (upserts).
- relationships: Create multiple typed relationships between existing entities. Entities must already exist by ID or name.

WORKFLOW FOR DOCUMENT INGESTION:
1. Call ontology(describe) ONCE to see existing types. Do not call it repeatedly.
2. If you need new entity types or relationship types, create them all in one ontology(batch_create) call.
3. Read/analyze the source material yourself. Extract entities, concepts, facts, relationships.
4. Call ingest(entities) with ALL your extracted entities in a single call. Include tags inline per entity.
5. Call ingest(relationships) with ALL relationships in a single call.
6. Optionally create a Source record and link entities to it for provenance.

ENTITY FORMAT: Each entity needs at minimum: name (string) and entity_type (string matching an existing type).
Optional: namespace, summary, content, properties (flat key-value object with string/number values), tags (array of tag name strings).

RELATIONSHIP FORMAT: Each needs: from_id or from_name, to_id or to_name, relationship_type (string matching an existing type).
Optional: weight (float, default 1.0), properties (flat key-value object).

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
						weight: z.number().optional(),
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
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: entities array is required",
									},
								],
								isError: true,
							};

						const allStatements: Neo4jStatement[] = [];
						const ids: string[] = [];

						for (const e of params.entities) {
							const id = e.id ?? crypto.randomUUID();
							ids.push(id);
							allStatements.push({
								statement: `MERGE (e:Entity {id: $id})
                  SET e.name = $name, e.entity_type = $entity_type,
                      e.namespace = $namespace, e.summary = $summary,
                      e.content = $content, e.properties = $properties,
                      e.created_by = $created_by,
                      e.created_at = coalesce(e.created_at, datetime()),
                      e.updated_at = datetime()
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
									created_by: params.created_by,
								},
							});
							for (const tag of e.tags ?? []) {
								allStatements.push({
									statement: `MATCH (e:Entity {id: $id})
                    MERGE (t:Tag {name: $tag})
                    MERGE (e)-[:TAGGED_WITH]->(t)`,
									parameters: { id, tag },
								});
							}
						}

						// Execute in batches
						for (let i = 0; i < allStatements.length; i += BATCH_SIZE) {
							await neo4j.execute(allStatements.slice(i, i + BATCH_SIZE));
						}

						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										ingested: true,
										entity_count: params.entities.length,
										statement_count: allStatements.length,
										ids,
									}),
								},
							],
						};
					}

					case "relationships": {
						if (!params.relationships?.length)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: relationships array is required",
									},
								],
								isError: true,
							};

						const stmts: Neo4jStatement[] = params.relationships.map((r) => {
							const fromMatch = r.from_id
								? "MATCH (a:Entity {id: $from_id})"
								: "MATCH (a:Entity {name: $from_name})";
							const toMatch = r.to_id
								? "MATCH (b:Entity {id: $to_id})"
								: "MATCH (b:Entity {name: $to_name})";
							return {
								statement: `${fromMatch} ${toMatch}
                  CREATE (a)-[:RELATES_TO {
                    type: $rel_type, weight: $weight,
                    properties: $properties, created_by: $created_by,
                    created_at: datetime()
                  }]->(b)
                  RETURN a.id, b.id`,
								parameters: {
									from_id: r.from_id ?? null,
									from_name: r.from_name ?? null,
									to_id: r.to_id ?? null,
									to_name: r.to_name ?? null,
									rel_type: r.relationship_type,
									weight: r.weight ?? 1.0,
									properties: r.properties
										? JSON.stringify(r.properties)
										: null,
									created_by: params.created_by,
								},
							};
						});

						for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
							await neo4j.execute(stmts.slice(i, i + BATCH_SIZE));
						}

						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										ingested: true,
										relationship_count: params.relationships.length,
									}),
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
							text: `Ingest error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}
