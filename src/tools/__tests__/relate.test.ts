import { describe, expect, it } from "vitest";
import { registerRelateTool } from "../relate";
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
	registerRelateTool(server, makeCtx(client, role));
	return { handler: handlers.relate, execute, query };
}

const createParams = {
	action: "create",
	from_id: "a-1",
	to_id: "b-1",
	relationship_type: "DEPENDS_ON",
	created_by: "mcp:client",
};

describe("relate create", () => {
	it("merges on type only and reports created", async () => {
		const { handler, execute } = setup();
		execute.mockResolvedValue(makeResponse([[[true]], [[true, true]]]));
		const result = await handler(createParams);
		expect(result.isError).toBeUndefined();
		expect(parse(result)).toMatchObject({
			created: true,
			already_existed: false,
			from: "a-1",
			to: "b-1",
		});
		const statements = execute.mock.calls[0][0];
		expect(statements[0].statement).toContain(
			"MERGE (a)-[r:RELATES_TO {type: $rel_type}]->(b)",
		);
		// properties must NOT be part of the merge key
		expect(statements[0].statement).not.toMatch(
			/MERGE \(a\)-\[r:RELATES_TO \{[^}]*properties/,
		);
	});

	it("reports already_existed on re-run", async () => {
		const { handler, execute } = setup();
		execute.mockResolvedValue(makeResponse([[[false]], [[true, true]]]));
		const result = await handler(createParams);
		expect(parse(result)).toMatchObject({
			created: false,
			already_existed: true,
		});
	});

	it("names the missing entity when from_id does not exist", async () => {
		const { handler, execute } = setup();
		execute.mockResolvedValue(makeResponse([[], [[false, true]]]));
		const result = await handler(createParams);
		expect(result.isError).toBe(true);
		const body = parse(result);
		expect(body.not_found).toEqual(['from_id "a-1"']);
		expect(body.suggestion).toBeTruthy();
	});

	it("names both entities when neither exists", async () => {
		const { handler, execute } = setup();
		execute.mockResolvedValue(makeResponse([[], [[false, false]]]));
		const result = await handler(createParams);
		expect(result.isError).toBe(true);
		expect(parse(result).not_found).toEqual(['from_id "a-1"', 'to_id "b-1"']);
	});

	it("requires from_id, to_id, and relationship_type", async () => {
		const { handler } = setup();
		const result = await handler({ action: "create", from_id: "a-1" });
		expect(result.isError).toBe(true);
	});
});

describe("relate query", () => {
	it("returns has_more via limit+1", async () => {
		const { handler, query } = setup();
		const row = ["e2", "Other", "Note", "RELATES_TO", null, "x", "outgoing"];
		query.mockResolvedValue([row, row, row]);
		const result = await handler({
			action: "query",
			node_id: "e1",
			direction: "both",
			limit: 2,
		});
		const body = parse(result);
		expect(body.count).toBe(2);
		expect(body.has_more).toBe(true);
		expect(query.mock.calls[0][1].limit).toBe(3);
	});
});

describe("relate tag", () => {
	it("errors when the entity does not exist", async () => {
		const { handler, query } = setup();
		query.mockResolvedValue([]);
		const result = await handler({
			action: "tag",
			entity_id: "missing",
			tag_name: "t",
			created_by: "mcp:client",
		});
		expect(result.isError).toBe(true);
		expect(parse(result).not_found).toEqual(['entity_id "missing"']);
	});
});
