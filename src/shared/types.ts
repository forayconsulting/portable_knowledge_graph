import type { Neo4jClient } from "../neo4j/client";

export type Role = "reader" | "writer" | "admin";

export interface SessionContext {
	neo4j: Neo4jClient;
	role: Role;
	email: string;
	graphId: string;
}

export type GraphState =
	| "provisioning"
	| "bootstrapping"
	| "ready"
	| "failed"
	| "deleting";

export interface GraphRecord {
	graph_id: string;
	display_name: string;
	neo4j_url: string;
	encrypted_neo4j_auth: string;
	encryption_iv: string;
	owner_email: string;
	users: Record<string, Role>;
	default_role: Role | null;
	state: GraphState;
	railway_project_id?: string;
	railway_service_id?: string;
	railway_environment_id?: string;
	error_message?: string;
	created_at: string;
	updated_at: string;
}
