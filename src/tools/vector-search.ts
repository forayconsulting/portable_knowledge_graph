import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionContext } from "../shared/types";

export function registerVectorSearchTool(
	server: McpServer,
	ctx: SessionContext,
) {
	const { neo4j } = ctx;

	server.tool(
		"vector_search",
		`Find semantically similar entities using vector embeddings.

Requires entities to have embedding vectors stored (1536-dim float arrays, e.g. from
text-embedding-3-small). The CLIENT supplies both stored embeddings and query vectors.
The server performs NO embedding generation.

Workflow:
1. When creating entities, generate an embedding for the entity's text and pass it
   via the embedding parameter on entity(create) or ingest(entities).
2. To search, generate an embedding for your query text and pass it here as query_embedding.

Returns entities ranked by cosine similarity. Filters can narrow results by entity_type,
namespace, or tag.

Falls back gracefully if the vector index does not exist or no entities have embeddings.`,
		{
			query_embedding: z
				.array(z.number())
				.describe(
					"Query embedding vector (must match index dimensions, default 1536)",
				),
			entity_type: z.string().optional().describe("Filter to entity type"),
			namespace: z.string().optional().describe("Filter to namespace"),
			tag: z
				.string()
				.optional()
				.describe("Filter to entities with this tag name"),
			limit: z.number().optional().default(10).describe("Max results (1-50)"),
		},
		async ({ query_embedding, entity_type, namespace, tag, limit }) => {
			try {
				const k = Math.min(limit * 2, 100);
				const rows = await neo4j.query(
					`CALL db.index.vector.queryNodes("entity_embedding", $k, $embedding)
           YIELD node, score
           WHERE ($entity_type IS NULL OR node.entity_type = $entity_type)
             AND ($namespace IS NULL OR node.namespace = $namespace)
           WITH node, score
           OPTIONAL MATCH (node)-[:TAGGED_WITH]->(t:Tag)
           WITH node, score, collect(DISTINCT t.name) AS tags
           WHERE $tag IS NULL OR $tag IN tags
           RETURN node.id AS id, node.name AS name, node.entity_type AS type,
                  node.namespace AS namespace,
                  left(coalesce(node.summary, node.content, ''), 200) AS excerpt,
                  tags, score
           ORDER BY score DESC
           LIMIT $limit`,
					{
						embedding: query_embedding,
						k,
						entity_type: entity_type ?? null,
						namespace: namespace ?? null,
						tag: tag ?? null,
						limit,
					},
				);

				const results = rows.map(
					([id, name, type, ns, excerpt, tags, score]) => ({
						id,
						name,
						entity_type: type,
						namespace: ns,
						excerpt,
						tags,
						score,
					}),
				);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(results, null, 2),
						},
					],
				};
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				if (
					msg.includes("index") &&
					(msg.includes("not found") || msg.includes("does not exist"))
				) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: "vector_index_not_available",
									message:
										"The entity_embedding vector index does not exist. Run bootstrap to create it (requires Neo4j 5.13+).",
								}),
							},
						],
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `Vector search error: ${msg}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}
