interface FactoryEnv {
	GRAPH_REGISTRY: DurableObjectNamespace;
	GRAPH_ENCRYPTION_KEY: string;
	RAILWAY_API_TOKEN: string;
	FACTORY_ADMINS: string;
	CF_ACCESS_TEAM_DOMAIN: string;
	PROVISION_WORKFLOW: Workflow;
	FLEET_BOOTSTRAP_WORKFLOW: Workflow;
}
