import type { GraphRegistry } from "../registry/graph-registry";
import { encrypt } from "../shared/crypto";
import type { Role } from "../shared/types";
import { isFactoryAdmin } from "./auth";

const GRAPH_ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

function getRegistry(env: FactoryEnv): DurableObjectStub & GraphRegistry {
	const id = env.GRAPH_REGISTRY.idFromName("global");
	return env.GRAPH_REGISTRY.get(id) as DurableObjectStub & GraphRegistry;
}

export async function handleCreateGraph(
	request: Request,
	env: FactoryEnv,
	email: string,
): Promise<Response> {
	if (!isFactoryAdmin(email, env)) {
		return json({ error: "Only factory admins can provision graphs" }, 403);
	}

	const body = (await request.json()) as {
		graph_id?: string;
		display_name?: string;
		owner_email?: string;
		users?: Record<string, Role>;
		default_role?: Role | null;
	};

	if (!body.graph_id || !body.display_name) {
		return json({ error: "graph_id and display_name are required" }, 400);
	}

	if (!GRAPH_ID_PATTERN.test(body.graph_id) || body.graph_id.length > 63) {
		return json(
			{
				error:
					"graph_id must be lowercase alphanumeric with hyphens, 2-63 chars",
			},
			400,
		);
	}

	const registry = getRegistry(env);
	const existing = await registry.getGraph(body.graph_id);
	if (existing) {
		return json({ error: `Graph "${body.graph_id}" already exists` }, 409);
	}

	const ownerEmail = body.owner_email ?? email;

	// Placeholder credentials — the workflow will fill in real ones
	const { ciphertext, iv } = await encrypt("pending", env.GRAPH_ENCRYPTION_KEY);

	await registry.createGraph({
		graph_id: body.graph_id,
		display_name: body.display_name,
		neo4j_url: "",
		encrypted_neo4j_auth: ciphertext,
		encryption_iv: iv,
		owner_email: ownerEmail,
		users: body.users ?? {},
		default_role: body.default_role ?? null,
		state: "provisioning",
	});

	const instance = await env.PROVISION_WORKFLOW.create({
		params: {
			graphId: body.graph_id,
			displayName: body.display_name,
			ownerEmail,
		},
	});

	return json(
		{
			graph_id: body.graph_id,
			state: "provisioning",
			workflow_id: instance.id,
		},
		202,
	);
}

export async function handleListGraphs(
	env: FactoryEnv,
	email: string,
): Promise<Response> {
	const registry = getRegistry(env);
	const graphs = await registry.listGraphsForUser(email);

	return json(
		graphs.map((g) => ({
			graph_id: g.graph_id,
			display_name: g.display_name,
			state: g.state,
			owner_email: g.owner_email,
			default_role: g.default_role,
			created_at: g.created_at,
		})),
	);
}

export async function handleGetGraph(
	graphId: string,
	env: FactoryEnv,
	email: string,
): Promise<Response> {
	const registry = getRegistry(env);
	const graph = await registry.getGraph(graphId);
	if (!graph) return json({ error: "Graph not found" }, 404);

	const role = await registry.resolveRole(graphId, email);
	if (!role && !isFactoryAdmin(email, env)) {
		return json({ error: "Access denied" }, 403);
	}

	return json({
		graph_id: graph.graph_id,
		display_name: graph.display_name,
		state: graph.state,
		owner_email: graph.owner_email,
		users: graph.users,
		default_role: graph.default_role,
		your_role: role ?? (isFactoryAdmin(email, env) ? "factory_admin" : null),
		error_message: graph.error_message,
		created_at: graph.created_at,
		updated_at: graph.updated_at,
	});
}

export async function handleUpdatePermissions(
	request: Request,
	graphId: string,
	env: FactoryEnv,
	email: string,
): Promise<Response> {
	const registry = getRegistry(env);
	const graph = await registry.getGraph(graphId);
	if (!graph) return json({ error: "Graph not found" }, 404);

	if (graph.owner_email !== email && !isFactoryAdmin(email, env)) {
		return json(
			{ error: "Only the owner or factory admins can update permissions" },
			403,
		);
	}

	const body = (await request.json()) as {
		users?: Record<string, Role>;
		default_role?: Role | null;
	};

	await registry.updatePermissions(
		graphId,
		body.users ?? graph.users,
		body.default_role !== undefined ? body.default_role : graph.default_role,
	);

	return json({ updated: true, graph_id: graphId });
}

export async function handleDeleteGraph(
	request: Request,
	graphId: string,
	env: FactoryEnv,
	email: string,
): Promise<Response> {
	const registry = getRegistry(env);
	const graph = await registry.getGraph(graphId);
	if (!graph) return json({ error: "Graph not found" }, 404);

	if (graph.owner_email !== email && !isFactoryAdmin(email, env)) {
		return json(
			{ error: "Only the owner or factory admins can delete graphs" },
			403,
		);
	}

	const body = (await request.json()) as { confirm_graph_id?: string };
	if (body.confirm_graph_id !== graphId) {
		return json(
			{ error: "Must include confirm_graph_id matching the graph ID" },
			400,
		);
	}

	await registry.updateGraphState(graphId, "deleting");

	// Delete Railway project if it exists
	if (graph.railway_project_id) {
		try {
			const { RailwayClient } = await import("./railway");
			const railway = new RailwayClient(env.RAILWAY_API_TOKEN);
			await railway.deleteProject(graph.railway_project_id);
		} catch (err) {
			console.error("Railway project deletion failed:", err);
		}
	}

	await registry.deleteGraph(graphId);
	return json({ deleted: true, graph_id: graphId });
}

export async function handleFleetMigrate(
	env: FactoryEnv,
	email: string,
): Promise<Response> {
	if (!isFactoryAdmin(email, env)) {
		return json(
			{ error: "Only factory admins can trigger fleet migration" },
			403,
		);
	}

	const instance = await env.FLEET_BOOTSTRAP_WORKFLOW.create({});

	return json({ workflow_id: instance.id, state: "running" }, 202);
}
