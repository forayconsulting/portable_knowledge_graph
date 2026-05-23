import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Neo4jClient } from "../neo4j/client";

export function registerRelateTool(server: McpServer, env: Env) {
	const neo4j = new Neo4jClient(env);

	server.tool(
		"relate",
		`Create, query, or delete relationships between entities. Also manages tags and source links.

Relationship types are stored as a property on RELATES_TO edges (not as Neo4j relationship types).
This keeps the schema flexible — new relationship semantics are added by creating __Schema:RelType
nodes, not by changing Cypher.

Actions:
- create: Link two entities with a typed relationship. YOU decide the type and weight.
- query: Get all relationships for a node (filtered by type/direction).
- delete: Remove a specific relationship.
- tag: Tag an entity with a Tag node (creates TAGGED_WITH edge).
- untag: Remove a tag from an entity.
- source: Link an entity to a Source node (creates SOURCED_FROM edge with confidence).

For SIMILAR_TO edges, use the analyze tool's find_similar action instead — it computes
structural similarity. Or create SIMILAR_TO directly here if YOU have determined the similarity.`,
		{
			action: z.enum(["create", "query", "delete", "tag", "untag", "source"]),
			from_id: z.string().optional().describe("Source entity ID"),
			to_id: z.string().optional().describe("Target entity ID"),
			relationship_type: z
				.string()
				.optional()
				.describe("Relationship type (should match a __Schema:RelType)"),
			weight: z
				.number()
				.optional()
				.default(1.0)
				.describe("Relationship weight"),
			properties: z
				.record(z.string(), z.unknown())
				.optional()
				.describe("Edge properties"),
			created_by: z
				.string()
				.optional()
				.default("mcp:client")
				.describe("Provenance stamp"),
			node_id: z.string().optional().describe("Node ID for query action"),
			direction: z
				.enum(["outgoing", "incoming", "both"])
				.optional()
				.default("both"),
			filter_rel_type: z
				.string()
				.optional()
				.describe("Filter by relationship type"),
			entity_id: z
				.string()
				.optional()
				.describe("Entity ID for tag/untag/source actions"),
			tag_name: z.string().optional().describe("Tag name for tag/untag"),
			tag_group: z.string().optional().describe("Tag group for new tags"),
			source_id: z.string().optional().describe("Source ID for source action"),
			confidence: z
				.number()
				.optional()
				.default(1.0)
				.describe("Confidence for source link (0-1)"),
			excerpt: z.string().optional().describe("Text excerpt for source link"),
			limit: z.number().optional().default(50),
		},
		async (params) => {
			try {
				switch (params.action) {
					case "create": {
						if (!params.from_id || !params.to_id || !params.relationship_type)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: from_id, to_id, and relationship_type are required",
									},
								],
								isError: true,
							};
						await neo4j.query(
							`MATCH (a:Entity {id: $from_id}), (b:Entity {id: $to_id})
               CREATE (a)-[r:RELATES_TO {
                 type: $rel_type, weight: $weight,
                 properties: $properties, created_by: $created_by,
                 created_at: datetime()
               }]->(b)
               RETURN type(r)`,
							{
								from_id: params.from_id,
								to_id: params.to_id,
								rel_type: params.relationship_type,
								weight: params.weight,
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
									text: JSON.stringify({
										created: true,
										from: params.from_id,
										to: params.to_id,
										type: params.relationship_type,
									}),
								},
							],
						};
					}

					case "query": {
						if (!params.node_id)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: node_id is required for query",
									},
								],
								isError: true,
							};
						let cypher: string;
						if (params.direction === "outgoing") {
							cypher = `MATCH (e:Entity {id: $node_id})-[r:RELATES_TO]->(other:Entity)`;
						} else if (params.direction === "incoming") {
							cypher = `MATCH (e:Entity {id: $node_id})<-[r:RELATES_TO]-(other:Entity)`;
						} else {
							cypher = `MATCH (e:Entity {id: $node_id})-[r:RELATES_TO]-(other:Entity)`;
						}
						cypher += `
              WHERE $filter_rel_type IS NULL OR r.type = $filter_rel_type
              RETURN other.id, other.name, other.entity_type, r.type, r.weight,
                     r.properties, r.created_by,
                     CASE WHEN startNode(r) = e THEN 'outgoing' ELSE 'incoming' END AS direction
              LIMIT $limit`;
						const rows = await neo4j.query(cypher, {
							node_id: params.node_id,
							filter_rel_type: params.filter_rel_type ?? null,
							limit: params.limit,
						});
						const rels = rows.map(
							([id, name, type, relType, weight, props, by, dir]) => ({
								entity_id: id,
								entity_name: name,
								entity_type: type,
								relationship_type: relType,
								weight,
								properties: props,
								created_by: by,
								direction: dir,
							}),
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(rels, null, 2),
								},
							],
						};
					}

					case "delete": {
						if (!params.from_id || !params.to_id || !params.relationship_type)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: from_id, to_id, and relationship_type are required",
									},
								],
								isError: true,
							};
						const result = await neo4j.query(
							`MATCH (a:Entity {id: $from_id})-[r:RELATES_TO {type: $rel_type}]->(b:Entity {id: $to_id})
               DELETE r RETURN count(r) AS deleted`,
							{
								from_id: params.from_id,
								to_id: params.to_id,
								rel_type: params.relationship_type,
							},
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										deleted: (result[0]?.[0] as number) > 0,
									}),
								},
							],
						};
					}

					case "tag": {
						if (!params.entity_id || !params.tag_name)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: entity_id and tag_name are required",
									},
								],
								isError: true,
							};
						await neo4j.query(
							`MATCH (e:Entity {id: $entity_id})
               MERGE (t:Tag {name: $tag_name})
               ON CREATE SET t.tag_group = $tag_group
               MERGE (e)-[r:TAGGED_WITH]->(t)
               SET r.created_by = $created_by, r.created_at = datetime()
               RETURN t.name`,
							{
								entity_id: params.entity_id,
								tag_name: params.tag_name,
								tag_group: params.tag_group ?? null,
								created_by: params.created_by,
							},
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										tagged: true,
										entity: params.entity_id,
										tag: params.tag_name,
									}),
								},
							],
						};
					}

					case "untag": {
						if (!params.entity_id || !params.tag_name)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: entity_id and tag_name are required",
									},
								],
								isError: true,
							};
						await neo4j.query(
							`MATCH (e:Entity {id: $entity_id})-[r:TAGGED_WITH]->(t:Tag {name: $tag_name})
               DELETE r RETURN count(r)`,
							{
								entity_id: params.entity_id,
								tag_name: params.tag_name,
							},
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										untagged: true,
										entity: params.entity_id,
										tag: params.tag_name,
									}),
								},
							],
						};
					}

					case "source": {
						if (!params.entity_id || !params.source_id)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: entity_id and source_id are required",
									},
								],
								isError: true,
							};
						await neo4j.query(
							`MATCH (e:Entity {id: $entity_id}), (s:Source {id: $source_id})
               MERGE (e)-[r:SOURCED_FROM]->(s)
               SET r.confidence = $confidence, r.excerpt = $excerpt,
                   r.created_by = $created_by, r.created_at = datetime()
               RETURN s.name`,
							{
								entity_id: params.entity_id,
								source_id: params.source_id,
								confidence: params.confidence,
								excerpt: params.excerpt ?? null,
								created_by: params.created_by,
							},
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										linked: true,
										entity: params.entity_id,
										source: params.source_id,
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
							text: `Relate error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}
