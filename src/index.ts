import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { getOAuthApi, OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { Neo4jClient } from "./neo4j/client";
import { registerPrompts } from "./prompts/workflows";
import type { GraphRegistry } from "./registry/graph-registry";
import { registerResources } from "./resources/schema";
import { decrypt } from "./shared/crypto";
import {
	ANALYZE_ACTIONS,
	ENTITY_ACTIONS,
	NAMESPACE_ACTIONS,
	ONTOLOGY_ACTIONS,
	RELATE_ACTIONS,
	SOURCE_ACTIONS,
	TOOL_ACCESS,
} from "./shared/roles";
import type { Role, SessionContext } from "./shared/types";
import { registerAdminTool } from "./tools/admin";
import { registerAnalyzeTool } from "./tools/analyze";
import { registerEntityTool } from "./tools/entity";
import { registerIngestTool } from "./tools/ingest";
import { registerNamespaceTool } from "./tools/namespace";
import { registerOntologyTool } from "./tools/ontology";
import { registerRelateTool } from "./tools/relate";
import { registerSearchTool } from "./tools/search";
import { registerSourceTool } from "./tools/source";
import { registerTraverseTool } from "./tools/traverse";
import { registerVectorSearchTool } from "./tools/vector-search";
import { handleVizRequest } from "./viz/api";
import { type VizEmitter, wrapServerForViz } from "./viz/events";
import type { VizHub } from "./viz/hub";

export { VizHub } from "./viz/hub";

export class KnowledgeGraphMCP extends McpAgent<
	Env,
	unknown,
	{ email: string; graph_id?: string }
> {
	server = new McpServer({
		name: "knowledge-graph",
		version: "1.0.0",
	});

	async init() {
		const ctx = await this.buildSessionContext();
		this.registerToolsForRole(ctx);
	}

	private async buildSessionContext(): Promise<SessionContext> {
		const email = this.props?.email ?? "";
		const graphId = this.props?.graph_id;

		// Multi-tenant path: graph_id is present
		if (graphId && this.env.GRAPH_REGISTRY) {
			const registryId = this.env.GRAPH_REGISTRY.idFromName("global");
			const registry = this.env.GRAPH_REGISTRY.get(
				registryId,
			) as DurableObjectStub & GraphRegistry;

			const record = await registry.getGraph(graphId);
			if (!record || record.state !== "ready") {
				throw new Error(
					`Graph "${graphId}" is not available (state: ${record?.state ?? "not found"})`,
				);
			}

			const role = await registry.resolveRole(graphId, email);
			if (!role) {
				throw new Error(`Access denied for ${email} on graph ${graphId}`);
			}

			const auth = await decrypt(
				record.encrypted_neo4j_auth,
				record.encryption_iv,
				this.env.GRAPH_ENCRYPTION_KEY,
			);

			const neo4j = new Neo4jClient({ url: record.neo4j_url, auth });
			return { neo4j, role, email, graphId };
		}

		// Fallback: single-tenant mode using env vars
		const neo4j = Neo4jClient.fromEnv(this.env);
		return { neo4j, role: "admin", email, graphId: "" };
	}

	/**
	 * Best-effort emitter publishing tool-call events to the per-graph VizHub
	 * so connected viz clients can highlight what Claude is examining. Never
	 * throws and never blocks the tool call.
	 */
	private buildVizEmitter(ctx: SessionContext): VizEmitter | null {
		if (!this.env.VIZ_HUB) return null;
		// Single-tenant fallback sessions (graphId "") share the reserved
		// "default" hub, matching the /viz/default viewer route.
		const hubId = this.env.VIZ_HUB.idFromName(ctx.graphId || "default");
		const hub = this.env.VIZ_HUB.get(hubId) as DurableObjectStub & VizHub;
		return (event) => {
			const delivery = hub.publish(event).catch(() => {});
			this.ctx?.waitUntil?.(delivery);
		};
	}

	private registerToolsForRole(ctx: SessionContext) {
		const { role } = ctx;

		const emit = this.buildVizEmitter(ctx);
		const server = emit
			? wrapServerForViz(this.server, {
					graphId: ctx.graphId || "default",
					email: ctx.email,
					emit,
				})
			: this.server;

		// Always registered (all roles)
		registerSearchTool(server, ctx);
		registerVectorSearchTool(server, ctx);
		registerTraverseTool(server, ctx);

		// Multi-action tools with role-filtered actions
		registerAnalyzeTool(server, ctx, ANALYZE_ACTIONS[role]);
		registerEntityTool(server, ctx, ENTITY_ACTIONS[role]);
		registerRelateTool(server, ctx, RELATE_ACTIONS[role]);
		registerSourceTool(server, ctx, SOURCE_ACTIONS[role]);
		registerOntologyTool(server, ctx, ONTOLOGY_ACTIONS[role]);
		registerNamespaceTool(server, ctx, NAMESPACE_ACTIONS[role]);

		// Single-tier tools
		if ((TOOL_ACCESS.ingest as readonly Role[]).includes(role)) {
			registerIngestTool(server, ctx);
		}
		if ((TOOL_ACCESS.admin as readonly Role[]).includes(role)) {
			registerAdminTool(server, ctx);
		}

		// Resources and prompts
		registerResources(this.server, ctx);
		registerPrompts(this.server);
	}
}

async function handleHealth(env: Env): Promise<Response> {
	const neo4j = Neo4jClient.fromEnv(env);
	const health = await neo4j.health();
	return Response.json({
		status: health.connected ? "ok" : "error",
		neo4j: health.connected ? "connected" : "disconnected",
		version: health.version,
		error: health.error,
		timestamp: new Date().toISOString(),
	});
}

// Wrap the agents handler to extract graph-id from URL and inject into props
const innerMcpHandler = KnowledgeGraphMCP.serve("/mcp");

const mcpApiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const ctxWithProps = ctx as ExecutionContext & {
			props?: Record<string, unknown>;
		};
		const url = new URL(request.url);

		// Extract graph-id from /mcp/{graph-id}
		const match = url.pathname.match(
			/^\/mcp\/([a-z0-9][a-z0-9-]*[a-z0-9])(\/.*)?$/,
		);
		if (match) {
			if (ctxWithProps.props) {
				ctxWithProps.props.graph_id = match[1];
			}
			// Rewrite URL to /mcp so the agents framework URLPattern matches
			const rewritten = new URL(request.url);
			rewritten.pathname = `/mcp${match[2] ?? ""}`;
			// For plain /mcp/{graph-id} (no trailing path), rewrite to /mcp
			if (!match[2]) {
				rewritten.pathname = "/mcp";
			}
			return innerMcpHandler.fetch(new Request(rewritten, request), env, ctx);
		}

		// Plain /mcp without graph-id — still supported for backward compat
		return innerMcpHandler.fetch(request, env, ctx);
	},
};

const providerOptions: OAuthProviderOptions<Env> = {
	apiRoute: "/mcp",
	apiHandler: mcpApiHandler,

	defaultHandler: {
		async fetch(request: Request, env: Env, ctx: ExecutionContext) {
			const url = new URL(request.url);

			if (url.pathname === "/health") {
				return handleHealth(env);
			}

			if (url.pathname === "/viz" || url.pathname.startsWith("/viz/")) {
				return handleVizRequest(request, env);
			}

			if (url.pathname === "/authorize") {
				const email = request.headers.get("CF-Access-Authenticated-User-Email");
				if (!email) {
					return new Response(
						"Unauthorized: Cloudflare Access authentication required",
						{ status: 401 },
					);
				}

				const oauthApi = getOAuthApi(providerOptions, env);
				const authRequest = await oauthApi.parseAuthRequest(request);
				const { redirectTo } = await oauthApi.completeAuthorization({
					request: authRequest,
					userId: email,
					metadata: { email },
					scope: authRequest.scope,
					props: { email },
				});

				return Response.redirect(redirectTo, 302);
			}

			return new Response("Not Found", { status: 404 });
		},
	},

	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
};

export default new OAuthProvider<Env>(providerOptions);
