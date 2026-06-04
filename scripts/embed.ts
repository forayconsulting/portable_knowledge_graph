import { parseArgs } from "node:util";
import OpenAI from "openai";
import type { Neo4jResponse, Neo4jStatement } from "../src/neo4j/types";

const { values: flags } = parseArgs({
	options: {
		"dry-run": { type: "boolean", default: false },
		namespace: { type: "string" },
		"batch-size": { type: "string", default: "50" },
	},
});

const DRY_RUN = flags["dry-run"] ?? false;
const NAMESPACE_FILTER = flags.namespace ?? null;
const BATCH_SIZE = Number.parseInt(flags["batch-size"] ?? "50", 10);

const NEO4J_URL = process.env.NEO4J_URL;
const NEO4J_AUTH = process.env.NEO4J_AUTH;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!NEO4J_URL || !NEO4J_AUTH) {
	console.error("Required env vars: NEO4J_URL, NEO4J_AUTH");
	process.exit(1);
}
if (!OPENAI_API_KEY && !DRY_RUN) {
	console.error("Required env var: OPENAI_API_KEY (or use --dry-run)");
	process.exit(1);
}

const MAX_TEXT_LENGTH = 30000;
const NEO4J_BATCH = 100;

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

async function cypher(statements: Neo4jStatement[]): Promise<Neo4jResponse> {
	const res = await fetch(NEO4J_URL!, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Basic ${Buffer.from(NEO4J_AUTH!).toString("base64")}`,
		},
		body: JSON.stringify({ statements }),
	});
	if (!res.ok) throw new Error(`Neo4j HTTP ${res.status}: ${await res.text()}`);
	return (await res.json()) as Neo4jResponse;
}

function nsWhere(): string {
	return NAMESPACE_FILTER ? "AND e.namespace = $namespace" : "";
}

function nsParams(): Record<string, unknown> {
	return NAMESPACE_FILTER ? { namespace: NAMESPACE_FILTER } : {};
}

async function countMissing(): Promise<number> {
	const result = await cypher([
		{
			statement: `MATCH (e:Entity) WHERE e.embedding IS NULL ${nsWhere()} RETURN count(e) AS cnt`,
			parameters: nsParams(),
		},
	]);
	return result.results[0].data[0]?.row[0] as number;
}

async function fetchBatch(): Promise<Array<{ id: string; text: string }>> {
	const result = await cypher([
		{
			statement: `MATCH (e:Entity) WHERE e.embedding IS NULL ${nsWhere()}
                  RETURN e.id, e.name, e.summary, e.content
                  LIMIT $batch`,
			parameters: { batch: BATCH_SIZE, ...nsParams() },
		},
	]);
	return result.results[0].data.map((d) => {
		const [id, name, summary, content] = d.row as [
			string,
			string | null,
			string | null,
			string | null,
		];
		const text = [name, summary, content]
			.filter(Boolean)
			.join("\n\n")
			.slice(0, MAX_TEXT_LENGTH);
		return { id, text: text || "(empty)" };
	});
}

async function generateEmbeddings(texts: string[]): Promise<number[][]> {
	if (!openai) throw new Error("OpenAI client not initialized");
	const response = await openai.embeddings.create({
		model: "text-embedding-3-small",
		input: texts,
	});
	return response.data
		.sort((a, b) => a.index - b.index)
		.map((d) => d.embedding);
}

async function generateWithRetry(
	texts: string[],
	maxRetries = 3,
): Promise<number[][]> {
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await generateEmbeddings(texts);
		} catch (error: unknown) {
			const status =
				error && typeof error === "object" && "status" in error
					? (error as { status: number }).status
					: 0;
			if (status === 429 && attempt < maxRetries) {
				const wait = 2 ** (attempt + 1) * 1000;
				console.log(`  Rate limited. Waiting ${wait / 1000}s...`);
				await new Promise((r) => setTimeout(r, wait));
				continue;
			}
			throw error;
		}
	}
	throw new Error("Exhausted retries");
}

async function writeEmbeddings(
	entities: Array<{ id: string; embedding: number[] }>,
): Promise<void> {
	const statements: Neo4jStatement[] = entities.map((e) => ({
		statement: "MATCH (e:Entity {id: $id}) SET e.embedding = $embedding",
		parameters: { id: e.id, embedding: e.embedding },
	}));
	for (let i = 0; i < statements.length; i += NEO4J_BATCH) {
		await cypher(statements.slice(i, i + NEO4J_BATCH));
	}
}

async function main() {
	console.log("=== Embedding Population ===\n");
	console.log(`Neo4j:      ${NEO4J_URL}`);
	console.log("Model:      text-embedding-3-small (1536 dims)");
	console.log(`Batch size: ${BATCH_SIZE}`);
	console.log(`Namespace:  ${NAMESPACE_FILTER ?? "(all)"}`);
	console.log(`Dry run:    ${DRY_RUN}\n`);

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

	const total = await countMissing();
	console.log(`\nEntities without embeddings: ${total}\n`);

	if (total === 0) {
		console.log("Nothing to do.");
		return;
	}

	let processed = 0;

	while (true) {
		const batch = await fetchBatch();
		if (batch.length === 0) break;

		console.log(`Processing batch of ${batch.length}...`);

		if (DRY_RUN) {
			for (const e of batch) {
				console.log(
					`  [dry-run] Would embed: ${e.id} (${e.text.slice(0, 60)}...)`,
				);
			}
			console.log(
				`\n[dry-run] Would process ${total} entities total. Showing first batch only.`,
			);
			break;
		}

		const embeddings = await generateWithRetry(batch.map((e) => e.text));

		await writeEmbeddings(
			batch.map((e, i) => ({ id: e.id, embedding: embeddings[i] })),
		);

		processed += batch.length;
		console.log(`  Done. Progress: ${processed}/${total}`);
	}

	console.log(
		`\nComplete. ${DRY_RUN ? "Dry run finished" : `Processed ${processed} entities`}.`,
	);
}

main().catch((e) => {
	console.error("Fatal:", e);
	process.exit(1);
});
