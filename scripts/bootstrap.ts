import {
	BOOTSTRAP_CONSTRAINTS,
	BOOTSTRAP_FULLTEXT,
	BOOTSTRAP_INDEXES,
	BOOTSTRAP_SCHEMA_SEED,
	BOOTSTRAP_VECTOR,
} from "../src/neo4j/bootstrap";
import type { Neo4jResponse, Neo4jStatement } from "../src/neo4j/types";

const NEO4J_URL = process.env.NEO4J_URL;
const NEO4J_AUTH = process.env.NEO4J_AUTH;

if (!NEO4J_URL || !NEO4J_AUTH) {
	console.error("Required env vars: NEO4J_URL, NEO4J_AUTH");
	process.exit(1);
}

async function cypher(statements: Neo4jStatement[]): Promise<Neo4jResponse> {
	const res = await fetch(NEO4J_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Basic ${Buffer.from(NEO4J_AUTH).toString("base64")}`,
		},
		body: JSON.stringify({ statements }),
	});
	if (!res.ok) throw new Error(`Neo4j HTTP ${res.status}: ${await res.text()}`);
	return (await res.json()) as Neo4jResponse;
}

async function runBatch(label: string, statements: Neo4jStatement[]) {
	console.log(`\n--- ${label} (${statements.length} statements) ---`);
	for (const stmt of statements) {
		try {
			const result = await cypher([stmt]);
			if (result.errors?.length) {
				const msg = result.errors[0].message;
				if (
					msg.includes("already exists") ||
					msg.includes("An equivalent index already exists")
				) {
					console.log(`  SKIP (exists): ${stmt.statement.slice(0, 80)}...`);
				} else {
					console.error(`  ERROR: ${msg}`);
				}
			} else {
				console.log(`  OK: ${stmt.statement.slice(0, 80)}...`);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (
				msg.includes("already exists") ||
				msg.includes("An equivalent index already exists")
			) {
				console.log(`  SKIP (exists): ${stmt.statement.slice(0, 80)}...`);
			} else {
				console.error(`  FAIL: ${msg}`);
			}
		}
	}
}

async function main() {
	console.log(`Bootstrapping Neo4j at ${NEO4J_URL}`);

	// Test connectivity
	try {
		const result = await cypher([
			{
				statement:
					"CALL dbms.components() YIELD name, versions RETURN name, versions[0]",
			},
		]);
		const row = result.results[0].data[0]?.row;
		console.log(`Connected: ${row?.[0]} v${row?.[1]}`);
	} catch (e) {
		console.error(`Cannot connect to Neo4j: ${e}`);
		process.exit(1);
	}

	await runBatch("Constraints", BOOTSTRAP_CONSTRAINTS);
	await runBatch("Indexes", BOOTSTRAP_INDEXES);
	await runBatch("Full-text Indexes", BOOTSTRAP_FULLTEXT);
	await runBatch("Vector Indexes", BOOTSTRAP_VECTOR);
	await runBatch("Schema Seed", BOOTSTRAP_SCHEMA_SEED);

	// Verify
	const verify = await cypher([
		{
			statement:
				"MATCH (m:__Schema) RETURN labels(m) AS labels, m.name AS name, m.description AS desc ORDER BY name",
		},
	]);
	console.log("\n--- Schema Nodes ---");
	for (const d of verify.results[0].data) {
		const [labels, name, desc] = d.row as [string[], string, string];
		console.log(`  ${labels.join(":")} | ${name} | ${desc}`);
	}

	console.log("\nBootstrap complete.");
}

main();
