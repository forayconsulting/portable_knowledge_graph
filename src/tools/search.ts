import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildPropertyFilter } from "../neo4j/properties";
import { paginated, toolError } from "../shared/responses";
import type { SessionContext } from "../shared/types";

export function registerSearchTool(server: McpServer, ctx: SessionContext) {
	const { neo4j } = ctx;

	server.tool(
		"search",
		`Search the knowledge graph using full-text search. This is your ENTRY POINT for discovery.

Returns entities ranked by relevance with their tags and a text excerpt. Use filters to narrow results:
- entity_type: restrict to a specific type (e.g., "Concept", "Document", "Fact")
- namespace: restrict to a workspace partition
- tag: only entities tagged with a specific tag
- property_filter: filter by promoted properties (e.g., {"author": "Jane Smith"})

WORKFLOW: Start with search to discover what exists, then use entity(get) for full details,
traverse() to explore neighborhoods, or relate(query) to see connections.

This tool performs keyword matching. For semantic similarity search using embedding vectors,
use the vector_search tool instead.`,
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
			property_filter: z
				.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
				.optional()
				.describe(
					'Filter by promoted properties. Keys are property names without the prop_ prefix. Example: {"author": "Jane Smith"}',
				),
			limit: z.number().optional().default(20).describe("Max results (1-100)"),
			offset: z.number().optional().default(0).describe("Pagination offset"),
		},
		async ({
			query,
			entity_type,
			namespace,
			tag,
			property_filter,
			limit,
			offset,
		}) => {
			try {
				const pf = buildPropertyFilter(property_filter, "node");
				const propWhere = pf.whereClauses.length
					? ` AND ${pf.whereClauses.join(" AND ")}`
					: "";
				const rows = await neo4j.query(
					`CALL db.index.fulltext.queryNodes("entity_search", $query)
           YIELD node, score
           WHERE ($entity_type IS NULL OR node.entity_type = $entity_type)
             AND ($namespace IS NULL OR node.namespace = $namespace)${propWhere}
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
						// limit + 1 to detect more pages. A true total_count would
						// re-run the full-text query (tag filtering happens after
						// collect), so it is intentionally omitted here.
						limit: limit + 1,
						...pf.params,
					},
				);

				const hasMore = rows.length > limit;
				const results = rows
					.slice(0, limit)
					.map(([id, name, type, ns, excerpt, tags, score]) => ({
						id,
						name,
						entity_type: type,
						namespace: ns,
						excerpt,
						tags,
						score,
					}));

				return paginated(results, { offset, limit, has_more: hasMore });
			} catch (error) {
				return toolError("Search", error);
			}
		},
	);
}
