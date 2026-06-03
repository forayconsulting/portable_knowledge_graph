import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { WorkflowEntrypoint } from "cloudflare:workers";
import { allBootstrapStatements } from "../neo4j/bootstrap";
import { Neo4jClient } from "../neo4j/client";
import type { GraphRegistry } from "../registry/graph-registry";
import { decrypt } from "../shared/crypto";

export class FleetBootstrapWorkflow extends WorkflowEntrypoint<FactoryEnv> {
	async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
		const getRegistry = (): DurableObjectStub & GraphRegistry => {
			const id = this.env.GRAPH_REGISTRY.idFromName("global");
			return this.env.GRAPH_REGISTRY.get(id) as DurableObjectStub &
				GraphRegistry;
		};

		const graphs = await step.do("list-ready-graphs", async () => {
			return getRegistry().listAllReadyGraphs();
		});

		const stmts = allBootstrapStatements();
		const results: Array<{
			graph_id: string;
			success: boolean;
			error?: string;
		}> = [];

		for (const graph of graphs) {
			const result = await step.do(
				`bootstrap-${graph.graph_id}`,
				{ retries: { limit: 2, delay: "5 seconds" } },
				async () => {
					try {
						const auth = await decrypt(
							graph.encrypted_neo4j_auth,
							graph.encryption_iv,
							this.env.GRAPH_ENCRYPTION_KEY,
						);
						const neo4j = new Neo4jClient({ url: graph.neo4j_url, auth });

						for (const stmt of stmts) {
							await neo4j.execute([stmt]);
						}
						return { graph_id: graph.graph_id, success: true };
					} catch (err) {
						return {
							graph_id: graph.graph_id,
							success: false,
							error: err instanceof Error ? err.message : String(err),
						};
					}
				},
			);
			results.push(result);
		}

		return {
			total: graphs.length,
			succeeded: results.filter((r) => r.success).length,
			failed: results.filter((r) => !r.success).length,
			results,
		};
	}
}
