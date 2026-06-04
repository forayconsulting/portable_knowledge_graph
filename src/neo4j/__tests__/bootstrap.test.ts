import { describe, expect, it } from "vitest";
import {
	allBootstrapStatements,
	BOOTSTRAP_CONSTRAINTS,
	BOOTSTRAP_FULLTEXT,
	BOOTSTRAP_INDEXES,
	BOOTSTRAP_SCHEMA_SEED,
	BOOTSTRAP_VECTOR,
} from "../bootstrap";

describe("bootstrap", () => {
	it("has 3 constraints", () => {
		expect(BOOTSTRAP_CONSTRAINTS).toHaveLength(3);
	});

	it("has 8 indexes", () => {
		expect(BOOTSTRAP_INDEXES).toHaveLength(8);
	});

	it("has 2 full-text indexes", () => {
		expect(BOOTSTRAP_FULLTEXT).toHaveLength(2);
	});

	it("has 1 vector index", () => {
		expect(BOOTSTRAP_VECTOR).toHaveLength(1);
	});

	it("seeds 4 entity types and 7 relationship types", () => {
		const entityTypes = BOOTSTRAP_SCHEMA_SEED.filter((s) =>
			s.statement.includes("EntityType"),
		);
		const relTypes = BOOTSTRAP_SCHEMA_SEED.filter((s) =>
			s.statement.includes("RelType"),
		);
		expect(entityTypes).toHaveLength(4);
		expect(relTypes).toHaveLength(7);
	});

	it("allBootstrapStatements returns all statements", () => {
		const all = allBootstrapStatements();
		expect(all).toHaveLength(
			BOOTSTRAP_CONSTRAINTS.length +
				BOOTSTRAP_INDEXES.length +
				BOOTSTRAP_FULLTEXT.length +
				BOOTSTRAP_VECTOR.length +
				BOOTSTRAP_SCHEMA_SEED.length,
		);
	});

	it("all statements have a statement string", () => {
		for (const stmt of allBootstrapStatements()) {
			expect(stmt.statement).toBeDefined();
			expect(typeof stmt.statement).toBe("string");
			expect(stmt.statement.length).toBeGreaterThan(0);
		}
	});

	it("full-text indexes use Neo4j 5 CREATE FULLTEXT INDEX syntax", () => {
		for (const stmt of BOOTSTRAP_FULLTEXT) {
			expect(stmt.statement).toContain("CREATE FULLTEXT INDEX");
			expect(stmt.statement).not.toContain("CALL db.index.fulltext");
		}
	});
});
