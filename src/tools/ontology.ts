import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Neo4jClient } from "../neo4j/client";

export function registerOntologyTool(server: McpServer, env: Env) {
	const neo4j = new Neo4jClient(env);

	server.tool(
		"ontology",
		`View and manage the graph's self-describing schema.

The ontology is stored IN the graph as __Schema nodes. This is how you learn what the graph
contains and how to extend it for new domains.

Actions:
- describe: Full schema dump — all entity types, relationship types, tag groups, namespaces,
  each with a count of how many instances exist. START HERE to understand the graph.
- create_type: Define a new entity type (e.g., "Person", "Project", "Bug Report")
- create_rel_type: Define a new relationship type (e.g., "EMPLOYS", "BLOCKS", "AUTHORED")
- create_tag_group: Define a new tag grouping (e.g., "technology", "priority", "status")
- create_namespace: Define a new workspace partition

When YOU need to ingest knowledge for a new domain:
1. Call ontology(describe) to see what exists
2. Determine what new types are needed
3. Call create_type/create_rel_type to extend the schema
4. Then use entity/relate/ingest to add data using your new types`,
		{
			action: z.enum([
				"describe",
				"create_type",
				"create_rel_type",
				"create_tag_group",
				"create_namespace",
			]),
			name: z
				.string()
				.optional()
				.describe("Name for the new type/group/namespace"),
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
