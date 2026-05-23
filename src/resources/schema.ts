import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Neo4jClient } from "../neo4j/client";

const GUIDE_CONTENT = `# Knowledge Graph Guide

## Graph Structure

This is a use-case agnostic knowledge graph. All knowledge is stored as **Entity** nodes with typed relationships.

### Node Types
- **Entity**: Universal knowledge node. Has entity_type, namespace, name, summary, content, properties.
- **Tag**: Classification label. Shared across entities via TAGGED_WITH edges.
- **Source**: Provenance record. Linked via SOURCED_FROM edges with confidence scores.
- **__Schema**: Meta-nodes describing the ontology (EntityType, RelType, TagGroup, Namespace).

### Relationship Types
- **RELATES_TO**: Typed relationship between entities. The \`type\` property holds the semantic meaning (SUPPORTS, CONTRADICTS, CONTAINS, DEPENDS_ON, etc.)
- **TAGGED_WITH**: Entity → Tag classification
- **SOURCED_FROM**: Entity → Source provenance (with confidence 0-1 and excerpt)
- **SIMILAR_TO**: Entity → Entity structural similarity (with score and method)

### Namespaces
Entities can belong to a namespace (workspace partition). Use namespaces to organize domains:
- "engineering-docs", "customer-research", "project-alpha", etc.
- All query tools accept a namespace filter
- Entities without a namespace are global

## Workflows

### Ingesting New Knowledge
1. Call \`ontology(describe)\` to see what entity types and relationship types exist
2. If needed, create new types via \`ontology(create_type)\` and \`ontology(create_rel_type)\`
3. **YOU** extract concepts, facts, and entities from the source material
4. **YOU** determine relationships and their types
5. Call \`ingest(entities)\` with your structured data, including tags
6. Call \`ingest(relationships)\` to connect entities
7. Optionally call \`source(create)\` + \`source(link)\` for provenance

### Researching a Topic
1. Call \`search()\` with keywords to discover relevant entities
2. Call \`entity(get)\` for full details on interesting results
3. Call \`traverse()\` to explore the neighborhood around key entities
4. Call \`relate(query)\` to see specific relationships
5. Call \`source(trace)\` to verify provenance
6. **YOU** synthesize findings into a coherent answer

### Extending the Ontology
1. Call \`ontology(describe)\` to see current schema
2. Identify gaps for your new domain
3. Create entity types, relationship types, tag groups, and namespaces as needed
4. Start ingesting data using your new types

## Conventions
- Entity IDs are UUIDs (auto-generated if omitted)
- Tag names should be lowercase, hyphenated (e.g., "machine-learning", "api-design")
- Relationship types should be UPPER_SNAKE_CASE (e.g., "DEPENDS_ON", "AUTHORED_BY")
- The created_by field tracks provenance: "claude:session-abc", "user:name", "mcp:ingest"
- Use summary for short descriptions (indexed for search), content for full text
`;

export function registerResources(server: McpServer, env: Env) {
	const neo4j = new Neo4jClient(env);

	server.resource("kg-guide", "kg://schema/guide", async (uri) => ({
		contents: [
			{
				uri: uri.href,
				mimeType: "text/markdown",
				text: GUIDE_CONTENT,
			},
		],
	}));

	server.resource("kg-ontology", "kg://schema/ontology", async (uri) => {
		try {
			const result = await neo4j.execute([
				{
					statement: `MATCH (m:__Schema:EntityType)
            OPTIONAL MATCH (e:Entity) WHERE e.entity_type = m.name
            RETURN m.name, m.description, m.property_hints, count(e) AS count
            ORDER BY count DESC`,
				},
				{
					statement: `MATCH (m:__Schema:RelType)
            OPTIONAL MATCH ()-[r:RELATES_TO]->() WHERE r.type = m.name
            RETURN m.name, m.description, m.from_types, m.to_types, count(r) AS count
            ORDER BY count DESC`,
				},
				{
					statement: `MATCH (m:__Schema:TagGroup)
            OPTIONAL MATCH (t:Tag) WHERE t.tag_group = m.name
            RETURN m.name, m.description, count(t) AS count`,
				},
				{
					statement: `MATCH (m:__Schema:Namespace)
            OPTIONAL MATCH (e:Entity) WHERE e.namespace = m.name
            RETURN m.name, m.description, count(e) AS count`,
				},
			]);

			const ontology = {
				entity_types: neo4j
					.rows(result, 0)
					.map(([name, desc, hints, count]) => ({
						name,
						description: desc,
						property_hints: hints,
						instance_count: count,
					})),
				relationship_types: neo4j
					.rows(result, 1)
					.map(([name, desc, from, to, count]) => ({
						name,
						description: desc,
						from_types: from,
						to_types: to,
						instance_count: count,
					})),
				tag_groups: neo4j.rows(result, 2).map(([name, desc, count]) => ({
					name,
					description: desc,
					tag_count: count,
				})),
				namespaces: neo4j.rows(result, 3).map(([name, desc, count]) => ({
					name,
					description: desc,
					entity_count: count,
				})),
			};

			return {
				contents: [
					{
						uri: uri.href,
						mimeType: "application/json",
						text: JSON.stringify(ontology, null, 2),
					},
				],
			};
		} catch (error) {
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: "text/plain",
						text: `Error loading ontology: ${error instanceof Error ? error.message : String(error)}`,
					},
				],
			};
		}
	});
}
