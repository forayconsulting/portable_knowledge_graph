import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { allBootstrapStatements } from "../neo4j/bootstrap";
import { Neo4jClient } from "../neo4j/client";
import type { GraphRegistry } from "../registry/graph-registry";
import { encrypt } from "../shared/crypto";
import { RailwayClient } from "./railway";

interface ProvisionParams {
	graphId: string;
	displayName: string;
	ownerEmail: string;
}

export class ProvisionGraphWorkflow extends WorkflowEntrypoint<
	FactoryEnv,
	ProvisionParams
> {
	async run(event: WorkflowEvent<ProvisionParams>, step: WorkflowStep) {
		const { graphId, displayName } = event.payload;
		const railway = new RailwayClient(this.env.RAILWAY_API_TOKEN);

		const getRegistry = (): DurableObjectStub & GraphRegistry => {
			const id = this.env.GRAPH_REGISTRY.idFromName("global");
			return this.env.GRAPH_REGISTRY.get(id) as DurableObjectStub &
				GraphRegistry;
		};

		let projectId: string | null = null;

		try {
			// Step 1: Create Railway project
			const project = await step.do(
				"create-railway-project",
				{ retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
				async () => {
					return railway.createProject(`kg-${graphId}`);
				},
			);
			projectId = project.projectId;

			// Step 2: Create Neo4j service
			const service = await step.do(
				"create-neo4j-service",
				{ retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
				async () => {
					return railway.createService(project.projectId, "neo4j:5-community");
				},
			);

			// Step 3: Generate password and set environment variables
			const password = await step.do("set-env-vars", async () => {
				const pw = `kg-${crypto.randomUUID()}`;
				await railway.setVariable(
					project.projectId,
					project.environmentId,
					service.serviceId,
					"NEO4J_AUTH",
					`neo4j/${pw}`,
				);
				await railway.setVariable(
					project.projectId,
					project.environmentId,
					service.serviceId,
					"NEO4J_PLUGINS",
					'["apoc"]',
				);
				return pw;
			});

			// Step 4: Create public domain
			const domain = await step.do("create-domain", async () => {
				return railway.createServiceDomain(
					service.serviceId,
					project.environmentId,
				);
			});

			// Step 5: Redeploy to pick up env vars
			await step.do("redeploy", async () => {
				await railway.redeployService(service.serviceId, project.environmentId);
			});

			// Step 6: Wait for service to be healthy
			await step.do(
				"wait-healthy",
				{
					retries: { limit: 30, delay: "10 seconds", backoff: "linear" },
					timeout: "5 minutes",
				},
				async () => {
					const neo4j = new Neo4jClient({
						url: `https://${domain.domain}/db/neo4j/tx/commit`,
						auth: `neo4j:${password}`,
					});
					const health = await neo4j.health();
					if (!health.connected) {
						throw new Error(`Neo4j not healthy: ${health.error ?? "unknown"}`);
					}
					return health;
				},
			);

			// Step 7: Mark bootstrapping
			await step.do("mark-bootstrapping", async () => {
				await getRegistry().updateGraphState(graphId, "bootstrapping");
			});

			// Step 8: Run bootstrap schema
			await step.do(
				"bootstrap-schema",
				{ retries: { limit: 3, delay: "5 seconds" } },
				async () => {
					const neo4j = new Neo4jClient({
						url: `https://${domain.domain}/db/neo4j/tx/commit`,
						auth: `neo4j:${password}`,
					});
					const stmts = allBootstrapStatements();
					// DDL statements one at a time for Neo4j
					for (const stmt of stmts) {
						await neo4j.execute([stmt]);
					}
				},
			);

			// Step 9: Encrypt credentials and finalize
			await step.do("finalize", async () => {
				const { ciphertext, iv } = await encrypt(
					`neo4j:${password}`,
					this.env.GRAPH_ENCRYPTION_KEY,
				);
				await getRegistry().updateGraph(graphId, {
					neo4j_url: `https://${domain.domain}/db/neo4j/tx/commit`,
					encrypted_neo4j_auth: ciphertext,
					encryption_iv: iv,
					railway_project_id: project.projectId,
					railway_service_id: service.serviceId,
					railway_environment_id: project.environmentId,
					state: "ready",
					error_message: undefined,
				});
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`Provision failed for ${graphId}: ${message}`);

			// Compensating action: clean up Railway project
			if (projectId) {
				await step.do("cleanup-railway-project", async () => {
					try {
						await railway.deleteProject(projectId!);
					} catch (cleanupErr) {
						console.error("Cleanup failed:", cleanupErr);
					}
				});
			}

			// Mark graph as failed
			await step.do("mark-failed", async () => {
				await getRegistry().updateGraphState(graphId, "failed", message);
			});

			throw error;
		}
	}
}
