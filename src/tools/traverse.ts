import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionContext } from "../shared/types";

export function registerTraverseTool(server: McpServer, ctx: SessionContext) {
	const { neo4j } = ctx;

	server.tool(
		"traverse",
		`Walk the graph from a starting entity to discover connected subgraphs.

Returns a neighborhood of nodes and edges within a hop radius. Uses APOC
apoc.path.subgraphAll when available, falls back to native Cypher variable-length paths.

Use this to:
- Explore what's connected to an entity
- Discover clusters and communities
- Map the local structure around a concept
- Follow relationship chains

The result is a subgraph: {nodes: [...], edges: [...]} suitable for visualization or analysis.
YOU decide what to do with the subgraph — the server just returns the raw structure.`,
		{
			start_id: z.string().describe("Entity ID or name to start from"),
			max_hops: z
				.number()
				.optional()
				.default(2)
				.describe("Max relationship hops (1-5)"),
			relationship_types: z
				.array(z.string())
				.optional()
				.describe("Filter to specific RELATES_TO type values"),
			entity_types: z
				.array(z.string())
				.optional()
				.describe("Filter to specific entity types"),
			namespace: z.string().optional().describe("Filter to namespace"),
			limit_nodes: z
				.number()
				.optional()
				.default(100)
				.describe("Max nodes to return"),
		},
		async ({
			start_id,
			max_hops,
			relationship_types,
			entity_types,
			namespace,
			limit_nodes,
		}) => {
			const hops = Math.min(Math.max(max_hops, 1), 5);

			try {
				// Try APOC first
				const rows = await neo4j.query(
					`MATCH (start:Entity) WHERE start.id = $id OR start.name = $id
           CALL apoc.path.subgraphAll(start, {maxLevel: $hops}) YIELD nodes, relationships
           UNWIND nodes AS n
           WITH CASE WHEN n:Entity THEN n ELSE null END AS entity,
                CASE WHEN n:Tag THEN n ELSE null END AS tag,
                CASE WHEN n:Source THEN n ELSE null END AS source,
                n, relationships
           WITH collect(DISTINCT CASE
             WHEN n:Entity THEN {
               id: n.id, name: n.name, entity_type: n.entity_type,
               namespace: n.namespace, summary: left(coalesce(n.summary, ''), 100),
               label: "Entity"
             }
             WHEN n:Tag THEN {
               id: n.name, name: n.name, entity_type: null,
               namespace: null, summary: null, label: "Tag"
             }
             WHEN n:Source THEN {
               id: n.id, name: n.name, entity_type: null,
               namespace: null, summary: n.source_type, label: "Source"
             }
             ELSE {
               id: coalesce(n.id, n.name, toString(id(n))),
               name: coalesce(n.name, ''), entity_type: null,
               namespace: null, summary: null,
               label: head(labels(n))
             }
           END)[0..$limit_nodes] AS nodeList, relationships
           UNWIND relationships AS rel
           WITH nodeList, collect(DISTINCT {
             type: type(rel),
             rel_type: CASE WHEN type(rel) = 'RELATES_TO' THEN rel.type ELSE type(rel) END,
             from: coalesce(startNode(rel).id, startNode(rel).name),
             to: coalesce(endNode(rel).id, endNode(rel).name)
           }) AS edgeList
           RETURN nodeList, edgeList`,
					{ id: start_id, hops, limit_nodes },
				);

				if (rows.length && (rows[0][0] as unknown[])?.length) {
					let nodes = rows[0][0] as Array<Record<string, unknown>>;
					let edges = rows[0][1] as Array<Record<string, unknown>>;

					if (entity_types?.length) {
						const typeSet = new Set(entity_types);
						nodes = nodes.filter(
							(n) =>
								n.label !== "Entity" || typeSet.has(n.entity_type as string),
						);
					}
					if (namespace) {
						nodes = nodes.filter(
							(n) => n.label !== "Entity" || n.namespace === namespace,
						);
					}
					if (relationship_types?.length) {
						const relSet = new Set(relationship_types);
						edges = edges.filter((e) => relSet.has(e.rel_type as string));
					}

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(
									{
										nodes,
										edges,
										node_count: nodes.length,
										edge_count: edges.length,
									},
									null,
									2,
								),
							},
						],
					};
				}

				// Fallback without APOC
				const fallback = await neo4j.query(
					`MATCH (start:Entity) WHERE start.id = $id OR start.name = $id
           MATCH path = (start)-[*1..${hops}]-(connected)
           WITH start, collect(DISTINCT connected) + [start] AS allNodes,
                [r IN reduce(acc = [], p IN collect(path) | acc + relationships(p)) | r] AS allRels
           UNWIND allNodes AS n
           WITH collect(DISTINCT {
             id: coalesce(n.id, n.name, toString(id(n))),
             name: coalesce(n.name, ''),
             entity_type: n.entity_type,
             namespace: n.namespace,
             summary: left(coalesce(n.summary, ''), 100),
             label: head(labels(n))
           })[0..$limit_nodes] AS nodes, allRels
           UNWIND allRels AS rel
           WITH nodes, collect(DISTINCT {
             type: type(rel),
             rel_type: CASE WHEN type(rel) = 'RELATES_TO' THEN rel.type ELSE type(rel) END,
             from: coalesce(startNode(rel).id, startNode(rel).name),
             to: coalesce(endNode(rel).id, endNode(rel).name)
           }) AS edges
           RETURN nodes, edges`,
					{ id: start_id, limit_nodes },
				);

				const nodes = (fallback[0]?.[0] ?? []) as Array<
					Record<string, unknown>
				>;
				const edges = (fallback[0]?.[1] ?? []) as Array<
					Record<string, unknown>
				>;
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									nodes,
									edges,
									node_count: nodes.length,
									edge_count: edges.length,
								},
								null,
								2,
							),
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Traverse error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}
