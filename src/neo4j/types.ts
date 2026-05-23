export interface Neo4jStatement {
	statement: string;
	parameters?: Record<string, unknown>;
}

export interface Neo4jResultSet {
	columns: string[];
	data: Array<{ row: unknown[]; meta: unknown[] }>;
}

export interface Neo4jResponse {
	results: Neo4jResultSet[];
	errors: Array<{ code: string; message: string }>;
}
