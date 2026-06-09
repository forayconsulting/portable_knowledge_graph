import { describe, expect, it } from "vitest";
import { Neo4jClient } from "../client";
import type { Neo4jResponse } from "../types";

const response: Neo4jResponse = {
	results: [
		{
			columns: ["a"],
			data: [
				{ row: [1], meta: [] },
				{ row: [2], meta: [] },
			],
		},
		{ columns: ["b"], data: [] },
		{ columns: ["c"], data: [{ row: [3], meta: [] }] },
	],
	errors: [],
};

describe("Neo4jClient result helpers", () => {
	const client = new Neo4jClient({ url: "https://example.com", auth: "u:p" });

	it("rowCount returns the row count for a statement index", () => {
		expect(client.rowCount(response, 0)).toBe(2);
		expect(client.rowCount(response, 1)).toBe(0);
		expect(client.rowCount(response, 2)).toBe(1);
	});

	it("rowCount returns 0 for an out-of-range index", () => {
		expect(client.rowCount(response, 9)).toBe(0);
	});

	it("rowCounts returns counts for all statements", () => {
		expect(client.rowCounts(response)).toEqual([2, 0, 1]);
	});
});
