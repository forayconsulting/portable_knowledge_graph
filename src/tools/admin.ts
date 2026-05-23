import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Neo4jClient } from "../neo4j/client";

export function registerAdminTool(server: McpServer, env: Env) {
	const neo4j = new Neo4jClient(env);

	server.tool(
		"admin",
		`Database administration: health checks, index management, and raw Cypher execution.

Actions:
- health: Check Neo4j connectivity and version
- indexes: List all indexes
- constraints: List all constraints
- cypher: Execute raw Cypher (READ-ONLY by default). Set readonly=false for writes.

The cypher action is the escape hatch for any graph operation not covered by other tools.
Use it sparingly — prefer the structured tools for standard operations.`,
		{
			action: z.enum(["health", "indexes", "constraints", "cypher"]),
			query: z.string().optional().describe("Cypher query (for cypher action)"),
			parameters: z
				.record(z.string(), z.unknown())
				.optional()
				.describe("Query parameters"),
			readonly: z
				.boolean()
				.optional()
				.default(true)
				.describe("Read-only mode (cypher action, default true)"),
		},
		async (params) => {
			try {
				switch (params.action) {
					case "health": {
						const health = await neo4j.health();
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(health, null, 2),
								},
							],
						};
					}

					case "indexes": {
						const rows = await neo4j.query("SHOW INDEXES");
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(rows, null, 2),
								},
							],
						};
					}

					case "constraints": {
						const rows = await neo4j.query("SHOW CONSTRAINTS");
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(rows, null, 2),
								},
							],
						};
					}

					case "cypher": {
						if (!params.query)
							return {
								content: [
									{
										type: "text" as const,
										text: "Error: query is required for cypher action",
									},
								],
								isError: true,
							};
						if (params.readonly) {
							const lower = params.query.toLowerCase().trim();
							const writeKeywords = [
								"create",
								"merge",
								"set",
								"delete",
								"remove",
								"detach",
								"drop",
							];
							if (writeKeywords.some((kw) => lower.includes(kw))) {
								return {
									content: [
										{
											type: "text" as const,
											text: "Error: query contains write operations but readonly=true. Set readonly=false to allow writes.",
										},
									],
									isError: true,
								};
							}
						}
						const rows = await neo4j.query(
							params.query,
							params.parameters ?? undefined,
						);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(
										{ row_count: rows.length, rows },
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
							text: `Admin error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);
}
