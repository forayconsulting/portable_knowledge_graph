import { describe, expect, it } from "vitest";
import {
	ANALYZE_ACTIONS,
	ENTITY_ACTIONS,
	NAMESPACE_ACTIONS,
	ONTOLOGY_ACTIONS,
	RELATE_ACTIONS,
	SOURCE_ACTIONS,
	TOOL_ACCESS,
} from "../roles";
import type { Role } from "../types";

describe("role-action matrices", () => {
	it("reader cannot create, update, or delete entities", () => {
		expect(ENTITY_ACTIONS.reader).not.toContain("create");
		expect(ENTITY_ACTIONS.reader).not.toContain("update");
		expect(ENTITY_ACTIONS.reader).not.toContain("delete");
	});

	it("writer can create but not delete entities", () => {
		expect(ENTITY_ACTIONS.writer).toContain("create");
		expect(ENTITY_ACTIONS.writer).toContain("update");
		expect(ENTITY_ACTIONS.writer).not.toContain("delete");
	});

	it("admin has all entity actions", () => {
		expect(ENTITY_ACTIONS.admin).toContain("create");
		expect(ENTITY_ACTIONS.admin).toContain("delete");
	});

	it("merge is admin-only (it deletes the absorbed entity)", () => {
		expect(ENTITY_ACTIONS.admin).toContain("merge");
		expect(ENTITY_ACTIONS.writer).not.toContain("merge");
		expect(ENTITY_ACTIONS.reader).not.toContain("merge");
	});

	it("all roles get the read-only analyze actions", () => {
		const allRoles: Role[] = ["reader", "writer", "admin"];
		for (const role of allRoles) {
			expect(ANALYZE_ACTIONS[role]).toContain("validate");
			expect(ANALYZE_ACTIONS[role]).toContain("find_duplicates");
			expect(ANALYZE_ACTIONS[role]).toContain("stats");
		}
	});

	it("reader can only query relationships", () => {
		expect(RELATE_ACTIONS.reader).toEqual(["query"]);
	});

	it("writer cannot untag or delete relationships", () => {
		expect(RELATE_ACTIONS.writer).not.toContain("delete");
		expect(RELATE_ACTIONS.writer).not.toContain("untag");
	});

	it("admin can untag and delete relationships", () => {
		expect(RELATE_ACTIONS.admin).toContain("delete");
		expect(RELATE_ACTIONS.admin).toContain("untag");
	});

	it("reader can only read sources", () => {
		expect(SOURCE_ACTIONS.reader).toContain("get");
		expect(SOURCE_ACTIONS.reader).toContain("trace");
		expect(SOURCE_ACTIONS.reader).not.toContain("create");
		expect(SOURCE_ACTIONS.reader).not.toContain("link");
	});

	it("reader can only describe ontology", () => {
		expect(ONTOLOGY_ACTIONS.reader).toEqual(["describe"]);
	});

	it("reader cannot delete namespaces", () => {
		expect(NAMESPACE_ACTIONS.reader).not.toContain("delete");
		expect(NAMESPACE_ACTIONS.reader).not.toContain("create");
	});

	it("only admin can delete namespaces", () => {
		expect(NAMESPACE_ACTIONS.admin).toContain("delete");
		expect(NAMESPACE_ACTIONS.writer).not.toContain("delete");
	});

	it("ingest is writer+ only", () => {
		expect(TOOL_ACCESS.ingest).not.toContain("reader");
		expect(TOOL_ACCESS.ingest).toContain("writer");
		expect(TOOL_ACCESS.ingest).toContain("admin");
	});

	it("admin tool is admin only", () => {
		expect(TOOL_ACCESS.admin).toEqual(["admin"]);
	});

	it("search, traverse, analyze available to all roles", () => {
		const allRoles: Role[] = ["reader", "writer", "admin"];
		for (const tool of ["search", "traverse", "analyze"]) {
			for (const role of allRoles) {
				expect(TOOL_ACCESS[tool]).toContain(role);
			}
		}
	});
});
