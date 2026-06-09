import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	err,
	missingParams,
	ok,
	paginated,
	toolError,
} from "../shared/responses";
import type { SessionContext } from "../shared/types";

const ALL_ACTIONS = ["create", "get", "list", "link", "trace"] as const;

const ACTION_DESCRIPTIONS: Record<string, string> = {
	create: "- create: Create a new Source record",
	get: "- get: Get a source by ID with all linked entities",
	list: "- list: List sources with optional type filter. Paginated.",
	link: "- link: Link an entity to a source (shortcut for relate(source))",
	trace:
		"- trace: Trace the full provenance chain for an entity (what sources contributed to it)",
};

export function registerSourceTool(
	server: McpServer,
	ctx: SessionContext,
	allowedActions?: readonly string[],
) {
	const { neo4j } = ctx;
	const actions = allowedActions ?? ALL_ACTIONS;
	const actionDocs = actions.map((a) => ACTION_DESCRIPTIONS[a]).join("\n");

	server.tool(
		"source",
		`Manage provenance tracking with Source nodes.

Sources record WHERE knowledge came from: documents, URLs, user input, API responses, etc.
Link entities to sources via SOURCED_FROM edges with confidence scores and text excerpts.

Actions:
${actionDocs}`,
		{
			action: z.enum(actions as unknown as [string, ...string[]]),
			id: z.string().optional().describe("Source ID (auto-UUID on create)"),
			name: z.string().optional().describe("Source name/title"),
			source_type: z
				.enum(["document", "url", "user_input", "llm_extraction", "api"])
				.optional()
				.describe("Type of source"),
			uri: z.string().optional().describe("URL or file path"),
			entity_id: z.string().optional().describe("Entity ID for link/trace"),
			source_id: z.string().optional().describe("Source ID for link"),
			confidence: z
				.number()
				.min(0)
				.max(1)
				.optional()
				.default(1.0)
				.describe("Confidence for link (0-1)"),
			excerpt: z.string().optional().describe("Text excerpt for link"),
			created_by: z.string().optional().default("mcp:client"),
			filter_type: z
				.string()
				.optional()
				.describe("Filter by source_type (list)"),
			max_depth: z
				.number()
				.optional()
				.default(3)
				.describe("Max depth for trace"),
			limit: z.number().optional().default(50),
			offset: z.number().optional().default(0).describe("Pagination offset"),
		},
		async (params) => {
			try {
				switch (params.action) {
					case "create": {
						const id = params.id ?? crypto.randomUUID();
						await neo4j.query(
							`CREATE (s:Source {
                id: $id, name: $name, source_type: $source_type,
                uri: $uri, ingested_at: datetime(), created_by: $created_by
              })
              RETURN s.id`,
							{
								id,
								name: params.name ?? "",
								source_type: params.source_type ?? "document",
								uri: params.uri ?? null,
								created_by: params.created_by,
							},
						);
						return ok({ created: true, id });
					}

					case "get": {
						if (!params.id) return missingParams("get", ["id"]);
						const rows = await neo4j.query(
							`MATCH (s:Source {id: $id})
               OPTIONAL MATCH (e:Entity)-[r:SOURCED_FROM]->(s)
               RETURN s, collect({
                 entity_id: e.id, entity_name: e.name,
                 confidence: r.confidence, excerpt: left(coalesce(r.excerpt, ''), 200)
               }) AS linked_entities`,
							{ id: params.id },
						);
						if (!rows.length)
							return err(`source "${params.id}" not found`, {
								not_found: [`source id "${params.id}"`],
								suggestion: "Use source(list) to see available sources",
							});
						// collect() over an unmatched OPTIONAL MATCH yields one
						// null-valued struct; drop it.
						const linked = (
							rows[0][1] as Array<{ entity_id: string | null }>
						).filter((l) => l.entity_id !== null);
						return ok(
							{ source: rows[0][0], linked_entities: linked },
							{ pretty: true },
						);
					}

					case "list": {
						const result = await neo4j.execute([
							{
								statement: `MATCH (s:Source)
                 WHERE $filter_type IS NULL OR s.source_type = $filter_type
                 RETURN count(s)`,
								parameters: { filter_type: params.filter_type ?? null },
							},
							{
								statement: `MATCH (s:Source)
                 WHERE $filter_type IS NULL OR s.source_type = $filter_type
                 OPTIONAL MATCH (e:Entity)-[:SOURCED_FROM]->(s)
                 RETURN s.id, s.name, s.source_type, s.uri, s.ingested_at,
                        count(e) AS linked_count
                 ORDER BY s.ingested_at DESC
                 SKIP $offset LIMIT $limit`,
								parameters: {
									filter_type: params.filter_type ?? null,
									offset: params.offset,
									limit: params.limit,
								},
							},
						]);
						const totalCount = (neo4j.rows(result, 0)[0]?.[0] as number) ?? 0;
						const sources = neo4j
							.rows(result, 1)
							.map(([id, name, type, uri, date, count]) => ({
								id,
								name,
								source_type: type,
								uri,
								ingested_at: date,
								linked_entities: count,
							}));
						return paginated(sources, {
							total_count: totalCount,
							offset: params.offset,
							limit: params.limit,
							has_more: params.offset + sources.length < totalCount,
						});
					}

					case "link": {
						if (!params.entity_id || !params.source_id)
							return missingParams("link", ["entity_id", "source_id"]);
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

					case "trace": {
						if (!params.entity_id) return missingParams("trace", ["entity_id"]);
						const rows = await neo4j.query(
							`MATCH (e:Entity {id: $entity_id})-[r:SOURCED_FROM]->(s:Source)
               RETURN s.id, s.name, s.source_type, s.uri,
                      r.confidence, left(coalesce(r.excerpt, ''), 300)
               ORDER BY r.confidence DESC`,
							{ entity_id: params.entity_id },
						);
						return ok(
							{
								entity_id: params.entity_id,
								sources: rows.map(([id, name, type, uri, conf, excerpt]) => ({
									id,
									name,
									source_type: type,
									uri,
									confidence: conf,
									excerpt,
								})),
							},
							{ pretty: true },
						);
					}

					default:
						return err(`Unknown action: ${params.action}`);
				}
			} catch (error) {
				return toolError("Source", error);
			}
		},
	);
}
