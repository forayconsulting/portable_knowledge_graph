import { describe, expect, it } from "vitest";
import { ENTITY_ACTIONS } from "../../shared/roles";
import { registerEntityTool } from "../entity";
import {
	captureTool,
	makeCtx,
	makeResponse,
	mockNeo4j,
	parse,
} from "./helpers";

function setup(role: "reader" | "writer" | "admin" = "admin") {
	const { client, execute, query } = mockNeo4j();
	const { server, handlers } = captureTool();
	registerEntityTool(server, makeCtx(client, role), ENTITY_ACTIONS[role]);
	return { handler: handlers.entity, execute, query };
}

describe("entity get", () => {
	const entityRow = [
		{
			id: "e1",
			name: "Thing",
			entity_type: "Note",
			embedding: [0.1, 0.2, 0.3],
			content: "hello",
			properties: '{"author":"A"}',
			prop_author: "A",
			prop_keys: ["author"],
		},
		["tag1"],
		[],
	];

	it("strips the embedding vector and reports has_embedding", async () => {
		const { handler, query } = setup();
		query.mockResolvedValue([entityRow]);
		const body = parse(
			await handler({ action: "get", id: "e1", detail: "full" }),
		);
		expect(body.embedding).toBeUndefined();
		expect(body.has_embedding).toBe(true);
		expect(body.content).toBe("hello");
		expect(body.tags).toEqual(["tag1"]);
	});

	it("compact detail omits content, properties, and prop_* fields", async () => {
		const { handler, query } = setup();
		query.mockResolvedValue([entityRow]);
		const body = parse(
			await handler({ action: "get", id: "e1", detail: "compact" }),
		);
		expect(body.content).toBeUndefined();
		expect(body.properties).toBeUndefined();
		expect(body.prop_author).toBeUndefined();
		expect(body.content_length).toBe(5);
	});

	it("returns isError with a suggestion when not found", async () => {
		const { handler, query } = setup();
		query.mockResolvedValue([]);
		const result = await handler({ action: "get", id: "nope", detail: "full" });
		expect(result.isError).toBe(true);
		expect(parse(result).suggestion).toBeTruthy();
	});

	it("drops the null source struct from unmatched OPTIONAL MATCH", async () => {
		const { handler, query } = setup();
		query.mockResolvedValue([
			[entityRow[0], ["tag1"], [{ id: null, name: null }]],
		]);
		const body = parse(
			await handler({ action: "get", id: "e1", detail: "full" }),
		);
		expect(body.sources).toEqual([]);
	});
});

describe("entity update", () => {
	it("nulls out stale promoted properties", async () => {
		const { handler, query } = setup();
		query
			.mockResolvedValueOnce([[["year", "author"]]]) // previous prop_keys
			.mockResolvedValueOnce([["e1"]]); // SET query
		const result = await handler({
			action: "update",
			id: "e1",
			properties: { author: "Alice" },
		});
		expect(parse(result).updated).toBe(true);
		const setCypher = query.mock.calls[1][0];
		expect(setCypher).toContain("e.prop_year = null");
		expect(setCypher).not.toContain("e.prop_author = null");
		expect(query.mock.calls[1][1].prop_author).toBe("Alice");
	});

	it("errors when the entity does not exist", async () => {
		const { handler, query } = setup();
		query.mockResolvedValue([]);
		const result = await handler({
			action: "update",
			id: "nope",
			name: "New name",
		});
		expect(result.isError).toBe(true);
		expect(parse(result).not_found).toEqual(['entity id "nope"']);
	});
});

describe("entity list", () => {
	it("returns pagination metadata from the count statement", async () => {
		const { handler, execute } = setup();
		execute.mockResolvedValue(
			makeResponse([[[5]], [["e1", "Thing", "Note", null, "summary", ["t"]]]]),
		);
		const body = parse(
			await handler({ action: "list", limit: 1, offset: 0, detail: "full" }),
		);
		expect(body.total_count).toBe(5);
		expect(body.has_more).toBe(true);
		expect(body.count).toBe(1);
	});

	it("compact detail returns only id, name, and entity_type", async () => {
		const { handler, execute } = setup();
		execute.mockResolvedValue(
			makeResponse([[[1]], [["e1", "Thing", "Note", "ns", "summary", ["t"]]]]),
		);
		const body = parse(
			await handler({
				action: "list",
				limit: 50,
				offset: 0,
				detail: "compact",
			}),
		) as { results: Array<Record<string, unknown>> };
		expect(body.results[0]).toEqual({
			id: "e1",
			name: "Thing",
			entity_type: "Note",
		});
	});
});

describe("entity merge", () => {
	const mergeParams = {
		action: "merge",
		id: "keep-1",
		merge_from_id: "drop-1",
		fill_nulls: true,
	};

	it("is admin-only", async () => {
		const { handler } = setup("writer");
		// writer's action enum excludes merge, but defense-in-depth: the
		// handler itself must also refuse if invoked directly.
		const result = await handler(mergeParams);
		expect(result.isError).toBe(true);
		expect(parse(result).error).toContain("admin");
	});

	it("rewires edges atomically and reports counts", async () => {
		const { handler, execute } = setup();
		execute.mockResolvedValue(
			makeResponse([
				[["keep-1"]], // fill_nulls
				[[2]], // outgoing
				[[1]], // incoming
				[[3]], // tags
				[[0]], // sources
				[[1]], // delete
			]),
		);
		const body = parse(await handler(mergeParams));
		expect(body).toMatchObject({
			merged: true,
			kept: "keep-1",
			deleted: "drop-1",
			rewired: { relates_to_out: 2, relates_to_in: 1, tags: 3, sources: 0 },
		});
		// Every statement must match both entities so nothing partial happens.
		for (const stmt of execute.mock.calls[0][0]) {
			expect(stmt.statement).toContain("$keep_id");
			expect(stmt.statement).toContain("$drop_id");
		}
	});

	it("aborts and names the missing entity", async () => {
		const { handler, execute } = setup();
		execute
			.mockResolvedValueOnce(makeResponse([[], [[0]], [[0]], [[0]], [[0]], []]))
			.mockResolvedValueOnce(makeResponse([[[true, false]]])); // probe
		const result = await handler(mergeParams);
		expect(result.isError).toBe(true);
		expect(parse(result).not_found).toEqual(['merge_from_id "drop-1"']);
	});

	it("refuses to merge an entity into itself", async () => {
		const { handler } = setup();
		const result = await handler({
			action: "merge",
			id: "same",
			merge_from_id: "same",
			fill_nulls: true,
		});
		expect(result.isError).toBe(true);
	});
});

describe("entity delete", () => {
	it("errors when the entity does not exist", async () => {
		const { handler, query } = setup();
		query.mockResolvedValue([[0]]);
		const result = await handler({ action: "delete", id: "nope" });
		expect(result.isError).toBe(true);
	});
});
