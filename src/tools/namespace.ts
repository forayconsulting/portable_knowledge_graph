import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Neo4jClient } from "../neo4j/client";

export function registerNamespaceTool(server: McpServer, env: Env) {
	const neo4j = new Neo4jClient(env);

	server.tool(
		"namespace",
		`Manage workspace namespaces within the knowledge graph.

Namespaces partition the graph into logical domains. A single Neo4j instance can hold
"engineering-docs", "customer-research", "project-alpha", etc. without interference.

All query tools accept a namespace filter. Entities without a namespace are global.

Actions:
- list: List all namespaces with entity counts
- create: Create a new namespace (also creates __Schema:Namespace node)
- stats: Detailed stats for a specific namespace
- delete: Delete a namespace and optionally all its entities (requires confirm=true)`,
		{
			action: z.enum(["list", "create", "stats", "delete"]),
			name: z.string().optional().describe("Namespace name"),
			description: z.string().optional(),
			confirm: z
				.boolean()
				.optional()
				.default(false)
				.describe("Confirm deletion (required for delete)"),
		},
		async (params) => {
			try {
				switch (params.action) {
					case "list": {
						const rows = await neo4j.query(
							`MATCH (e:Entity) WHERE e.namespace IS NOT NULL
               WITH e.namespace AS ns, count(e) AS cnt,
                    collect(DISTINCT e.entity_type) AS types
               OPTIONAL MATCH (m:__Schema:Namespace {name: ns})
               RETURN ns, m.description, cnt, types
               ORDER BY cnt DESC`,
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										rows.map(([ns, desc, cnt, types]) => ({
											namespace: ns,
											description: desc,
											entity_count: cnt,
											entity_types: types,
										})),
										null,
										2,
									),
								},
							],
						};
					}

					case "create": {
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
										namespace: params.name,
									}),
								},
							],
						};
					}

					case "stats": {
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
						const result = await neo4j.execute([
							{
								statement: `MATCH (e:Entity {namespace: $ns})
                  WITH e.entity_type AS type, count(e) AS cnt
                  RETURN type, cnt ORDER BY cnt DESC`,
								parameters: { ns: params.name },
							},
							{
								statement: `MATCH (e:Entity {namespace: $ns})-[:TAGGED_WITH]->(t:Tag)
                  WITH t.name AS tag, count(e) AS cnt
                  RETURN tag, cnt ORDER BY cnt DESC LIMIT 20`,
								parameters: { ns: params.name },
							},
							{
								statement: `MATCH (e:Entity {namespace: $ns})-[r:RELATES_TO]->()
                  WITH r.type AS type, count(r) AS cnt
                  RETURN type, cnt ORDER BY cnt DESC`,
								parameters: { ns: params.name },
							},
						]);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										{
											namespace: params.name,
											entities_by_type: neo4j
												.rows(result, 0)
												.map(([t, c]) => ({ type: t, count: c })),
											top_tags: neo4j
												.rows(result, 1)
												.map(([t, c]) => ({ tag: t, count: c })),
											relationships_by_type: neo4j
												.rows(result, 2)
												.map(([t, c]) => ({ type: t, count: c })),
										},
										null,
										2,
									),
								},
							],
						};
					}

					case "delete": {
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
						if (!params.confirm)
							return {
								content: [
									{
										type: "text" as const,
										text: `Deletion requires confirm=true. This will delete ALL entities in namespace "${params.name}" and the namespace schema node.`,
									},
								],
							};

						const countRows = await neo4j.query(
							"MATCH (e:Entity {namespace: $ns}) RETURN count(e)",
							{ ns: params.name },
						);
						const count = countRows[0]?.[0] as number;

						await neo4j.execute([
							{
								statement: "MATCH (e:Entity {namespace: $ns}) DETACH DELETE e",
								parameters: { ns: params.name },
							},
							{
								statement: "MATCH (m:__Schema:Namespace {name: $ns}) DELETE m",
								parameters: { ns: params.name },
							},
						]);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										deleted: true,
										namespace: params.name,
										entities_removed: count,
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
							text: `Namespace error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}
