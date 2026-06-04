import { getAuthenticatedEmail } from "./auth";
import {
	handleCreateGraph,
	handleDeleteGraph,
	handleFleetMigrate,
	handleGetGraph,
	handleListGraphs,
	handleUpdatePermissions,
} from "./routes";

export { GraphRegistry } from "../registry/graph-registry";
export { FleetBootstrapWorkflow } from "./fleet-bootstrap-workflow";
export { ProvisionGraphWorkflow } from "./provision-workflow";

export default {
	async fetch(request: Request, env: FactoryEnv): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		if (path === "/health") {
			return Response.json({ status: "ok", service: "kg-factory" });
		}

		const email = getAuthenticatedEmail(request);
		if (!email) {
			return Response.json(
				{ error: "Unauthorized: Cloudflare Access authentication required" },
				{ status: 401 },
			);
		}

		// POST /graphs — start provisioning
		if (path === "/graphs" && request.method === "POST") {
			return handleCreateGraph(request, env, email);
		}

		// GET /graphs — list accessible graphs
		if (path === "/graphs" && request.method === "GET") {
			return handleListGraphs(env, email);
		}

		// POST /graphs/_migrate — fleet bootstrap
		if (path === "/graphs/_migrate" && request.method === "POST") {
			return handleFleetMigrate(env, email);
		}

		// GET /graphs/{id}
		const graphIdMatch = path.match(/^\/graphs\/([a-z0-9][a-z0-9-]*[a-z0-9])$/);
		if (graphIdMatch && request.method === "GET") {
			return handleGetGraph(graphIdMatch[1], env, email);
		}

		// DELETE /graphs/{id}
		if (graphIdMatch && request.method === "DELETE") {
			return handleDeleteGraph(request, graphIdMatch[1], env, email);
		}

		// PUT /graphs/{id}/permissions
		const permMatch = path.match(
			/^\/graphs\/([a-z0-9][a-z0-9-]*[a-z0-9])\/permissions$/,
		);
		if (permMatch && request.method === "PUT") {
			return handleUpdatePermissions(request, permMatch[1], env, email);
		}

		return Response.json({ error: "Not Found" }, { status: 404 });
	},
};
