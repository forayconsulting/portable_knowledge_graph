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

		const progress = async (stepName: string) => {
			await getRegistry().updateGraph(graphId, { provision_step: stepName });
		};

		try {
			await progress("creating-railway-project");
			const project = await step.do(
				"create-railway-project",
				async () => {
					return railway.createProject(`kg-${graphId}`);
				},
			);
			projectId = project.projectId;

			await progress("creating-neo4j-service");
			const service = await step.do(
				"create-neo4j-service",
				{ retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
				async () => {
					return railway.createService(project.projectId, "neo4j:5-community");
				},
			);

			await progress("configuring-environment");
			const password = await step.do("set-env-vars", { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } }, async () => {
				const pw = `kg-${crypto.randomUUID()}`;
				const vars: Record<string, string> = {
					NEO4J_AUTH: `neo4j/${pw}`,
					NEO4J_PLUGINS: '["apoc"]',
					PORT: "7474",
					NEO4J_dbms_connector_http_listen__address: ":7474",
					"NEO4J_dbms_security_procedures_unrestricted": "apoc.*",
				};
				for (const [name, value] of Object.entries(vars)) {
					await railway.setVariable(
						project.projectId,
						project.environmentId,
						service.serviceId,
						name,
						value,
					);
				}
				return pw;
			});

			await progress("creating-domain");
			const domain = await step.do("create-domain", { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } }, async () => {
				return railway.createServiceDomain(
					service.serviceId,
					project.environmentId,
				);
			});

			await progress("deploying-service");
			await step.do("redeploy", { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } }, async () => {
				await railway.redeployService(service.serviceId, project.environmentId);
			});

			await progress("waiting-for-neo4j");
			await step.do(
				"wait-healthy",
				{
					retries: { limit: 40, delay: "15 seconds", backoff: "constant" },
					timeout: "10 minutes",
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

			await step.do("mark-bootstrapping", async () => {
				await getRegistry().updateGraphState(graphId, "bootstrapping");
				await progress("bootstrapping-schema");
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
