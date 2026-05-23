import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerPrompts(server: McpServer) {
	server.prompt(
		"ingest-document",
		"Ingest a document into the knowledge graph. YOU extract entities, concepts, relationships, and tags from the text, then write them to the graph.",
		{
			text: z.string().describe("The document text to ingest"),
			namespace: z
				.string()
				.optional()
				.describe("Namespace to place entities in"),
			source_name: z.string().optional().describe("Name for the source record"),
		},
		async ({ text, namespace, source_name }) => ({
			messages: [
				{
					role: "user" as const,
					content: {
						type: "text" as const,
						text: `Ingest the following document into the knowledge graph${namespace ? ` in namespace "${namespace}"` : ""}.

## Your responsibilities:
1. First call ontology(describe) to see what entity types and relationship types exist
2. Read the text carefully and extract:
   - Key entities (people, organizations, concepts, facts, technologies, etc.)
   - Relationships between entities (what supports/contradicts/depends on what)
   - Tags for classification
3. For each entity, determine:
   - The best entity_type from the ontology (create new types if needed)
   - A clear name and summary
   - Relevant tags
4. Create a Source record for provenance tracking
5. Call ingest(entities) with your extracted entities
6. Call ingest(relationships) to connect them
7. Link all entities to the source via source(link)

## The document:
${source_name ? `Source: ${source_name}\n` : ""}
${text}`,
					},
				},
			],
		}),
	);

	server.prompt(
		"research-topic",
		"Research a topic using the knowledge graph. Search, traverse, and synthesize findings.",
		{
			topic: z.string().describe("The topic to research"),
			namespace: z
				.string()
				.optional()
				.describe("Namespace to search within (optional)"),
		},
		async ({ topic, namespace }) => ({
			messages: [
				{
					role: "user" as const,
					content: {
						type: "text" as const,
						text: `Research "${topic}" using the knowledge graph${namespace ? ` (namespace: "${namespace}")` : ""}.

## Workflow:
1. Call search() with relevant keywords to find related entities
2. Call entity(get) on the most relevant results for full details
3. Call traverse() from key entities to discover connected knowledge
4. Call relate(query) to examine specific relationships
5. Call source(trace) on important claims to verify provenance
6. Synthesize your findings into a coherent summary with citations

Report what you found, what's well-supported vs. uncertain, and any gaps in the graph's coverage.`,
					},
				},
			],
		}),
	);

	server.prompt(
		"extend-ontology",
		"Extend the knowledge graph ontology for a new domain.",
		{
			domain: z
				.string()
				.describe(
					"The domain to add support for (e.g., 'software engineering', 'medical research')",
				),
		},
		async ({ domain }) => ({
			messages: [
				{
					role: "user" as const,
					content: {
						type: "text" as const,
						text: `Extend the knowledge graph ontology to support the "${domain}" domain.

## Workflow:
1. Call ontology(describe) to see the current schema
2. Analyze what entity types, relationship types, and tag groups are needed for ${domain}
3. Create new entity types via ontology(create_type) with clear descriptions and property hints
4. Create new relationship types via ontology(create_rel_type) with from/to type constraints
5. Create tag groups via ontology(create_tag_group) for domain-specific classification
6. Create a namespace via namespace(create) if this domain should be partitioned

Report what you created and why, and suggest what kinds of documents or data should be ingested next.`,
					},
				},
			],
		}),
	);
}
