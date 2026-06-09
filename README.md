# Portable Knowledge Graph

A multi-tenant knowledge graph platform that provisions isolated Neo4j instances on demand, connects them to Claude through MCP, and controls access with role-based permissions. Neo4j on Railway for storage, Cloudflare Workers for the interface, and Claude as the brain.

## Why a knowledge graph

RAG finds text that sounds relevant to a question. It works when the answer lives in a single passage, but it has no concept of how ideas relate to each other. Ask it to connect findings across twelve documents and it will retrieve the best-matching chunks from each, leaving the synthesis to the model's imagination.

A knowledge graph gives an LLM something RAG cannot: ontological structure. Typed entities, named relationships, hierarchies, and explicit boundaries. The model does not search for text about a concept. It traverses the concept's actual connections, follows multi-hop paths, and reasons against a structure it can trust. When the graph says A relates to B through mechanism C, that is not a retrieval heuristic. It is a fact the model can cite and build on.

GraphRAG moves toward this by building graphs to improve retrieval. But the graph still serves the retrieval pipeline: a better index, not a first-class reasoning substrate. Here, the graph is the product. Claude builds it, maintains it, and reasons with it directly. The difference is between an LLM that can find relevant information and one that has a structured understanding of a domain.

## What it does

You connect it to Claude as a remote tool. Then you just talk to it. Claude reads your documents, pulls out the important pieces, decides how they relate to each other, and writes everything into the graph. No pipelines. No preprocessing. No local setup.

The graph is empty until you need it to not be. Ask Claude to ingest a research paper, a technical spec, meeting notes, a product roadmap. It figures out the structure and builds the graph for you. Ask it questions later and it searches, traverses, and synthesizes answers from what it knows.

The server is deliberately simple. It stores data and answers queries. There are no embedding models running inside it, no NLP pipelines, no language processing of any kind. All of the understanding happens on Claude's side through detailed tool descriptions that teach it how to use the graph well. This means the server stays fast, cheap, and predictable.

## Multi-tenant isolation

Each client graph is its own Railway project running its own Neo4j instance. This is physical isolation, not row-level filtering. One client's data cannot reach another, and tearing down a graph means deleting an entire Railway project with nothing left behind.

The MCP Worker handles all Claude connections. The graph ID lives in the URL path (`/mcp/acme-q3-audit`), so each Claude connector points at exactly one graph. Users with access to several graphs simply configure several connectors and scope conversations by toggling them on and off.

## Automated provisioning

A Factory Worker exposes a REST API for the full graph lifecycle. `POST /graphs` with an ID and display name, and a Cloudflare Workflow creates the Railway project, deploys Neo4j, configures the environment, waits for health, bootstraps the schema, encrypts credentials, and marks the graph ready. The whole process takes a few minutes and reports its progress step by step through `GET /graphs/{id}`.

If any step fails, the workflow runs compensating actions: deleting the orphaned Railway project and marking the graph as failed with a clear error message. When a graph is no longer needed, `DELETE /graphs/{id}` removes the Railway project and the registry record in one call.

Permissions are managed through `PUT /graphs/{id}/permissions`, and `GET /graphs` returns only the graphs accessible to the requesting user. The Factory also supports fleet-wide schema migrations across all active graphs through a single endpoint.

## Authentication

Every request passes through Cloudflare Access before it reaches the MCP server. Access handles identity (SSO, social login, one-time PINs) and forwards the authenticated email in a signed header. The MCP Worker never sees passwords or manages sessions.

On top of Cloudflare Access, the MCP Worker runs an OAuth 2.0 authorization server. Claude initiates the standard authorization code flow, the worker verifies the Cloudflare Access identity, issues a token scoped to the user and graph, and Claude uses that token for all subsequent requests. This means Claude connects as the authenticated user, and every action is attributable.

For programmatic access (CI pipelines, automation, cron jobs), Cloudflare Access service tokens bypass interactive login. The worker extracts the service identity from the JWT and maps it to a role like any other user.

## Role-based access

Three roles control what each user can do:

- **Reader.** Search, traverse, and analyze the graph. Cannot modify anything.
- **Writer.** Everything a reader can do, plus create and update entities, ingest documents, manage sources, and extend the ontology.
- **Admin.** Everything a writer can do, plus delete entities, merge duplicates, run raw Cypher, and tear down namespaces.

Permissions are stored per graph as a map from email addresses or domain patterns to roles. The owner of a graph is always an admin. An entry like `@acme.com: writer` gives writer access to everyone at that domain. Graphs can set a default role for any authenticated user, or leave it null to make the graph invite-only.

Tool filtering happens at registration time. When a reader connects, destructive tools like `ingest` and `admin` are never registered, so Claude never sees them and cannot attempt to use them. Within multi-action tools like `entity` and `relate`, each role sees only its permitted actions. As a second layer, every destructive handler also checks the role at runtime before executing.

## Encrypted credentials

Neo4j credentials are encrypted at rest using AES-256-GCM before they are stored in the graph registry. Each graph has its own initialization vector. Credentials are decrypted per-request in the Worker's memory and never written to disk or logged.

## Epistemic status tracking

Every entity carries three fields that track how well-supported it is. The `epistemic_status` field is one of grounded, provisional, speculative, or contested. The `confidence` field is a float from 0 to 1. The `assessed_by` field records who made the assessment. These are set during ingestion and can be queried structurally. The `analyze(epistemic_gaps)` action finds provisional entities with no source provenance, surfacing the weakest links in your knowledge base.

## Tools

Eleven tools cover the full lifecycle of knowledge. `search` and `vector_search` handle keyword and semantic discovery (embeddings are client-supplied, keeping the server free of AI). `traverse` explores neighborhoods. `entity` and `relate` handle reading and writing nodes and edges, including an admin-only `entity(merge)` that absorbs a duplicate entity and rewires all of its relationships, tags, and source links onto the survivor. `ingest` handles bulk operations. `ontology` handles schema introspection and extension. `analyze` runs structural queries like shortest paths, similarity, degree analysis, and epistemic gaps, plus graph hygiene: `validate` reports schema drift (types, relationship types, and namespaces used in the graph but missing from the ontology) and `find_duplicates` groups entities by normalized name so Claude can decide what to merge. `source` tracks where knowledge came from. `namespace` manages workspace partitions. `admin` provides health checks and raw Cypher when you need it.

Writes are honest and idempotent. Relationship creation uses MERGE semantics, so retries never duplicate edges, and re-creating an existing edge reports `already_existed` instead of pretending it was new. If a referenced entity does not exist, the tool says exactly which one rather than silently writing nothing. Bulk ingest reports created, skipped, and unmatched items per call, and a mid-run failure returns which entities committed so the rest can be retried safely.

Responses are shaped for an LLM client. List and search results carry pagination metadata (`total_count`, `has_more`), entity reads never ship raw embedding vectors back (a `has_embedding` flag stands in for the floats), a `detail: "compact"` option trims responses further, and every error names what was looked up and suggests a next step so Claude can self-correct.

MCP Resources give Claude automatic context about the graph's current shape, and workflow Prompts encode common patterns like document ingestion and topic research.

## Getting started

You need a Railway account (Pro plan for API access), a Cloudflare account with Workers and Zero Trust enabled, and Node.js 22 or later.

The full deployment process including secret generation, worker deployment order, Cloudflare Access configuration, and smoke testing is documented in [DEPLOY.md](DEPLOY.md).

## Why this stack

Neo4j because relationships are first-class citizens, not afterthoughts bolted onto a document store. Multi-hop queries that would require recursive joins in SQL are single Cypher statements.

Railway because deploying a Docker image with a persistent volume takes about 60 seconds and the API lets you provision new instances programmatically. No Kubernetes manifests, no managed database pricing tiers, no vendor lock-in on the data layer.

Cloudflare Workers because the MCP server needs to be fast, globally distributed, and always on. Durable Objects provide strongly consistent storage for the graph registry, and Cloudflare Workflows handle the multi-step provisioning saga with automatic retry and rollback.

MCP over Streamable HTTP because it works everywhere Claude does. No local process to keep running, no stdio pipes, no SSH tunnels. Just a URL.
