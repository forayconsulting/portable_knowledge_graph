import { AsyncLocalStorage } from "node:async_hooks";

export interface CapturedStatement {
	statement: string;
	params?: Record<string, unknown>;
}

export interface CypherCapture {
	statements: CapturedStatement[];
}

// Lives in its own module so neo4j/client.ts can import it without
// pulling in the rest of the viz event pipeline (avoids import cycles).
export const cypherTrace = new AsyncLocalStorage<CypherCapture>();

export function recordStatements(statements: CapturedStatement[]): void {
	const store = cypherTrace.getStore();
	if (store) {
		store.statements.push(...statements);
	}
}
