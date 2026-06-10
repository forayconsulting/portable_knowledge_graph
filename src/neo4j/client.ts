import { recordStatements } from "../viz/trace";
import type { Neo4jResponse, Neo4jStatement } from "./types";

export interface Neo4jClientOpts {
	url: string;
	auth: string;
}

export class Neo4jClient {
	private url: string;
	private authHeader: string;

	constructor(opts: Neo4jClientOpts) {
		this.url = opts.url;
		this.authHeader = `Basic ${btoa(opts.auth)}`;
	}

	static fromEnv(env: Env): Neo4jClient {
		return new Neo4jClient({ url: env.NEO4J_URL, auth: env.NEO4J_AUTH });
	}

	async execute(statements: Neo4jStatement[]): Promise<Neo4jResponse> {
		// No-op unless a viz trace is active (see src/viz/trace.ts)
		recordStatements(
			statements.map((s) => ({ statement: s.statement, params: s.parameters })),
		);
		const res = await fetch(this.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: this.authHeader,
			},
			body: JSON.stringify({ statements }),
		});
		if (!res.ok) {
			throw new Error(`Neo4j HTTP ${res.status}: ${await res.text()}`);
		}
		const data = (await res.json()) as Neo4jResponse;
		if (data.errors?.length) {
			throw new Error(
				data.errors.map((e) => `[${e.code}] ${e.message}`).join("; "),
			);
		}
		return data;
	}

	async query(
		cypher: string,
		params?: Record<string, unknown>,
	): Promise<unknown[][]> {
		const data = await this.execute([
			{ statement: cypher, parameters: params },
		]);
		return data.results[0].data.map((d) => d.row);
	}

	rows(result: Neo4jResponse, idx = 0): unknown[][] {
		return result.results[idx]?.data.map((d) => d.row) ?? [];
	}

	rowCount(result: Neo4jResponse, idx = 0): number {
		return result.results[idx]?.data.length ?? 0;
	}

	rowCounts(result: Neo4jResponse): number[] {
		return result.results.map((r) => r.data.length);
	}

	async health(): Promise<{
		connected: boolean;
		version?: string;
		error?: string;
	}> {
		try {
			const rows = await this.query(
				"CALL dbms.components() YIELD name, versions RETURN name, versions[0]",
			);
			return { connected: true, version: rows[0]?.[1] as string };
		} catch (error) {
			return {
				connected: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
}
