import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { err, missingParams, ok, toolError } from "../shared/responses";
import type { SessionContext } from "../shared/types";

const ALL_ACTIONS = [
	"create",
	"query",
	"delete",
	"tag",
	"untag",
	"source",
] as const;

const ACTION_DESCRIPTIONS: Record<string, string> = {
	create:
		"- create: Link two entities with a typed relationship. Idempotent — re-creating an existing (from, to, type) edge reports already_existed instead of duplicating. YOU decide the type.",
	query:
		"- query: Get all relationships for a node (filtered by type/direction).",
	delete: "- delete: Remove a specific relationship.",
	tag: "- tag: Tag an entity with a Tag node (creates TAGGED_WITH edge).",
	untag: "- untag: Remove a tag from an entity.",
	source:
		"- source: Link an entity to a Source node (creates SOURCED_FROM edge with confidence).",
};

const ENTITY_NOT_FOUND_SUGGESTION =
	"Use search or entity(list) to locate the correct entity id";

export function registerRelateTool(
	server: McpServer,
	ctx: SessionContext,
	allowedActions?: readonly string[],
) {
	const { neo4j, role } = ctx;
	const actions = allowedActions ?? ALL_ACTIONS;
	const actionDocs = actions.map((a) => ACTION_DESCRIPTIONS[a]).join("\n");

	server.tool(
		"relate",
		`Create, query, or delete relationships between entities. Also manages tags and source links.

Relationship types are stored as a property on RELATES_TO edges (not as Neo4j relationship types).
This keeps the schema flexible — new relationship semantics are added by creating __Schema:RelType
nodes, not by changing Cypher.

Actions:
${actionDocs}

For SIMILAR_TO edges, use the analyze tool's find_similar action instead — it computes
structural similarity. Or create SIMILAR_TO directly here if YOU have determined the similarity.`,
		{
			action: z.enum(actions as unknown as [string, ...string[]]),
			from_id: z.string().optional().describe("Source entity ID"),
			to_id: z.string().optional().describe("Target entity ID"),
			relationship_type: z
				.string()
				.optional()
				.describe("Relationship type (should match a __Schema:RelType)"),
			properties: z
				.record(z.string(), z.unknown())
				.optional()
				.describe(
					"Edge properties. Set on creation only — re-creating an existing edge does not overwrite them.",
				),
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
				.min(0)
				.max(1)
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
							return missingParams("create", [
								"from_id",
								"to_id",
								"relationship_type",
							]);
						// MERGE keys on {type} only: properties is a JSON string, so
						// including it in the merge key would create a parallel edge for
						// every distinct payload and defeat idempotency.
						const result = await neo4j.execute([
							{
								statement: `MATCH (a:Entity {id: $from_id}) MATCH (b:Entity {id: $to_id})
                 MERGE (a)-[r:RELATES_TO {type: $rel_type}]->(b)
                 ON CREATE SET r.properties = $properties,
                               r.created_by = $created_by,
                               r.created_at = datetime(), r._new = true
                 WITH r, coalesce(r._new, false) AS was_created
                 REMOVE r._new
                 RETURN was_created`,
								parameters: {
									from_id: params.from_id,
									to_id: params.to_id,
									rel_type: params.relationship_type,
									properties: params.properties
										? JSON.stringify(params.properties)
										: null,
									created_by: params.created_by,
								},
							},
							{
								statement: `OPTIONAL MATCH (a:Entity {id: $from_id})
                 OPTIONAL MATCH (b:Entity {id: $to_id})
                 RETURN a.id IS NOT NULL AS from_exists, b.id IS NOT NULL AS to_exists`,
								parameters: { from_id: params.from_id, to_id: params.to_id },
							},
						]);
						if (neo4j.rowCount(result, 0) === 0) {
							const [fromExists, toExists] = (neo4j.rows(result, 1)[0] ?? [
								false,
								false,
							]) as [boolean, boolean];
							const notFound: string[] = [];
							if (!fromExists) notFound.push(`from_id "${params.from_id}"`);
							if (!toExists) notFound.push(`to_id "${params.to_id}"`);
							return err("relationship not created: entity not found", {
								not_found: notFound,
								suggestion: ENTITY_NOT_FOUND_SUGGESTION,
							});
						}
						const wasCreated = neo4j.rows(result, 0)[0]?.[0] === true;
						return ok({
							created: wasCreated,
							already_existed: !wasCreated,
							from: params.from_id,
							to: params.to_id,
							type: params.relationship_type,
						});
					}

					case "query": {
						if (!params.node_id) return missingParams("query", ["node_id"]);
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
              RETURN other.id, other.name, other.entity_type, r.type,
                     r.properties, r.created_by,
                     CASE WHEN startNode(r) = e THEN 'outgoing' ELSE 'incoming' END AS direction
              LIMIT $limit`;
						// limit + 1 to detect whether more rows exist beyond the page
						const rows = await neo4j.query(cypher, {
							node_id: params.node_id,
							filter_rel_type: params.filter_rel_type ?? null,
							limit: params.limit + 1,
						});
						const hasMore = rows.length > params.limit;
						const rels = rows
							.slice(0, params.limit)
							.map(([id, name, type, relType, props, by, dir]) => ({
								entity_id: id,
								entity_name: name,
								entity_type: type,
								relationship_type: relType,
								properties: props,
								created_by: by,
								direction: dir,
							}));
						return ok({
							relationships: rels,
							count: rels.length,
							has_more: hasMore,
						});
					}

					case "delete": {
						if (role !== "admin") {
							return err("Forbidden: relationship delete requires admin role");
						}
						if (!params.from_id || !params.to_id || !params.relationship_type)
							return missingParams("delete", [
								"from_id",
								"to_id",
								"relationship_type",
							]);
						const result = await neo4j.query(
							`MATCH (a:Entity {id: $from_id})-[r:RELATES_TO {type: $rel_type}]->(b:Entity {id: $to_id})
               DELETE r RETURN count(r) AS deleted`,
							{
								from_id: params.from_id,
								to_id: params.to_id,
								rel_type: params.relationship_type,
							},
						);
						return ok({
							deleted: (result[0]?.[0] as number) > 0,
						});
					}

					case "tag": {
						if (!params.entity_id || !params.tag_name)
							return missingParams("tag", ["entity_id", "tag_name"]);
						const rows = await neo4j.query(
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
						if (!rows.length)
							return err("entity not tagged: entity not found", {
								not_found: [`entity_id "${params.entity_id}"`],
								suggestion: ENTITY_NOT_FOUND_SUGGESTION,
							});
						return ok({
							tagged: true,
							entity: params.entity_id,
							tag: params.tag_name,
						});
					}

					case "untag": {
						if (role !== "admin") {
							return err("Forbidden: untag requires admin role");
						}
						if (!params.entity_id || !params.tag_name)
							return missingParams("untag", ["entity_id", "tag_name"]);
						await neo4j.query(
							`MATCH (e:Entity {id: $entity_id})-[r:TAGGED_WITH]->(t:Tag {name: $tag_name})
               DELETE r RETURN count(r)`,
							{
								entity_id: params.entity_id,
								tag_name: params.tag_name,
							},
						);
						return ok({
							untagged: true,
							entity: params.entity_id,
							tag: params.tag_name,
						});
					}

					case "source": {
						if (!params.entity_id || !params.source_id)
							return missingParams("source", ["entity_id", "source_id"]);
						const rows = await neo4j.query(
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
						if (!rows.length)
							return err("source not linked: entity or source not found", {
								not_found: [
									`entity_id "${params.entity_id}" and/or source_id "${params.source_id}"`,
								],
								suggestion:
									"Verify both ids exist via entity(get) and source(get)",
							});
						return ok({
							linked: true,
							entity: params.entity_id,
							source: params.source_id,
						});
					}

					default:
						return err(`Unknown action: ${params.action}`);
				}
			} catch (error) {
				return toolError("Relate", error);
			}
		},
	);
}
