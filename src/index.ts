import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { Neo4jClient } from "./neo4j/client";
import { registerPrompts } from "./prompts/workflows";
import { registerResources } from "./resources/schema";
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

export class KnowledgeGraphMCP extends McpAgent<
	Env,
	unknown,
	Record<string, unknown>
> {
	server = new McpServer({
		name: "knowledge-graph",
		version: "1.0.0",
	});

	async init() {
		registerSearchTool(this.server, this.env);
		registerEntityTool(this.server, this.env);
		registerRelateTool(this.server, this.env);
		registerTraverseTool(this.server, this.env);
		registerIngestTool(this.server, this.env);
		registerOntologyTool(this.server, this.env);
		registerAnalyzeTool(this.server, this.env);
		registerSourceTool(this.server, this.env);
		registerAdminTool(this.server, this.env);
		registerNamespaceTool(this.server, this.env);
		registerResources(this.server, this.env);
		registerPrompts(this.server);
	}
}

async function handleHealth(env: Env): Promise<Response> {
	const neo4j = new Neo4jClient(env);
	const health = await neo4j.health();
	return Response.json({
		status: health.connected ? "ok" : "error",
		neo4j: health.connected ? "connected" : "disconnected",
		version: health.version,
		error: health.error,
		timestamp: new Date().toISOString(),
	});
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		const secretPath = `/mcp/${env.API_SECRET}`;

		if (url.pathname === "/health") {
			return handleHealth(env);
		}

		if (
			url.pathname === secretPath ||
			url.pathname.startsWith(`${secretPath}/`)
		) {
			return KnowledgeGraphMCP.serve(secretPath).fetch(request, env, ctx);
		}

		return new Response("Not Found", { status: 404 });
	},
};
