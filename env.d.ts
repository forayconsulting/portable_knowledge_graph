// Minimal typing for the nodejs_compat runtime module — avoids pulling in
// @types/node, whose globals conflict with @cloudflare/workers-types.
declare module "node:async_hooks" {
	export class AsyncLocalStorage<T> {
		getStore(): T | undefined;
		run<R>(store: T, callback: (...args: unknown[]) => R): R;
	}
}

interface Env {
	NEO4J_URL: string;
	NEO4J_AUTH: string;
	OAUTH_KV: KVNamespace;
	CF_ACCESS_TEAM_DOMAIN: string;
	MCP_OBJECT: DurableObjectNamespace;
	KG_KV: KVNamespace;
	GRAPH_REGISTRY: DurableObjectNamespace;
	GRAPH_ENCRYPTION_KEY: string;
	VIZ_HUB: DurableObjectNamespace;
	ASSETS: Fetcher;
}
