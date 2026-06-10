import { Neo4jClient } from "../neo4j/client";
import type { GraphRegistry } from "../registry/graph-registry";
import { decrypt } from "../shared/crypto";
import type { Role } from "../shared/types";

const DEFAULT_NODE_LIMIT = 2000;
const MAX_NODE_LIMIT = 5000;
const EDGE_LIMIT = 10000;
const NODE_DETAIL_REL_LIMIT = 100;

interface VizContext {
	neo4j: Neo4jClient;
	role: Role;
	email: string;
	graphId: string;
	displayName: string;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		},
	});
}

function errorResponse(status: number, message: string): Response {
	return json({ error: message }, status);
}

/**
 * Resolves a read-only viz context for a graph. Trust model mirrors the MCP
 * /authorize flow: Cloudflare Access sits in front of the Worker and injects
 * the authenticated email header. The reserved graph-id "default" maps to the
 * single-tenant fallback instance (env NEO4J_URL), consistent with MCP
 * sessions that connect without a graph-id.
 */
async function resolveVizContext(
	request: Request,
	env: Env,
	graphId: string,
): Promise<VizContext | Response> {
	const email = request.headers.get("CF-Access-Authenticated-User-Email");
	if (!email) {
		return errorResponse(
			401,
			"Unauthorized: Cloudflare Access authentication required",
		);
	}

	if (env.GRAPH_REGISTRY) {
		const registryId = env.GRAPH_REGISTRY.idFromName("global");
		const registry = env.GRAPH_REGISTRY.get(registryId) as DurableObjectStub &
			GraphRegistry;

		let record: Awaited<ReturnType<GraphRegistry["getGraph"]>> = null;
		try {
			record = await registry.getGraph(graphId);
		} catch {
			// Registry unreachable (e.g. local dev without kg-factory) —
			// fall through to the single-tenant fallback below.
		}

		if (record) {
			if (record.state !== "ready") {
				return errorResponse(
					404,
					`Graph "${graphId}" is not available (state: ${record.state})`,
				);
			}
			const role = await registry.resolveRole(graphId, email);
			if (!role) {
				return errorResponse(403, `Access denied for ${email} on ${graphId}`);
			}
			const auth = await decrypt(
				record.encrypted_neo4j_auth,
				record.encryption_iv,
				env.GRAPH_ENCRYPTION_KEY,
			);
			return {
				neo4j: new Neo4jClient({ url: record.neo4j_url, auth }),
				role,
				email,
				graphId,
				displayName: record.display_name,
			};
		}
	}

	// Single-tenant fallback: any Access-authenticated user may view, matching
	// the MCP fallback path which grants access to authenticated sessions.
	if (graphId === "default" && env.NEO4J_URL && env.NEO4J_AUTH) {
		return {
			neo4j: Neo4jClient.fromEnv(env),
			role: "reader",
			email,
			graphId,
			displayName: "Knowledge Graph",
		};
	}

	return errorResponse(404, `Graph "${graphId}" not found`);
}

async function handleMeta(ctx: VizContext): Promise<Response> {
	const result = await ctx.neo4j.execute([
		{ statement: "MATCH (e:Entity) RETURN count(e)" },
		{
			statement:
				"MATCH (e:Entity) RETURN coalesce(e.entity_type, '(untyped)'), count(*) ORDER BY count(*) DESC",
		},
		{
			statement:
				"MATCH (e:Entity) RETURN coalesce(e.namespace, '(global)'), count(*) ORDER BY count(*) DESC",
		},
		{
			statement:
				"MATCH (:Entity)-[r:RELATES_TO]->(:Entity) RETURN coalesce(r.type, 'RELATES_TO'), count(*) ORDER BY count(*) DESC",
		},
		{ statement: "MATCH (t:Tag) RETURN count(t)" },
		{ statement: "MATCH (s:Source) RETURN count(s)" },
	]);

	const toRecord = (rows: unknown[][]): Record<string, number> =>
		Object.fromEntries(rows.map((r) => [String(r[0]), Number(r[1])]));

	return json({
		graph_id: ctx.graphId,
		display_name: ctx.displayName,
		role: ctx.role,
		node_count: Number(ctx.neo4j.rows(result, 0)[0]?.[0] ?? 0),
		nodes_by_type: toRecord(ctx.neo4j.rows(result, 1)),
		nodes_by_namespace: toRecord(ctx.neo4j.rows(result, 2)),
		edges_by_type: toRecord(ctx.neo4j.rows(result, 3)),
		tag_count: Number(ctx.neo4j.rows(result, 4)[0]?.[0] ?? 0),
		source_count: Number(ctx.neo4j.rows(result, 5)[0]?.[0] ?? 0),
	});
}

function decodeCursor(
	cursor: string,
): { created_at: string; id: string } | null {
	try {
		const [created_at, id] = atob(cursor).split("|");
		if (!created_at || !id) return null;
		return { created_at, id };
	} catch {
		return null;
	}
}

async function handleGraphSnapshot(
	ctx: VizContext,
	url: URL,
): Promise<Response> {
	const limit = Math.min(
		Number(url.searchParams.get("limit")) || DEFAULT_NODE_LIMIT,
		MAX_NODE_LIMIT,
	);
	const namespace = url.searchParams.get("namespace");
	const cursorParam = url.searchParams.get("cursor");
	const cursor = cursorParam ? decodeCursor(cursorParam) : null;
	if (cursorParam && !cursor) {
		return errorResponse(400, "Invalid cursor");
	}

	const params: Record<string, unknown> = {
		limit: limit + 1,
		namespace: namespace ?? null,
		cursor_at: cursor?.created_at ?? null,
		cursor_id: cursor?.id ?? null,
	};

	const result = await ctx.neo4j.execute([
		{
			// Nodes ordered by (created_at, id) for stable pagination; the same
			// payload drives the playback timeline client-side.
			statement: `MATCH (e:Entity)
				WHERE ($namespace IS NULL OR e.namespace = $namespace)
				  AND ($cursor_at IS NULL
				       OR e.created_at > datetime($cursor_at)
				       OR (e.created_at = datetime($cursor_at) AND e.id > $cursor_id))
				WITH e ORDER BY e.created_at ASC, e.id ASC LIMIT $limit
				RETURN e.id, e.name, e.entity_type, e.namespace,
				       left(coalesce(e.summary, ''), 160),
				       e.epistemic_status, e.confidence,
				       toString(e.created_at), e.created_by,
				       COUNT { (e)--() },
				       [(e)-[:TAGGED_WITH]->(t:Tag) | t.name]`,
			parameters: params,
		},
		{
			// Edge timestamps coalesce to the later endpoint's created_at so
			// hand-created edges without timestamps still order correctly.
			statement: `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
				WHERE ($namespace IS NULL OR (a.namespace = $namespace AND b.namespace = $namespace))
				RETURN a.id, b.id, coalesce(r.type, 'RELATES_TO'),
				       toString(coalesce(r.created_at,
				         CASE WHEN a.created_at > b.created_at THEN a.created_at ELSE b.created_at END))
				LIMIT ${EDGE_LIMIT}`,
			parameters: { namespace: namespace ?? null },
		},
	]);

	const nodeRows = ctx.neo4j.rows(result, 0);
	const hasMore = nodeRows.length > limit;
	const pageRows = hasMore ? nodeRows.slice(0, limit) : nodeRows;

	const nodes = pageRows.map((r) => ({
		id: r[0],
		name: r[1],
		entity_type: r[2],
		namespace: r[3],
		summary: r[4],
		epistemic_status: r[5],
		confidence: r[6],
		created_at: r[7],
		created_by: r[8],
		degree: r[9],
		tags: r[10],
	}));

	const edges = ctx.neo4j.rows(result, 1).map((r) => ({
		from: r[0],
		to: r[1],
		rel_type: r[2],
		created_at: r[3],
	}));

	const last = pageRows[pageRows.length - 1];
	const nextCursor =
		hasMore && last ? btoa(`${String(last[7])}|${String(last[0])}`) : null;

	return json({
		nodes,
		edges,
		node_count: nodes.length,
		edge_count: edges.length,
		has_more: hasMore,
		next_cursor: nextCursor,
	});
}

async function handleNodeDetail(
	ctx: VizContext,
	nodeId: string,
): Promise<Response> {
	const result = await ctx.neo4j.execute([
		{
			statement: `MATCH (e:Entity {id: $id})
				RETURN properties(e), toString(e.created_at),
				       [(e)-[:TAGGED_WITH]->(t:Tag) | {name: t.name, tag_group: t.tag_group}],
				       [(e)-[sf:SOURCED_FROM]->(s:Source) | {
				         id: s.id, name: s.name, source_type: s.source_type, uri: s.uri,
				         confidence: sf.confidence, excerpt: sf.excerpt
				       }]`,
			parameters: { id: nodeId },
		},
		{
			statement: `MATCH (e:Entity {id: $id})-[r:RELATES_TO]-(other:Entity)
				RETURN coalesce(r.type, 'RELATES_TO'),
				       startNode(r).id = $id,
				       other.id, other.name, other.entity_type,
				       toString(r.created_at)
				ORDER BY r.created_at ASC
				LIMIT ${NODE_DETAIL_REL_LIMIT}`,
			parameters: { id: nodeId },
		},
	]);

	const row = ctx.neo4j.rows(result, 0)[0];
	if (!row) {
		return errorResponse(404, `Node "${nodeId}" not found`);
	}

	const props = { ...(row[0] as Record<string, unknown>) };
	// The embedding vector is large and meaningless to a human reader.
	const hasEmbedding = Array.isArray(props.embedding);
	delete props.embedding;
	if (typeof props.properties === "string") {
		try {
			props.properties = JSON.parse(props.properties);
		} catch {
			// leave as raw string
		}
	}

	const relationships = ctx.neo4j.rows(result, 1).map((r) => ({
		rel_type: r[0],
		direction: r[1] ? "out" : "in",
		other_id: r[2],
		other_name: r[3],
		other_entity_type: r[4],
		created_at: r[5],
	}));

	return json({
		properties: props,
		created_at: row[1],
		has_embedding: hasEmbedding,
		tags: row[2],
		sources: row[3],
		relationships,
	});
}

/**
 * Routes all /viz/* traffic: the read-only JSON API, the live-event
 * WebSocket, and the SPA shell + static assets. Mounted from the
 * OAuthProvider defaultHandler in src/index.ts.
 */
export async function handleVizRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	// Static assets (vite emits /viz/assets/*; strip the /viz prefix —
	// the assets directory is mounted at the URL root by the ASSETS binding)
	if (path.startsWith("/viz/assets/") || path === "/viz/favicon.svg") {
		const assetUrl = new URL(url);
		assetUrl.pathname = path.slice("/viz".length);
		return env.ASSETS.fetch(new Request(assetUrl, request));
	}

	// API: /viz/api/{graph-id}/...
	const apiMatch = path.match(/^\/viz\/api\/([a-z0-9][a-z0-9-]*)\/(.+)$/);
	if (apiMatch) {
		if (request.method !== "GET") {
			return errorResponse(405, "Viz API is read-only");
		}
		const ctx = await resolveVizContext(request, env, apiMatch[1]);
		if (ctx instanceof Response) return ctx;

		try {
			const sub = apiMatch[2];
			if (sub === "meta") return await handleMeta(ctx);
			if (sub === "graph") return await handleGraphSnapshot(ctx, url);
			const nodeMatch = sub.match(/^node\/(.+)$/);
			if (nodeMatch) {
				return await handleNodeDetail(ctx, decodeURIComponent(nodeMatch[1]));
			}
			return errorResponse(404, "Unknown viz API endpoint");
		} catch (error) {
			return errorResponse(
				502,
				`Graph query failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	// Live events: /viz/ws/{graph-id}
	const wsMatch = path.match(/^\/viz\/ws\/([a-z0-9][a-z0-9-]*)$/);
	if (wsMatch) {
		const ctx = await resolveVizContext(request, env, wsMatch[1]);
		if (ctx instanceof Response) return ctx;
		const hubId = env.VIZ_HUB.idFromName(ctx.graphId);
		return env.VIZ_HUB.get(hubId).fetch(request);
	}

	// SPA shell: /viz/{graph-id} (and bare /viz). Fetch "/" rather than
	// "/index.html" — the assets binding's html_handling 307-redirects the
	// explicit filename to the root path.
	const spaMatch = path.match(/^\/viz(\/[a-z0-9][a-z0-9-]*)?\/?$/);
	if (spaMatch) {
		const indexUrl = new URL(url);
		indexUrl.pathname = "/";
		return env.ASSETS.fetch(new Request(indexUrl, request));
	}

	return errorResponse(404, "Not found");
}
