import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Mock, vi } from "vitest";
import type { Neo4jClient } from "../../neo4j/client";
import type { Neo4jResponse } from "../../neo4j/types";
import type { SessionContext } from "../../shared/types";

export interface ToolResultShape {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
}

type ToolHandler = (
	params: Record<string, unknown>,
) => Promise<ToolResultShape>;

// Builds a Neo4jResponse from per-statement row arrays:
// makeResponse([[[1]], []]) = statement 0 returned one row [1], statement 1 zero rows.
export function makeResponse(rowSets: unknown[][][]): Neo4jResponse {
	return {
		results: rowSets.map((rows) => ({
			columns: [],
			data: rows.map((row) => ({ row, meta: [] })),
		})),
		errors: [],
	};
}

export function mockNeo4j(): {
	client: Neo4jClient;
	execute: Mock;
	query: Mock;
} {
	const execute = vi.fn();
	const query = vi.fn();
	const client = {
		execute,
		query,
		rows(result: Neo4jResponse, idx = 0) {
			return result.results[idx]?.data.map((d) => d.row) ?? [];
		},
		rowCount(result: Neo4jResponse, idx = 0) {
			return result.results[idx]?.data.length ?? 0;
		},
		rowCounts(result: Neo4jResponse) {
			return result.results.map((r) => r.data.length);
		},
	} as unknown as Neo4jClient;
	return { client, execute, query };
}

// Fake McpServer that records each registered tool's handler so tests can
// invoke it directly. Zod defaults are applied by the MCP SDK at dispatch
// time, not by the raw handler, so tests must pass fully-populated params.
export function captureTool(): {
	server: McpServer;
	handlers: Record<string, ToolHandler>;
} {
	const handlers: Record<string, ToolHandler> = {};
	const server = {
		tool: (
			name: string,
			_description: string,
			_schema: unknown,
			handler: ToolHandler,
		) => {
			handlers[name] = handler;
		},
	};
	return { server: server as unknown as McpServer, handlers };
}

export function makeCtx(
	client: Neo4jClient,
	role: SessionContext["role"] = "admin",
): SessionContext {
	return { neo4j: client, role, email: "test@example.com", graphId: "" };
}

export function parse(result: ToolResultShape): Record<string, unknown> {
	return JSON.parse(result.content[0].text);
}
