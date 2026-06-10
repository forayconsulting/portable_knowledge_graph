import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import {
	buildVizEvent,
	extractTouched,
	type VizEvent,
	wrapServerForViz,
} from "../events";
import { recordStatements } from "../trace";

describe("extractTouched", () => {
	it("extracts nodes and edges from a traverse-shaped payload", () => {
		const payload = {
			nodes: [
				{ id: "a", name: "A", entity_type: "Concept", label: "Entity" },
				{ id: "b", name: "B", entity_type: "Concept", label: "Entity" },
			],
			edges: [{ type: "RELATES_TO", rel_type: "SUPPORTS", from: "a", to: "b" }],
			node_count: 2,
			edge_count: 1,
		};
		const { node_ids, edges } = extractTouched(payload);
		expect(node_ids).toEqual(expect.arrayContaining(["a", "b"]));
		expect(edges).toEqual([{ from: "a", to: "b", rel_type: "SUPPORTS" }]);
	});

	it("extracts result ids from a paginated ok() payload", () => {
		const payload = {
			results: [
				{ id: "x1", name: "X", tags: ["t"] },
				{ id: "x2", name: "Y", tags: [] },
			],
			count: 2,
			offset: 0,
			limit: 20,
			has_more: false,
		};
		const { node_ids, edges } = extractTouched(payload);
		expect(node_ids).toEqual(["x1", "x2"]);
		expect(edges).toEqual([]);
	});

	it("deduplicates edges and survives deep nesting and nulls", () => {
		const payload = {
			deep: { deeper: [{ from: "a", to: "b" }, { from: "a", to: "b" }, null] },
		};
		const { edges } = extractTouched(payload);
		expect(edges).toHaveLength(1);
	});

	it("returns nothing for scalar payloads", () => {
		expect(extractTouched("just text")).toEqual({ node_ids: [], edges: [] });
	});
});

describe("buildVizEvent", () => {
	it("parses tool result text, captures action and cypher", () => {
		const event = buildVizEvent({
			graphId: "g1",
			email: "u@example.com",
			tool: "entity",
			args: { action: "get", id: "a" },
			result: {
				content: [
					{ type: "text", text: JSON.stringify({ id: "a", name: "A" }) },
				],
			},
			capture: {
				statements: [{ statement: "MATCH (e) RETURN e", params: { id: "a" } }],
			},
			durationMs: 42,
			errored: false,
		});
		expect(event.tool).toBe("entity");
		expect(event.action).toBe("get");
		expect(event.node_ids).toEqual(["a"]);
		expect(event.cypher).toEqual([
			{ statement: "MATCH (e) RETURN e", params: '{"id":"a"}' },
		]);
		expect(event.is_error).toBe(false);
		expect(event.duration_ms).toBe(42);
	});

	it("truncates oversized cypher statements", () => {
		const event = buildVizEvent({
			graphId: "g1",
			email: "u@example.com",
			tool: "search",
			args: { query: "x" },
			result: { content: [{ type: "text", text: "{}" }] },
			capture: { statements: [{ statement: "M".repeat(5000) }] },
			durationMs: 1,
			errored: false,
		});
		expect(event.cypher[0].statement.length).toBeLessThanOrEqual(2001);
	});

	it("marks isError results without extracting highlight targets", () => {
		const event = buildVizEvent({
			graphId: "g1",
			email: "u@example.com",
			tool: "entity",
			args: {},
			result: {
				content: [{ type: "text", text: '{"error":"nope","id":"a"}' }],
				isError: true,
			},
			capture: { statements: [] },
			durationMs: 1,
			errored: false,
		});
		expect(event.is_error).toBe(true);
		expect(event.node_ids).toEqual([]);
	});
});

/** Minimal stand-in for McpServer: stores the handler it was given. */
function fakeServer() {
	const registered: Record<string, (...args: unknown[]) => unknown> = {};
	return {
		registered,
		server: {
			tool(...args: unknown[]) {
				const name = args[0] as string;
				const handler = args[args.length - 1] as (...a: unknown[]) => unknown;
				registered[name] = handler;
			},
			resource() {},
		} as unknown as McpServer,
	};
}

describe("wrapServerForViz", () => {
	it("returns the handler result unchanged and emits one event", async () => {
		const { server, registered } = fakeServer();
		const emitted: VizEvent[] = [];
		const wrapped = wrapServerForViz(server, {
			graphId: "g1",
			email: "u@example.com",
			emit: (e) => emitted.push(e),
		});

		const result = {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({ nodes: [{ id: "n1" }] }),
				},
			],
		};
		wrapped.tool("traverse", "desc", {}, async () => {
			// Simulate the Neo4j client recording a statement mid-handler
			recordStatements([{ statement: "MATCH (n) RETURN n" }]);
			return result;
		});

		const out = await registered.traverse({ start_id: "n1" });
		expect(out).toBe(result);
		expect(emitted).toHaveLength(1);
		expect(emitted[0].tool).toBe("traverse");
		expect(emitted[0].node_ids).toEqual(["n1"]);
		expect(emitted[0].cypher).toEqual([{ statement: "MATCH (n) RETURN n" }]);
	});

	it("isolates cypher capture between concurrent handler calls", async () => {
		const { server, registered } = fakeServer();
		const emitted: VizEvent[] = [];
		const wrapped = wrapServerForViz(server, {
			graphId: "g1",
			email: "u@example.com",
			emit: (e) => emitted.push(e),
		});
		wrapped.tool("a", "d", {}, async (args: unknown) => {
			const { stmt } = args as { stmt: string };
			await new Promise((r) => setTimeout(r, stmt === "one" ? 20 : 5));
			recordStatements([{ statement: stmt }]);
			return { content: [{ type: "text" as const, text: "{}" }] };
		});

		await Promise.all([
			registered.a({ stmt: "one" }),
			registered.a({ stmt: "two" }),
		]);
		const byStmt = emitted.map((e) => e.cypher.map((c) => c.statement));
		expect(byStmt).toEqual(expect.arrayContaining([["one"], ["two"]]));
		expect(byStmt.flat()).toHaveLength(2);
	});

	it("swallows emit failures without affecting the tool call", async () => {
		const { server, registered } = fakeServer();
		const wrapped = wrapServerForViz(server, {
			graphId: "g1",
			email: "u@example.com",
			emit: () => {
				throw new Error("hub down");
			},
		});
		const result = { content: [{ type: "text" as const, text: "{}" }] };
		wrapped.tool("search", "d", {}, async () => result);
		await expect(registered.search({})).resolves.toBe(result);
	});

	it("emits an error event and rethrows when the handler throws", async () => {
		const { server, registered } = fakeServer();
		const emitted: VizEvent[] = [];
		const wrapped = wrapServerForViz(server, {
			graphId: "g1",
			email: "u@example.com",
			emit: (e) => emitted.push(e),
		});
		wrapped.tool("entity", "d", {}, async () => {
			throw new Error("boom");
		});
		await expect(registered.entity({})).rejects.toThrow("boom");
		expect(emitted).toHaveLength(1);
		expect(emitted[0].is_error).toBe(true);
	});

	it("emit callback receives no way to mutate the returned result", async () => {
		const { server, registered } = fakeServer();
		const wrapped = wrapServerForViz(server, {
			graphId: "g1",
			email: "u@example.com",
			emit: vi.fn(),
		});
		const result = {
			content: [{ type: "text" as const, text: '{"id":"a"}' }],
		};
		wrapped.tool("entity", "d", {}, async () => result);
		const out = (await registered.entity({})) as typeof result;
		expect(out.content[0].text).toBe('{"id":"a"}');
	});
});
