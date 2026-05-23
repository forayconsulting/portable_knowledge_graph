import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Neo4jClient } from "../neo4j/client";

export function registerSearchTool(server: McpServer, env: Env) {
	const neo4j = new Neo4jClient(env);

	server.tool(
		"search",
		`Search the knowledge graph using full-text search. This is your ENTRY POINT for discovery.

Returns entities ranked by relevance with their tags and a text excerpt. Use filters to narrow results:
- entity_type: restrict to a specific type (e.g., "Concept", "Document", "Fact")
- namespace: restrict to a workspace partition
- tag: only entities tagged with a specific tag

WORKFLOW: Start with search to discover what exists, then use entity(get) for full details,
traverse() to explore neighborhoods, or relate(query) to see connections.

YOU are responsible for interpreting results and determining relevance — the server performs
keyword matching, not semantic understanding.`,
		{
			query: z.string().describe("Search keywords or phrase"),
			entity_type: z
				.string()
				.optional()
				.describe(
					'Filter to entity type (e.g., "Concept", "Document", "Fact", "Note")',
				),
			namespace: z.string().optional().describe("Filter to namespace"),
			tag: z
				.string()
				.optional()
				.describe("Filter to entities with this tag name"),
			limit: z.number().optional().default(20).describe("Max results (1-100)"),
			offset: z.number().optional().default(0).describe("Pagination offset"),
		},
		async ({ query, entity_type, namespace, tag, limit, offset }) => {
			try {
				const rows = await neo4j.query(
					`CALL db.index.fulltext.queryNodes("entity_search", $query)
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
           SKIP $offset LIMIT $limit`,
					{
						query,
						entity_type: entity_type ?? null,
						namespace: namespace ?? null,
						tag: tag ?? null,
						offset,
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
						{ type: "text" as const, text: JSON.stringify(results, null, 2) },
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Search error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}
