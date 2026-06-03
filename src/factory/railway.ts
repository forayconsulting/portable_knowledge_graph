const RAILWAY_API = "https://backboard.railway.com/graphql/v2";

export class RailwayClient {
	private token: string;

	constructor(token: string) {
		this.token = token;
	}

	private async gql<T>(
		query: string,
		variables?: Record<string, unknown>,
	): Promise<T> {
		const res = await fetch(RAILWAY_API, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.token}`,
			},
			body: JSON.stringify({ query, variables }),
		});
		if (!res.ok) {
			throw new Error(`Railway API ${res.status}: ${await res.text()}`);
		}
		const body = (await res.json()) as {
			data?: T;
			errors?: Array<{ message: string }>;
		};
		if (body.errors?.length) {
			throw new Error(
				`Railway: ${body.errors.map((e) => e.message).join("; ")}`,
			);
		}
		if (!body.data) throw new Error("Railway: empty response");
		return body.data;
	}

	async createProject(
		name: string,
	): Promise<{ projectId: string; environmentId: string }> {
		const data = await this.gql<{
			projectCreate: {
				id: string;
				environments: { edges: Array<{ node: { id: string } }> };
			};
		}>(
			`mutation($input: ProjectCreateInput!) {
				projectCreate(input: $input) {
					id
					environments { edges { node { id } } }
				}
			}`,
			{ input: { name } },
		);
		return {
			projectId: data.projectCreate.id,
			environmentId: data.projectCreate.environments.edges[0].node.id,
		};
	}

	async createService(
		projectId: string,
		image: string,
	): Promise<{ serviceId: string }> {
		const data = await this.gql<{ serviceCreate: { id: string } }>(
			`mutation($input: ServiceCreateInput!) {
				serviceCreate(input: $input) { id }
			}`,
			{ input: { projectId, source: { image } } },
		);
		return { serviceId: data.serviceCreate.id };
	}

	async setVariable(
		projectId: string,
		environmentId: string,
		serviceId: string,
		name: string,
		value: string,
	): Promise<void> {
		await this.gql(
			`mutation($input: VariableUpsertInput!) {
				variableUpsert(input: $input)
			}`,
			{
				input: { projectId, environmentId, serviceId, name, value },
			},
		);
	}

	async createServiceDomain(
		serviceId: string,
		environmentId: string,
	): Promise<{ domain: string }> {
		const data = await this.gql<{
			serviceDomainCreate: { domain: string };
		}>(
			`mutation($input: ServiceDomainCreateInput!) {
				serviceDomainCreate(input: $input) { domain }
			}`,
			{ input: { serviceId, environmentId } },
		);
		return { domain: data.serviceDomainCreate.domain };
	}

	async getLatestDeploymentStatus(
		serviceId: string,
		environmentId: string,
	): Promise<string> {
		const data = await this.gql<{
			deployments: { edges: Array<{ node: { status: string } }> };
		}>(
			`query($input: DeploymentListInput!) {
				deployments(input: $input, first: 1) {
					edges { node { status } }
				}
			}`,
			{ input: { serviceId, environmentId } },
		);
		return data.deployments.edges[0]?.node.status ?? "UNKNOWN";
	}

	async redeployService(
		serviceId: string,
		environmentId: string,
	): Promise<void> {
		await this.gql(
			`mutation($serviceId: String!, $environmentId: String!) {
				serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
			}`,
			{ serviceId, environmentId },
		);
	}

	async deleteProject(projectId: string): Promise<void> {
		await this.gql(
			`mutation($id: String!) {
				projectDelete(id: $id)
			}`,
			{ id: projectId },
		);
	}
}
