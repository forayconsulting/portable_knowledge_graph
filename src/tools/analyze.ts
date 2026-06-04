import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SessionContext } from "../shared/types";

export function registerAnalyzeTool(server: McpServer, ctx: SessionContext) {
	const { neo4j } = ctx;

	server.tool(
		"analyze",
		`Run structural graph analytics. No AI — just Cypher-based analysis.

Actions:
- stats: Full graph statistics (node/edge counts by type, namespace, top tags)
- shortest_path: Find shortest path between two entities
- neighbors: Degree analysis — which entities have the most connections
- find_similar: Find entities sharing N+ tags (structural similarity)
- epistemic_gaps: Find provisional entities with no SOURCED_FROM edge — candidates for verification
- bridges: Find entities with RELATES_TO edges crossing namespace boundaries — reveals cross-domain concepts
- search_similar: Find semantically similar entities using stored embedding vectors. Pass an entity_id; its embedding is used as the query vector. No embedding generation needed.

These are structural queries except search_similar, which uses vector embeddings.`,
		{
			action: z.enum([
				"stats",
				"shortest_path",
				"neighbors",
				"find_similar",
				"epistemic_gaps",
				"bridges",
				"search_similar",
			]),
			from_id: z.string().optional().describe("Start entity for shortest_path"),
			to_id: z.string().optional().describe("End entity for shortest_path"),
			max_depth: z.number().optional().default(10).describe("Max path length"),
			entity_type: z
				.string()
				.optional()
				.describe("Filter by entity type (neighbors)"),
			namespace: z.string().optional().describe("Filter by namespace"),
			entity_id: z
				.string()
				.optional()
				.describe("Entity to find similar entities for"),
			min_shared_tags: z
				.number()
				.optional()
				.default(2)
				.describe("Minimum shared tags for find_similar"),
			min_namespaces: z
				.number()
				.optional()
				.default(2)
				.describe("Minimum foreign namespaces reached (bridges)"),
			limit: z.number().optional().default(20),
		},
		async (params) => {
			try {
				switch (params.action) {
					case "stats": {
						const result = await neo4j.execute([
							{
								statement: `MATCH (e:Entity)
                  WITH e.entity_type AS type, count(e) AS cnt
                  RETURN type, cnt ORDER BY cnt DESC`,
							},
							{
								statement: `MATCH ()-[r:RELATES_TO]->()
                  WITH r.type AS type, count(r) AS cnt
                  RETURN type, cnt ORDER BY cnt DESC`,
							},
							{
								statement: `MATCH (t:Tag)<-[:TAGGED_WITH]-(e:Entity)
                  WITH t.name AS tag, t.tag_group AS grp, count(e) AS cnt
                  RETURN tag, grp, cnt ORDER BY cnt DESC LIMIT 50`,
							},
							{
								statement: `MATCH (e:Entity) WHERE e.namespace IS NOT NULL
                  WITH e.namespace AS ns, count(e) AS cnt
                  RETURN ns, cnt ORDER BY cnt DESC`,
							},
							{
								statement: `MATCH (n) RETURN count(n) AS total_nodes
                  UNION ALL MATCH ()-[r]->() RETURN count(r) AS total_nodes`,
							},
						]);

						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										{
											entities_by_type: neo4j
												.rows(result, 0)
												.map(([t, c]) => ({ type: t, count: c })),
											relationships_by_type: neo4j
												.rows(result, 1)
												.map(([t, c]) => ({ type: t, count: c })),
											top_tags: neo4j
												.rows(result, 2)
												.map(([t, g, c]) => ({ tag: t, group: g, count: c })),
											namespaces: neo4j
												.rows(result, 3)
												.map(([n, c]) => ({ namespace: n, count: c })),
											totals: {
												nodes: neo4j.rows(result, 4)[0]?.[0] ?? 0,
												edges: neo4j.rows(result, 4)[1]?.[0] ?? 0,
											},
										},
										null,
										2,
									),
								},
							],
						};
					}

					case "shortest_path": {
						if (!params.from_id || !params.to_id)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: from_id and to_id are required",
									},
								],
								isError: true,
							};
						const rows = await neo4j.query(
							`MATCH (a:Entity {id: $from_id}), (b:Entity {id: $to_id}),
                     path = shortestPath((a)-[*..${Math.min(params.max_depth, 15)}]-(b))
               RETURN [n IN nodes(path) | {
                 id: coalesce(n.id, n.name),
                 name: coalesce(n.name, ''),
                 label: head(labels(n))
               }] AS nodes,
               [r IN relationships(path) | {
                 type: type(r),
                 rel_type: CASE WHEN type(r) = 'RELATES_TO' THEN r.type ELSE type(r) END
               }] AS edges,
               length(path) AS hops`,
							{ from_id: params.from_id, to_id: params.to_id },
						);
						if (!rows.length)
							return {
								content: [
									{
										type: "text" as const,
										text: JSON.stringify({
											found: false,
											message: "No path exists",
										}),
									},
								],
							};
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										{
											found: true,
											hops: rows[0][2],
											nodes: rows[0][0],
											edges: rows[0][1],
										},
										null,
										2,
									),
								},
							],
						};
					}

					case "neighbors": {
						const rows = await neo4j.query(
							`MATCH (e:Entity)
               WHERE ($entity_type IS NULL OR e.entity_type = $entity_type)
                 AND ($namespace IS NULL OR e.namespace = $namespace)
               OPTIONAL MATCH (e)-[r]-()
               WITH e, count(r) AS degree
               RETURN e.id, e.name, e.entity_type, e.namespace, degree
               ORDER BY degree DESC
               LIMIT $limit`,
							{
								entity_type: params.entity_type ?? null,
								namespace: params.namespace ?? null,
								limit: params.limit,
							},
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										rows.map(([id, name, type, ns, degree]) => ({
											id,
											name,
											entity_type: type,
											namespace: ns,
											degree,
										})),
										null,
										2,
									),
								},
							],
						};
					}

					case "find_similar": {
						if (!params.entity_id)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: entity_id is required for find_similar",
									},
								],
								isError: true,
							};
						const rows = await neo4j.query(
							`MATCH (e:Entity {id: $entity_id})-[:TAGGED_WITH]->(t:Tag)<-[:TAGGED_WITH]-(other:Entity)
               WHERE other.id <> $entity_id
               WITH other, collect(DISTINCT t.name) AS shared_tags, count(DISTINCT t) AS shared_count
               WHERE shared_count >= $min_shared
               OPTIONAL MATCH (other)-[:TAGGED_WITH]->(ot:Tag)
               WITH other, shared_tags, shared_count, count(DISTINCT ot) AS total_tags
               RETURN other.id, other.name, other.entity_type, other.namespace,
                      shared_tags, shared_count,
                      toFloat(shared_count) / toFloat(total_tags) AS similarity
               ORDER BY shared_count DESC, similarity DESC
               LIMIT $limit`,
							{
								entity_id: params.entity_id,
								min_shared: params.min_shared_tags,
								limit: params.limit,
							},
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										rows.map(([id, name, type, ns, tags, count, sim]) => ({
											id,
											name,
											entity_type: type,
											namespace: ns,
											shared_tags: tags,
											shared_count: count,
											similarity: sim,
										})),
										null,
										2,
									),
								},
							],
						};
					}

					case "bridges": {
						const rows = await neo4j.query(
							`MATCH (e:Entity)-[:RELATES_TO]-(other:Entity)
               WHERE other.namespace <> e.namespace
                 AND e.namespace IS NOT NULL
                 AND other.namespace IS NOT NULL
                 AND ($namespace IS NULL OR e.namespace = $namespace)
               WITH e, collect(DISTINCT other.namespace) AS foreign_namespaces
               WITH e, foreign_namespaces, size(foreign_namespaces) AS ns_count
               WHERE ns_count >= $min_namespaces
               RETURN e.id, e.name, e.entity_type, e.namespace,
                      ns_count, foreign_namespaces
               ORDER BY ns_count DESC
               LIMIT $limit`,
							{
								namespace: params.namespace ?? null,
								min_namespaces: params.min_namespaces,
								limit: params.limit,
							},
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										rows.map(([id, name, type, ns, nsCount, connectedNs]) => ({
											id,
											name,
											entity_type: type,
											namespace: ns,
											namespaces_reached: nsCount,
											connected_namespaces: connectedNs,
										})),
										null,
										2,
									),
								},
							],
						};
					}

					case "epistemic_gaps": {
						const gapRows = await neo4j.query(
							`MATCH (e:Entity)
               WHERE e.epistemic_status = "provisional"
                 AND NOT (e)-[:SOURCED_FROM]->(:Source)
                 AND ($namespace IS NULL OR e.namespace = $namespace)
               RETURN e.id, e.name, e.entity_type, e.namespace,
                      e.epistemic_status, e.confidence, e.assessed_by,
                      e.created_at
               ORDER BY e.created_at ASC
               LIMIT $limit`,
							{
								namespace: params.namespace ?? null,
								limit: params.limit,
							},
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										gapRows.map(
											([
												id,
												name,
												type,
												ns,
												status,
												conf,
												assessor,
												created,
											]) => ({
												id,
												name,
												entity_type: type,
												namespace: ns,
												epistemic_status: status,
												confidence: conf,
												assessed_by: assessor,
												created_at: created,
											}),
										),
										null,
										2,
									),
								},
							],
						};
					}

					case "search_similar": {
						if (!params.entity_id)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: entity_id is required for search_similar",
									},
								],
								isError: true,
							};
						const embRow = await neo4j.query(
							"MATCH (e:Entity {id: $entity_id}) RETURN e.embedding",
							{ entity_id: params.entity_id },
						);
						if (!embRow.length || !embRow[0][0])
							return {
								content: [
									{
										type: "text" as const,
										text: JSON.stringify({
											error: "no_embedding",
											message: `Entity "${params.entity_id}" has no stored embedding vector`,
										}),
									},
								],
								isError: true,
							};
						const embedding = embRow[0][0] as number[];
						const rows = await neo4j.query(
							`CALL db.index.vector.queryNodes("entity_embedding", $k, $embedding)
               YIELD node, score
               WHERE node.id <> $entity_id
                 AND ($entity_type IS NULL OR node.entity_type = $entity_type)
                 AND ($namespace IS NULL OR node.namespace = $namespace)
               RETURN node.id, node.name, node.entity_type, node.namespace,
                      left(coalesce(node.summary, ''), 150), score
               ORDER BY score DESC
               LIMIT $limit`,
							{
								embedding,
								k: (params.limit ?? 20) * 2,
								entity_id: params.entity_id,
								entity_type: params.entity_type ?? null,
								namespace: params.namespace ?? null,
								limit: params.limit,
							},
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										rows.map(([id, name, type, ns, summary, score]) => ({
											id,
											name,
											entity_type: type,
											namespace: ns,
											summary,
											similarity: score,
										})),
										null,
										2,
									),
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
							text: `Analyze error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}
