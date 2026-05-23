import type { Neo4jResponse, Neo4jStatement } from "./types";

export class Neo4jClient {
	private url: string;
	private authHeader: string;

	constructor(env: Env) {
		this.url = env.NEO4J_URL;
		this.authHeader = `Basic ${btoa(env.NEO4J_AUTH)}`;
	}

	async execute(statements: Neo4jStatement[]): Promise<Neo4jResponse> {
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
