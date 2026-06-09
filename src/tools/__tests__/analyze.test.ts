import { describe, expect, it } from "vitest";
import { registerAnalyzeTool } from "../analyze";
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
	registerAnalyzeTool(server, makeCtx(client));
	return { handler: handlers.analyze, execute, query };
}

describe("analyze validate", () => {
	it("reports drift across all four checks", async () => {
		const { handler, execute } = setup();
		execute.mockResolvedValue(
			makeResponse([
				[["GhostType", 2, ["a", "b"]]], // entity type drift
				[["UNKNOWN_REL", 7]], // rel type drift
				[["orphan-ns", 3]], // namespace drift
				[["e1", "Stale Thing", ["old_key"]]], // stale props
			]),
		);
		const body = parse(await handler({ action: "validate", limit: 20 }));
		expect(body.clean).toBe(false);
		expect(body.entity_type_drift).toEqual([
			{ entity_type: "GhostType", count: 2, sample_ids: ["a", "b"] },
		]);
		expect(body.rel_type_drift).toEqual([
			{ relationship_type: "UNKNOWN_REL", count: 7 },
		]);
		expect(body.namespace_drift).toEqual([
			{ namespace: "orphan-ns", count: 3 },
		]);
		expect(body.stale_properties).toEqual([
			{ id: "e1", name: "Stale Thing", stale_prop_keys: ["old_key"] },
		]);
		expect(body.suggestion).toBeTruthy();
	});

	it("reports clean with no suggestion when nothing drifts", async () => {
		const { handler, execute } = setup();
		execute.mockResolvedValue(makeResponse([[], [], [], []]));
		const body = parse(await handler({ action: "validate", limit: 20 }));
		expect(body.clean).toBe(true);
		expect(body.suggestion).toBeUndefined();
	});
});

describe("analyze find_duplicates", () => {
	it("groups entities by normalized name", async () => {
		const { handler, query } = setup();
		query.mockResolvedValue([
			[
				"acme corp",
				"sales",
				[
					{ id: "1", name: "Acme Corp", entity_type: "Company" },
					{ id: "2", name: " acme corp ", entity_type: "Company" },
				],
				2,
			],
		]);
		const body = parse(
			await handler({
				action: "find_duplicates",
				match_type: false,
				limit: 20,
			}),
		) as {
			duplicate_groups: Array<{ normalized_name: string; count: number }>;
			group_count: number;
			suggestion: string;
		};
		expect(body.group_count).toBe(1);
		expect(body.duplicate_groups[0].normalized_name).toBe("acme corp");
		expect(body.duplicate_groups[0].count).toBe(2);
		expect(body.suggestion).toContain("entity(merge)");
		expect(query.mock.calls[0][1].match_type).toBe(false);
	});

	it("passes namespace and type filters through", async () => {
		const { handler, query } = setup();
		query.mockResolvedValue([]);
		await handler({
			action: "find_duplicates",
			namespace: "sales",
			entity_type: "Company",
			match_type: true,
			limit: 5,
		});
		expect(query.mock.calls[0][1]).toMatchObject({
			namespace: "sales",
			entity_type: "Company",
			match_type: true,
			limit: 5,
		});
	});
});
