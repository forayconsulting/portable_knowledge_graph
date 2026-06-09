import { describe, expect, it } from "vitest";
import { err, missingParams, ok, paginated, toolError } from "../responses";

describe("ok", () => {
	it("returns compact JSON by default", () => {
		const result = ok({ a: 1 });
		expect(result.content[0].text).toBe('{"a":1}');
		expect(result.isError).toBeUndefined();
	});

	it("pretty-prints when requested", () => {
		const result = ok({ a: 1 }, { pretty: true });
		expect(result.content[0].text).toContain("\n");
	});
});

describe("err", () => {
	it("sets isError and includes not_found and suggestion", () => {
		const result = err("thing not found", {
			not_found: ['id "x"'],
			suggestion: "use search",
		});
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text)).toEqual({
			error: "thing not found",
			not_found: ['id "x"'],
			suggestion: "use search",
		});
	});

	it("omits empty not_found and suggestion", () => {
		const body = JSON.parse(err("boom").content[0].text);
		expect(body).toEqual({ error: "boom" });
	});
});

describe("missingParams", () => {
	it("pluralizes correctly", () => {
		expect(missingParams("get", ["id"]).content[0].text).toContain(
			"id is required for get",
		);
		expect(
			missingParams("create", ["from_id", "to_id"]).content[0].text,
		).toContain("from_id, to_id are required for create");
	});
});

describe("toolError", () => {
	it("extracts the message from Error instances", () => {
		const result = toolError("Entity", new Error("kaput"));
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Entity error: kaput");
	});
});

describe("paginated", () => {
	it("includes count, total_count, offset, limit, and has_more", () => {
		const result = paginated([1, 2], {
			total_count: 10,
			offset: 0,
			limit: 2,
			has_more: true,
		});
		expect(JSON.parse(result.content[0].text)).toEqual({
			results: [1, 2],
			count: 2,
			total_count: 10,
			offset: 0,
			limit: 2,
			has_more: true,
		});
	});

	it("omits total_count when unknown", () => {
		const body = JSON.parse(
			paginated([], { offset: 0, limit: 5, has_more: false }).content[0].text,
		);
		expect(body.total_count).toBeUndefined();
		expect(body.has_more).toBe(false);
	});
});
