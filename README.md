# Portable Knowledge Graph

A multi-tenant knowledge graph platform that provisions isolated Neo4j instances on demand, connects them to Claude through MCP, and controls access with role-based permissions. Neo4j on Railway for storage, Cloudflare Workers for the interface, and Claude as the brain.

## What it does

You connect it to Claude as a remote tool. Then you just talk to it. Claude reads your documents, pulls out the important pieces, decides how they relate to each other, and writes everything into the graph. No pipelines. No preprocessing. No local setup.

The graph is empty until you need it to not be. Ask Claude to ingest a research paper, a technical spec, meeting notes, a product roadmap. It figures out the structure and builds the graph for you. Ask it questions later and it searches, traverses, and synthesizes answers from what it knows.

The server is deliberately simple. It stores data and answers queries. There are no embedding models running inside it, no NLP pipelines, no language processing of any kind. All of the understanding happens on Claude's side through detailed tool descriptions that teach it how to use the graph well. This means the server stays fast, cheap, and predictable.

## Multi-tenant isolation

Each client graph is its own Railway project running its own Neo4j instance. This is physical isolation, not row-level filtering. One client's data cannot reach another, and tearing down a graph means deleting an entire Railway project with nothing left behind.

A Factory Worker exposes a REST API for provisioning new graphs. You POST a graph ID and display name, and a Cloudflare Workflow creates the Railway project, deploys Neo4j, runs the bootstrap schema, encrypts the credentials, and marks the graph ready. The whole process takes a few minutes and reports its progress step by step. When a graph is no longer needed, a single DELETE removes the Railway project and the registry record.

The MCP Worker handles all Claude connections. The graph ID lives in the URL path (`/mcp/acme-q3-audit`), so each Claude connector points at exactly one graph. Users with access to several graphs simply configure several connectors and scope conversations by toggling them on and off.

## Role-based access

Three roles control what each user can do. A reader can search, traverse, and analyze the graph. A writer can also create and update entities, ingest documents, and manage sources and ontology. An admin gets everything including entity deletion, raw Cypher, and namespace teardown.

Permissions are stored per graph as a map from email addresses or domain patterns to roles. The owner of a graph is always an admin. An entry like `@acme.com: writer` gives writer access to everyone at that domain. Graphs can also set a default role for anyone who authenticates, or leave it null to make the graph invite-only.

Tool filtering happens at registration time. When a reader connects, destructive tools like `ingest` and `admin` are never registered, so Claude never sees them and cannot attempt to use them. As a second layer of defense, every destructive handler also checks the role at runtime before executing any Cypher.

## Epistemic status tracking

Every entity carries three fields that track how well-supported it is. The `epistemic_status` field is one of grounded, provisional, speculative, or contested. The `confidence` field is a float from 0 to 1. The `assessed_by` field records who made the assessment. These are set during ingestion and can be queried structurally. The `analyze(epistemic_gaps)` action finds provisional entities with no source provenance, surfacing the weakest links in your knowledge base.

## Tools

Ten tools cover the full lifecycle of knowledge. `search` and `traverse` handle finding and exploring. `entity` and `relate` handle reading and writing nodes and edges. `ingest` handles bulk operations. `ontology` handles schema introspection and extension. `analyze` runs structural queries like shortest paths, similarity, degree analysis, and epistemic gaps. `source` tracks where knowledge came from. `namespace` manages workspace partitions. `admin` provides health checks and raw Cypher when you need it.

MCP Resources give Claude automatic context about the graph's current shape, and workflow Prompts encode common patterns like document ingestion and topic research.

## Getting started

You need a Railway account (Pro plan for API access), a Cloudflare account with Workers and Zero Trust enabled, and Node.js 22 or later.

The full deployment process including secret generation, worker deployment order, Cloudflare Access configuration, and smoke testing is documented in [DEPLOY.md](DEPLOY.md).

## Why this stack

Neo4j because relationships are first-class citizens, not afterthoughts bolted onto a document store. Multi-hop queries that would require recursive joins in SQL are single Cypher statements.

Railway because deploying a Docker image with a persistent volume takes about 60 seconds and the API lets you provision new instances programmatically. No Kubernetes manifests, no managed database pricing tiers, no vendor lock-in on the data layer.

Cloudflare Workers because the MCP server needs to be fast, globally distributed, and always on. Durable Objects provide strongly consistent storage for the graph registry, and Cloudflare Workflows handle the multi-step provisioning saga with automatic retry and rollback.

MCP over Streamable HTTP because it works everywhere Claude does. No local process to keep running, no stdio pipes, no SSH tunnels. Just a URL.
