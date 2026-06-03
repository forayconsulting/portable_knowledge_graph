import { DurableObject } from "cloudflare:workers";
import type { GraphRecord, GraphState, Role } from "../shared/types";

export class GraphRegistry extends DurableObject {
	private initialized = false;

	private ensureSchema() {
		if (this.initialized) return;
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS graphs (
				graph_id TEXT PRIMARY KEY,
				display_name TEXT NOT NULL,
				neo4j_url TEXT NOT NULL,
				encrypted_neo4j_auth TEXT NOT NULL,
				encryption_iv TEXT NOT NULL,
				owner_email TEXT NOT NULL,
				users TEXT NOT NULL DEFAULT '{}',
				default_role TEXT,
				state TEXT NOT NULL DEFAULT 'provisioning',
				railway_project_id TEXT,
				railway_service_id TEXT,
				railway_environment_id TEXT,
				error_message TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`);
		this.initialized = true;
	}

	private rowToRecord(row: Record<string, unknown>): GraphRecord {
		return {
			graph_id: row.graph_id as string,
			display_name: row.display_name as string,
			neo4j_url: row.neo4j_url as string,
			encrypted_neo4j_auth: row.encrypted_neo4j_auth as string,
			encryption_iv: row.encryption_iv as string,
			owner_email: row.owner_email as string,
			users: JSON.parse((row.users as string) || "{}"),
			default_role: (row.default_role as Role) ?? null,
			state: row.state as GraphState,
			railway_project_id: row.railway_project_id as string | undefined,
			railway_service_id: row.railway_service_id as string | undefined,
			railway_environment_id: row.railway_environment_id as string | undefined,
			error_message: row.error_message as string | undefined,
			created_at: row.created_at as string,
			updated_at: row.updated_at as string,
		};
	}

	async getGraph(graphId: string): Promise<GraphRecord | null> {
		this.ensureSchema();
		const cursor = this.ctx.storage.sql.exec(
			"SELECT * FROM graphs WHERE graph_id = ?",
			graphId,
		);
		const rows = [...cursor];
		if (!rows.length) return null;
		return this.rowToRecord(rows[0] as Record<string, unknown>);
	}

	async listGraphsForUser(email: string): Promise<GraphRecord[]> {
		this.ensureSchema();
		const cursor = this.ctx.storage.sql.exec("SELECT * FROM graphs");
		const all = [...cursor] as Array<Record<string, unknown>>;
		const domain = email.includes("@") ? `@${email.split("@")[1]}` : null;

		return all
			.map((row) => this.rowToRecord(row))
			.filter((g) => {
				if (g.owner_email === email) return true;
				if (g.users[email]) return true;
				if (domain && g.users[domain]) return true;
				if (g.default_role) return true;
				return false;
			});
	}

	async createGraph(
		record: Omit<GraphRecord, "created_at" | "updated_at">,
	): Promise<void> {
		this.ensureSchema();
		const now = new Date().toISOString();
		this.ctx.storage.sql.exec(
			`INSERT INTO graphs (
				graph_id, display_name, neo4j_url, encrypted_neo4j_auth, encryption_iv,
				owner_email, users, default_role, state,
				railway_project_id, railway_service_id, railway_environment_id,
				error_message, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			record.graph_id,
			record.display_name,
			record.neo4j_url,
			record.encrypted_neo4j_auth,
			record.encryption_iv,
			record.owner_email,
			JSON.stringify(record.users),
			record.default_role,
			record.state,
			record.railway_project_id ?? null,
			record.railway_service_id ?? null,
			record.railway_environment_id ?? null,
			record.error_message ?? null,
			now,
			now,
		);
	}

	async updateGraph(
		graphId: string,
		fields: Partial<GraphRecord>,
	): Promise<void> {
		this.ensureSchema();
		const sets: string[] = ["updated_at = ?"];
		const values: unknown[] = [new Date().toISOString()];

		for (const [key, value] of Object.entries(fields)) {
			if (key === "graph_id" || key === "created_at" || key === "updated_at")
				continue;
			const col = key;
			if (col === "users") {
				sets.push(`${col} = ?`);
				values.push(JSON.stringify(value));
			} else {
				sets.push(`${col} = ?`);
				values.push(value ?? null);
			}
		}

		values.push(graphId);
		this.ctx.storage.sql.exec(
			`UPDATE graphs SET ${sets.join(", ")} WHERE graph_id = ?`,
			...values,
		);
	}

	async updateGraphState(
		graphId: string,
		state: GraphState,
		errorMessage?: string,
	): Promise<void> {
		this.ensureSchema();
		this.ctx.storage.sql.exec(
			`UPDATE graphs SET state = ?, error_message = ?, updated_at = ? WHERE graph_id = ?`,
			state,
			errorMessage ?? null,
			new Date().toISOString(),
			graphId,
		);
	}

	async updatePermissions(
		graphId: string,
		users: Record<string, Role>,
		defaultRole: Role | null,
	): Promise<void> {
		this.ensureSchema();
		this.ctx.storage.sql.exec(
			`UPDATE graphs SET users = ?, default_role = ?, updated_at = ? WHERE graph_id = ?`,
			JSON.stringify(users),
			defaultRole,
			new Date().toISOString(),
			graphId,
		);
	}

	async deleteGraph(graphId: string): Promise<void> {
		this.ensureSchema();
		this.ctx.storage.sql.exec("DELETE FROM graphs WHERE graph_id = ?", graphId);
	}

	async listAllReadyGraphs(): Promise<GraphRecord[]> {
		this.ensureSchema();
		const cursor = this.ctx.storage.sql.exec(
			"SELECT * FROM graphs WHERE state = 'ready'",
		);
		return [...cursor].map((row) =>
			this.rowToRecord(row as Record<string, unknown>),
		);
	}

	async resolveRole(graphId: string, email: string): Promise<Role | null> {
		const record = await this.getGraph(graphId);
		if (!record) return null;

		if (record.owner_email === email) return "admin";

		if (record.users[email]) return record.users[email];

		if (email.includes("@")) {
			const domain = `@${email.split("@")[1]}`;
			if (record.users[domain]) return record.users[domain];
		}

		return record.default_role;
	}
}
