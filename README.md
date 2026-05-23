# Portable Knowledge Graph

A knowledge graph that lives in the cloud and works from anywhere. Neo4j on Railway for storage, a Cloudflare Worker as the interface, and Claude as the brain.

## The idea

Most knowledge graphs require you to run infrastructure locally, wire up ETL pipelines, and write custom ingestion code before you can store a single fact. This one doesn't.

You connect it to Claude as a remote tool. Then you just talk to it. Claude reads your documents, pulls out the important pieces, decides how they relate to each other, and writes everything into the graph. No pipelines. No preprocessing. No local setup.

The graph is empty until you need it to not be. Ask Claude to ingest a research paper, a technical spec, meeting notes, a product roadmap. It figures out the structure and builds the graph for you. Ask it questions later and it searches, traverses, and synthesizes answers from what it knows.

## What makes this different

**The server is deliberately simple.** It stores data and answers queries. That's it. There are no embedding models running inside it, no NLP pipelines, no language processing of any kind. All of the understanding happens on Claude's side through detailed tool descriptions that teach it how to use the graph well. This means the server stays fast, cheap, and predictable.

**It works from any Claude session.** Phone, desktop, web, CLI. The graph is always there because it's hosted remotely and accessed through a single URL. Start a research session on your laptop, pick it up on your phone, reference it from Claude Code while you're building something.

**It adapts to whatever you throw at it.** The schema describes itself through meta-nodes in the graph. When Claude encounters a new domain, it extends the ontology on the fly. You don't predefine your data model. You let it emerge from the actual content.

**Namespaces keep things organized without keeping them separate.** One graph instance can hold engineering docs, customer research, competitive analysis, project notes. Each lives in its own namespace. Queries can stay scoped or reach across boundaries when that's useful.

## What's inside

Ten tools that cover the full lifecycle of knowledge:

- **search** and **traverse** for finding and exploring
- **entity** and **relate** for reading and writing nodes and edges
- **ingest** for bulk operations
- **ontology** for schema introspection and extension
- **analyze** for structural queries (shortest paths, similarity, degree analysis)
- **source** for tracking where knowledge came from
- **namespace** for workspace management
- **admin** for health checks and raw Cypher when you need it

Plus MCP Resources that give Claude automatic context about the graph's current shape, and workflow Prompts that encode common patterns like document ingestion and topic research.

## Running your own

You need a Railway account and a Cloudflare account.

1. Deploy `neo4j:5-community` on Railway with the APOC plugin
2. Run `scripts/bootstrap.ts` to create indexes and seed the schema
3. Deploy the Cloudflare Worker with `wrangler deploy`
4. Set three secrets: `NEO4J_URL`, `NEO4J_AUTH`, `API_SECRET`
5. Add the MCP endpoint URL as a connector in Claude

The endpoint follows the pattern `https://your-worker.workers.dev/mcp/your-secret`. Anyone with the URL can use the graph. Anyone without it gets a 404.

## Why this stack

**Neo4j** because relationships are first-class citizens, not afterthoughts bolted onto a document store. Multi-hop queries that would require recursive joins in SQL are single Cypher statements.

**Railway** because deploying a Docker image with a persistent volume takes about 60 seconds. No Kubernetes manifests, no managed database pricing tiers, no vendor lock-in on the data layer.

**Cloudflare Workers** because the MCP server needs to be fast, globally distributed, and always on. Cold starts are under 50ms. The whole thing runs on the edge, close to wherever the request originates.

**MCP over Streamable HTTP** because it works everywhere Claude does. No local process to keep running, no stdio pipes, no SSH tunnels. Just a URL.
