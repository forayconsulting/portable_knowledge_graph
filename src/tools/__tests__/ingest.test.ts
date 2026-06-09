import { describe, expect, it } from "vitest";
import { registerIngestTool } from "../ingest";
import {
	captureTool,
	makeCtx,
	makeResponse,
	mockNeo4j,
	parse,
} from "./helpers";

function setup() {
	const { client, execute, query } = mockNeo4j();
	const { server, handlers } = captureTool();
	registerIngestTool(server, makeCtx(client));
	return { handler: handlers.ingest, execute, query };
}

function entity(name: string, tags: string[] = []) {
	return {
		name,
		entity_type: "Note",
		epistemic_status: "provisional",
		confidence: 0.5,
		tags,
	};
}

describe("ingest relationships", () => {
	it("tallies created, skipped, and unmatched per statement", async () => {
		const { handler, execute } = setup();
		execute.mockResolvedValue(
			makeResponse([
				[["a1", "b1", true]], // created
				[], // unmatched
				[["a3", "b3", false]], // already existed
			]),
		);
		const result = await handler({
			action: "relationships",
			relationships: [
				{ from_id: "a1", to_id: "b1", relationship_type: "R" },
				{ from_id: "a2", to_name: "Ghost", relationship_type: "R" },
				{ from_id: "a3", to_id: "b3", relationship_type: "R" },
			],
			created_by: "mcp:ingest",
		});
		const body = parse(result);
		expect(body.requested).toBe(3);
		expect(body.created).toBe(1);
		expect(body.skipped).toBe(1);
		expect(body.unmatched).toEqual([{ index: 1, from: "a2", to: "Ghost" }]);
		expect(body.suggestion).toContain("Unmatched");
		const statements = execute.mock.calls[0][0];
		expect(statements[0].statement).toContain(
			"MERGE (a)-[r:RELATES_TO {type: $rel_type}]->(b)",
		);
	});

	it("flags name-based fanout when multiple entities share a name", async () => {
		const { handler, execute } = setup();
		execute.mockResolvedValue(
			makeResponse([
				[
					["a1", "b1", true],
					["a1", "b2", true],
				],
			]),
		);
		const result = await handler({
			action: "relationships",
			relationships: [
				{ from_id: "a1", to_name: "Duped", relationship_type: "R" },
			],
			created_by: "mcp:ingest",
		});
		const body = parse(result) as {
			created: number;
			fanout_warnings: Array<{ edges: number }>;
		};
		expect(body.created).toBe(2);
		expect(body.fanout_warnings).toHaveLength(1);
		expect(body.fanout_warnings[0].edges).toBe(2);
	});

	it("reports partial progress when a batch fails", async () => {
		const { handler, execute } = setup();
		const rels = Array.from({ length: 150 }, (_, i) => ({
			from_id: `a${i}`,
			to_id: `b${i}`,
			relationship_type: "R",
		}));
		execute
			.mockResolvedValueOnce(
				makeResponse(
					rels.slice(0, 100).map((r) => [[r.from_id, r.to_id, true]]),
				),
			)
			.mockRejectedValueOnce(new Error("Neo4j HTTP 500: boom"));
		const result = await handler({
			action: "relationships",
			relationships: rels,
			created_by: "mcp:ingest",
		});
		const body = parse(result);
		expect(body.partial).toBe(true);
		expect(body.created).toBe(100);
		expect(body.failed_batch_index).toBe(1);
		expect(body.remaining_count).toBe(50);
		expect(body.error).toContain("boom");
	});
});

describe("ingest entities", () => {
	it("keeps an entity and its tags in the same batch", async () => {
		const { handler, execute } = setup();
		execute.mockResolvedValue(makeResponse([]));
		// 34 entities x 3 statements (entity + 2 tags) = 102 statements:
		// batch 1 must stop at 33 entities (99 statements), batch 2 has 3.
		const entities = Array.from({ length: 34 }, (_, i) =>
			entity(`E${i}`, ["t1", "t2"]),
		);
		const result = await handler({
			action: "entities",
			entities,
			created_by: "mcp:ingest",
		});
		expect(parse(result).ingested).toBe(true);
		expect(execute).toHaveBeenCalledTimes(2);
		expect(execute.mock.calls[0][0]).toHaveLength(99);
		expect(execute.mock.calls[1][0]).toHaveLength(3);
	});

	it("returns succeeded ids and failed batch on mid-run failure", async () => {
		const { handler, execute } = setup();
		execute
			.mockResolvedValueOnce(makeResponse([]))
			.mockRejectedValueOnce(new Error("connection reset"));
		const entities = Array.from({ length: 34 }, (_, i) =>
			entity(`E${i}`, ["t1", "t2"]),
		);
		const result = await handler({
			action: "entities",
			entities,
			created_by: "mcp:ingest",
		});
		const body = parse(result) as {
			partial: boolean;
			succeeded_ids: string[];
			failed_ids: string[];
			failed_batch_index: number;
			remaining_count: number;
			suggestion: string;
		};
		expect(body.partial).toBe(true);
		expect(body.succeeded_ids).toHaveLength(33);
		expect(body.failed_batch_index).toBe(1);
		expect(body.failed_ids).toHaveLength(1);
		expect(body.remaining_count).toBe(0);
		expect(body.suggestion).toContain("retries");
	});
});
