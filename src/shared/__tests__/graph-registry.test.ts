import { describe, expect, it } from "vitest";
import type { GraphRecord, Role } from "../types";

/**
 * Pure-function mirror of GraphRegistry.resolveRole logic.
 * Tests the resolution algorithm without needing a Durable Object.
 */
function resolveRole(record: GraphRecord, email: string): Role | null {
	if (record.owner_email === email) return "admin";
	if (record.users[email]) return record.users[email];
	if (email.includes("@")) {
		const domain = `@${email.split("@")[1]}`;
		if (record.users[domain]) return record.users[domain];
	}
	return record.default_role;
}

function makeRecord(overrides: Partial<GraphRecord> = {}): GraphRecord {
	return {
		graph_id: "test-graph",
		display_name: "Test",
		neo4j_url: "https://example.com/db/neo4j/tx/commit",
		encrypted_neo4j_auth: "encrypted",
		encryption_iv: "iv",
		owner_email: "owner@acme.com",
		users: {},
		default_role: null,
		state: "ready",
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("resolveRole", () => {
	it("owner always resolves to admin", () => {
		const record = makeRecord({ users: { "owner@acme.com": "reader" } });
		expect(resolveRole(record, "owner@acme.com")).toBe("admin");
	});

	it("exact email match returns the assigned role", () => {
		const record = makeRecord({
			users: { "alice@acme.com": "writer" },
		});
		expect(resolveRole(record, "alice@acme.com")).toBe("writer");
	});

	it("domain pattern matches user at that domain", () => {
		const record = makeRecord({
			users: { "@acme.com": "reader" },
		});
		expect(resolveRole(record, "anyone@acme.com")).toBe("reader");
	});

	it("domain pattern does NOT match different domain", () => {
		const record = makeRecord({
			users: { "@acme.com": "reader" },
		});
		expect(resolveRole(record, "user@notacme.com")).toBeNull();
	});

	it("exact email match takes priority over domain pattern", () => {
		const record = makeRecord({
			users: {
				"alice@acme.com": "admin",
				"@acme.com": "reader",
			},
		});
		expect(resolveRole(record, "alice@acme.com")).toBe("admin");
		expect(resolveRole(record, "bob@acme.com")).toBe("reader");
	});

	it("default_role is returned when no match", () => {
		const record = makeRecord({ default_role: "reader" });
		expect(resolveRole(record, "stranger@other.com")).toBe("reader");
	});

	it("null default_role means no access", () => {
		const record = makeRecord({ default_role: null });
		expect(resolveRole(record, "stranger@other.com")).toBeNull();
	});

	it("owner override beats an explicit lower mapping", () => {
		const record = makeRecord({
			owner_email: "boss@acme.com",
			users: { "boss@acme.com": "reader" },
		});
		expect(resolveRole(record, "boss@acme.com")).toBe("admin");
	});
});
