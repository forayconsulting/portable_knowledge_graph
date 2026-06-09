import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { err, missingParams, ok, toolError } from "../shared/responses";
import type { SessionContext } from "../shared/types";

const ALL_ACTIONS = [
	"stats",
	"shortest_path",
	"neighbors",
	"find_similar",
	"epistemic_gaps",
	"bridges",
	"search_similar",
	"validate",
	"find_duplicates",
] as const;

const ACTION_DESCRIPTIONS: Record<string, string> = {
	stats:
		"- stats: Full graph statistics (node/edge counts by type, namespace, top tags)",
	shortest_path: "- shortest_path: Find shortest path between two entities",
	neighbors:
		"- neighbors: Degree analysis — which entities have the most connections",
	find_similar:
		"- find_similar: Find entities sharing N+ tags (structural similarity)",
	epistemic_gaps:
		"- epistemic_gaps: Find provisional entities with no SOURCED_FROM edge — candidates for verification",
	bridges:
		"- bridges: Find entities with RELATES_TO edges crossing namespace boundaries — reveals cross-domain concepts",
	search_similar:
		"- search_similar: Find semantically similar entities using stored embedding vectors. Pass an entity_id; its embedding is used as the query vector. No embedding generation needed.",
	validate:
		"- validate: Detect schema drift — entity types, relationship types, and namespaces used in the graph but missing from the __Schema ontology, plus stale promoted properties.",
	find_duplicates:
		"- find_duplicates: Find entities with the same normalized name (candidate duplicates). Review the groups and use entity(merge) to consolidate true duplicates.",
};

export function registerAnalyzeTool(
	server: McpServer,
	ctx: SessionContext,
	allowedActions?: readonly string[],
) {
	const { neo4j } = ctx;
	const actions = allowedActions ?? ALL_ACTIONS;
	const actionDocs = actions.map((a) => ACTION_DESCRIPTIONS[a]).join("\n");

	server.tool(
		"analyze",
		`Run structural graph analytics. No AI — just Cypher-based analysis.

Actions:
${actionDocs}

These are structural queries except search_similar, which uses vector embeddings.`,
		{
			action: z.enum(actions as unknown as [string, ...string[]]),
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
			match_type: z
				.boolean()
				.optional()
				.default(false)
				.describe(
					"For find_duplicates: only group entities that also share the same entity_type",
				),
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
							return missingParams("shortest_path", ["from_id", "to_id"]);
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
							return missingParams("find_similar", ["entity_id"]);
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
							return missingParams("search_similar", ["entity_id"]);
						const embRow = await neo4j.query(
							"MATCH (e:Entity {id: $entity_id}) RETURN e.embedding",
							{ entity_id: params.entity_id },
						);
						if (!embRow.length || !embRow[0][0])
							return err(
								`entity "${params.entity_id}" has no stored embedding vector`,
								{
									suggestion:
										"Store an embedding via entity(update) with the embedding parameter, or use search for keyword matching instead",
								},
							);
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
					case "validate": {
						// Schema drift report. OPTIONAL MATCH ... WHERE m IS NULL keeps
						// this portable across Neo4j 4.x and 5.x.
						const result = await neo4j.execute([
							{
								statement: `MATCH (e:Entity)
                 WITH e.entity_type AS t, count(e) AS cnt, collect(e.id)[0..10] AS sample_ids
                 OPTIONAL MATCH (m:__Schema:EntityType {name: t})
                 WITH t, cnt, sample_ids, m WHERE m IS NULL
                 RETURN t, cnt, sample_ids ORDER BY cnt DESC`,
							},
							{
								statement: `MATCH ()-[r:RELATES_TO]->()
                 WITH r.type AS t, count(r) AS cnt
                 OPTIONAL MATCH (m:__Schema:RelType {name: t})
                 WITH t, cnt, m WHERE m IS NULL
                 RETURN t, cnt ORDER BY cnt DESC`,
							},
							{
								statement: `MATCH (e:Entity) WHERE e.namespace IS NOT NULL
                 WITH e.namespace AS ns, count(e) AS cnt
                 OPTIONAL MATCH (m:__Schema:Namespace {name: ns})
                 WITH ns, cnt, m WHERE m IS NULL
                 RETURN ns, cnt ORDER BY cnt DESC`,
							},
							{
								statement: `MATCH (e:Entity)
                 WITH e, [k IN keys(e) WHERE k STARTS WITH 'prop_' AND k <> 'prop_keys'] AS pk
                 WITH e, [k IN pk WHERE NOT substring(k, 5) IN coalesce(e.prop_keys, [])] AS stale
                 WHERE size(stale) > 0
                 RETURN e.id, e.name, stale LIMIT $limit`,
								parameters: { limit: params.limit },
							},
						]);
						const entityTypeDrift = neo4j
							.rows(result, 0)
							.map(([t, cnt, ids]) => ({
								entity_type: t,
								count: cnt,
								sample_ids: ids,
							}));
						const relTypeDrift = neo4j
							.rows(result, 1)
							.map(([t, cnt]) => ({ relationship_type: t, count: cnt }));
						const namespaceDrift = neo4j
							.rows(result, 2)
							.map(([ns, cnt]) => ({ namespace: ns, count: cnt }));
						const staleProps = neo4j
							.rows(result, 3)
							.map(([id, name, stale]) => ({
								id,
								name,
								stale_prop_keys: stale,
							}));
						const clean =
							!entityTypeDrift.length &&
							!relTypeDrift.length &&
							!namespaceDrift.length &&
							!staleProps.length;
						return ok({
							clean,
							entity_type_drift: entityTypeDrift,
							rel_type_drift: relTypeDrift,
							namespace_drift: namespaceDrift,
							stale_properties: staleProps,
							...(clean
								? {}
								: {
										suggestion:
											"Register missing types/namespaces via ontology(batch_create) or namespace(create), or fix the offending entities. Stale prop_* keys are cleaned automatically the next time the entity's properties are updated.",
									}),
						});
					}

					case "find_duplicates": {
						const rows = await neo4j.query(
							`MATCH (e:Entity)
               WHERE ($namespace IS NULL OR e.namespace = $namespace)
                 AND ($entity_type IS NULL OR e.entity_type = $entity_type)
               WITH toLower(trim(e.name)) AS norm,
                    e.namespace AS ns,
                    CASE WHEN $match_type THEN e.entity_type ELSE '' END AS tkey,
                    collect({id: e.id, name: e.name, entity_type: e.entity_type}) AS dups
               WHERE size(dups) > 1
               RETURN norm, ns, dups, size(dups) AS cnt
               ORDER BY cnt DESC LIMIT $limit`,
							{
								namespace: params.namespace ?? null,
								entity_type: params.entity_type ?? null,
								match_type: params.match_type,
								limit: params.limit,
							},
						);
						const groups = rows.map(([norm, ns, dups, cnt]) => ({
							normalized_name: norm,
							namespace: ns,
							count: cnt,
							entities: dups,
						}));
						return ok({
							duplicate_groups: groups,
							group_count: groups.length,
							...(groups.length
								? {
										suggestion:
											"Review each group and call entity(merge) with id (keep) and merge_from_id (absorb) for true duplicates",
									}
								: {}),
						});
					}

					default:
						return err(`Unknown action: ${params.action}`);
				}
			} catch (error) {
				return toolError("Analyze", error);
			}
		},
	);
}
