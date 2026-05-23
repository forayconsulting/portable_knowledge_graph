import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Neo4jClient } from "../neo4j/client";
import type { Neo4jStatement } from "../neo4j/types";

export function registerOntologyTool(server: McpServer, env: Env) {
	const neo4j = new Neo4jClient(env);

	server.tool(
		"ontology",
		`View and manage the graph's schema. Call describe ONCE at the start of any ingestion to see what types exist.

ACTIONS:
- describe: Returns all entity types, relationship types, tag groups, and namespaces with instance counts. Call this FIRST before creating anything.
- batch_create: Create multiple entity types, relationship types, tag groups, and/or a namespace in ONE call. Use this instead of calling create_type repeatedly.
- create_type: Create a single entity type. Prefer batch_create when adding more than one.
- create_rel_type: Create a single relationship type. Prefer batch_create when adding more than one.
- create_tag_group: Create a single tag group.
- create_namespace: Create a single namespace.

TYPICAL INGESTION WORKFLOW:
1. Call ontology(describe) once. Review the existing types.
2. Decide which new types you need (if any). Many documents fit the built-in types: Concept, Document, Fact, Note.
3. If you need new types, call ontology(batch_create) with ALL new types in one call.
4. Proceed to ingest(entities) and ingest(relationships).

DO NOT call create_type or create_rel_type in a loop. Use batch_create to create everything at once.

BUILT-IN ENTITY TYPES: Concept, Document, Fact, Note
BUILT-IN RELATIONSHIP TYPES: CONTAINS, REFERENCES, SUPPORTS, CONTRADICTS, DEPENDS_ON, CAUSED_BY, PRECEDES`,
		{
			action: z.enum([
				"describe",
				"batch_create",
				"create_type",
				"create_rel_type",
				"create_tag_group",
				"create_namespace",
			]),
			name: z
				.string()
				.optional()
				.describe("Name for a single type/group/namespace"),
			description: z.string().optional().describe("Description"),
			property_hints: z
				.string()
				.optional()
				.describe("Hints about expected properties (for entity types)"),
			from_types: z
				.array(z.string())
				.optional()
				.describe("Allowed source entity types (for rel types)"),
			to_types: z
				.array(z.string())
				.optional()
				.describe("Allowed target entity types (for rel types)"),
			entity_types: z
				.array(
					z.object({
						name: z.string(),
						description: z.string().optional(),
						property_hints: z.string().optional(),
					}),
				)
				.optional()
				.describe("Entity types to create (for batch_create)"),
			rel_types: z
				.array(
					z.object({
						name: z.string(),
						description: z.string().optional(),
						from_types: z.array(z.string()).optional(),
						to_types: z.array(z.string()).optional(),
					}),
				)
				.optional()
				.describe("Relationship types to create (for batch_create)"),
			tag_groups: z
				.array(
					z.object({
						name: z.string(),
						description: z.string().optional(),
					}),
				)
				.optional()
				.describe("Tag groups to create (for batch_create)"),
			namespace_name: z
				.string()
				.optional()
				.describe("Namespace to create (for batch_create)"),
			namespace_description: z
				.string()
				.optional()
				.describe("Namespace description (for batch_create)"),
		},
		async (params) => {
			try {
				switch (params.action) {
					case "describe": {
						const result = await neo4j.execute([
							{
								statement: `MATCH (m:__Schema:EntityType)
                  OPTIONAL MATCH (e:Entity) WHERE e.entity_type = m.name
                  RETURN m.name, m.description, m.property_hints, count(e) AS count
                  ORDER BY count DESC`,
							},
							{
								statement: `MATCH (m:__Schema:RelType)
                  OPTIONAL MATCH ()-[r:RELATES_TO]->() WHERE r.type = m.name
                  RETURN m.name, m.description, m.from_types, m.to_types, count(r) AS count
                  ORDER BY count DESC`,
							},
							{
								statement: `MATCH (m:__Schema:TagGroup)
                  OPTIONAL MATCH (t:Tag) WHERE t.tag_group = m.name
                  RETURN m.name, m.description, count(t) AS count
                  ORDER BY count DESC`,
							},
							{
								statement: `MATCH (m:__Schema:Namespace)
                  OPTIONAL MATCH (e:Entity) WHERE e.namespace = m.name
                  RETURN m.name, m.description, count(e) AS count
                  ORDER BY count DESC`,
							},
							{
								statement: `MATCH (e:Entity) RETURN count(e) AS total_entities
                  UNION ALL MATCH (t:Tag) RETURN count(t) AS total_entities
                  UNION ALL MATCH (s:Source) RETURN count(s) AS total_entities
                  UNION ALL MATCH ()-[r:RELATES_TO]->() RETURN count(r) AS total_entities
                  UNION ALL MATCH ()-[r:TAGGED_WITH]->() RETURN count(r) AS total_entities
                  UNION ALL MATCH ()-[r:SOURCED_FROM]->() RETURN count(r) AS total_entities
                  UNION ALL MATCH ()-[r:SIMILAR_TO]->() RETURN count(r) AS total_entities`,
							},
						]);

						const entityTypes = neo4j
							.rows(result, 0)
							.map(([name, desc, hints, count]) => ({
								name,
								description: desc,
								property_hints: hints,
								count,
							}));
						const relTypes = neo4j
							.rows(result, 1)
							.map(([name, desc, from, to, count]) => ({
								name,
								description: desc,
								from_types: from,
								to_types: to,
								count,
							}));
						const tagGroups = neo4j
							.rows(result, 2)
							.map(([name, desc, count]) => ({
								name,
								description: desc,
								count,
							}));
						const namespaces = neo4j
							.rows(result, 3)
							.map(([name, desc, count]) => ({
								name,
								description: desc,
								count,
							}));
						const totals = neo4j.rows(result, 4).map((r) => r[0] as number);

						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										{
											entity_types: entityTypes,
											relationship_types: relTypes,
											tag_groups: tagGroups,
											namespaces,
											totals: {
												entities: totals[0] ?? 0,
												tags: totals[1] ?? 0,
												sources: totals[2] ?? 0,
												relates_to_edges: totals[3] ?? 0,
												tagged_with_edges: totals[4] ?? 0,
												sourced_from_edges: totals[5] ?? 0,
												similar_to_edges: totals[6] ?? 0,
											},
										},
										null,
										2,
									),
								},
							],
						};
					}

					case "batch_create": {
						const stmts: Neo4jStatement[] = [];
						const created: Array<{ type: string; name: string }> = [];

						for (const et of params.entity_types ?? []) {
							stmts.push({
								statement: `MERGE (m:__Schema:EntityType {name: $name})
                  SET m.description = $description,
                      m.property_hints = $property_hints,
                      m.created_at = coalesce(m.created_at, datetime())`,
								parameters: {
									name: et.name,
									description: et.description ?? "",
									property_hints: et.property_hints ?? "",
								},
							});
							created.push({ type: "EntityType", name: et.name });
						}
						for (const rt of params.rel_types ?? []) {
							stmts.push({
								statement: `MERGE (m:__Schema:RelType {name: $name})
                  SET m.description = $description,
                      m.from_types = $from_types,
                      m.to_types = $to_types,
                      m.created_at = coalesce(m.created_at, datetime())`,
								parameters: {
									name: rt.name,
									description: rt.description ?? "",
									from_types: rt.from_types ?? ["*"],
									to_types: rt.to_types ?? ["*"],
								},
							});
							created.push({ type: "RelType", name: rt.name });
						}
						for (const tg of params.tag_groups ?? []) {
							stmts.push({
								statement: `MERGE (m:__Schema:TagGroup {name: $name})
                  SET m.description = $description,
                      m.created_at = coalesce(m.created_at, datetime())`,
								parameters: {
									name: tg.name,
									description: tg.description ?? "",
								},
							});
							created.push({ type: "TagGroup", name: tg.name });
						}
						if (params.namespace_name) {
							stmts.push({
								statement: `MERGE (m:__Schema:Namespace {name: $name})
                  SET m.description = $description,
                      m.created_at = coalesce(m.created_at, datetime())`,
								parameters: {
									name: params.namespace_name,
									description: params.namespace_description ?? "",
								},
							});
							created.push({
								type: "Namespace",
								name: params.namespace_name,
							});
						}

						if (!stmts.length)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: provide entity_types, rel_types, tag_groups, or namespace_name",
									},
								],
								isError: true,
							};

						await neo4j.execute(stmts);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										created: true,
										count: created.length,
										items: created,
									}),
								},
							],
						};
					}

					case "create_type": {
						if (!params.name)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: name is required",
									},
								],
								isError: true,
							};
						await neo4j.query(
							`MERGE (m:__Schema:EntityType {name: $name})
               SET m.description = $description,
                   m.property_hints = $property_hints,
                   m.created_at = coalesce(m.created_at, datetime())
               RETURN m.name`,
							{
								name: params.name,
								description: params.description ?? "",
								property_hints: params.property_hints ?? "",
							},
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										created: true,
										type: "EntityType",
										name: params.name,
									}),
								},
							],
						};
					}

					case "create_rel_type": {
						if (!params.name)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: name is required",
									},
								],
								isError: true,
							};
						await neo4j.query(
							`MERGE (m:__Schema:RelType {name: $name})
               SET m.description = $description,
                   m.from_types = $from_types,
                   m.to_types = $to_types,
                   m.created_at = coalesce(m.created_at, datetime())
               RETURN m.name`,
							{
								name: params.name,
								description: params.description ?? "",
								from_types: params.from_types ?? ["*"],
								to_types: params.to_types ?? ["*"],
							},
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										created: true,
										type: "RelType",
										name: params.name,
									}),
								},
							],
						};
					}

					case "create_tag_group": {
						if (!params.name)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: name is required",
									},
								],
								isError: true,
							};
						await neo4j.query(
							`MERGE (m:__Schema:TagGroup {name: $name})
               SET m.description = $description,
                   m.created_at = coalesce(m.created_at, datetime())
               RETURN m.name`,
							{
								name: params.name,
								description: params.description ?? "",
							},
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										created: true,
										type: "TagGroup",
										name: params.name,
									}),
								},
							],
						};
					}

					case "create_namespace": {
						if (!params.name)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: name is required",
									},
								],
								isError: true,
							};
						await neo4j.query(
							`MERGE (m:__Schema:Namespace {name: $name})
               SET m.description = $description,
                   m.created_at = coalesce(m.created_at, datetime())
               RETURN m.name`,
							{
								name: params.name,
								description: params.description ?? "",
							},
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										created: true,
										type: "Namespace",
										name: params.name,
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
							text: `Ontology error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}
