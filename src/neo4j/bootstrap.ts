import type { Neo4jStatement } from "./types";

export const BOOTSTRAP_CONSTRAINTS: Neo4jStatement[] = [
	{
		statement:
			"CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE",
	},
	{
		statement:
			"CREATE CONSTRAINT tag_name IF NOT EXISTS FOR (t:Tag) REQUIRE t.name IS UNIQUE",
	},
	{
		statement:
			"CREATE CONSTRAINT source_id IF NOT EXISTS FOR (s:Source) REQUIRE s.id IS UNIQUE",
	},
];

export const BOOTSTRAP_INDEXES: Neo4jStatement[] = [
	{
		statement:
			"CREATE INDEX entity_type IF NOT EXISTS FOR (e:Entity) ON (e.entity_type)",
	},
	{
		statement:
			"CREATE INDEX entity_ns IF NOT EXISTS FOR (e:Entity) ON (e.namespace)",
	},
	{
		statement:
			"CREATE INDEX entity_created IF NOT EXISTS FOR (e:Entity) ON (e.created_at)",
	},
	{
		statement:
			"CREATE INDEX tag_group IF NOT EXISTS FOR (t:Tag) ON (t.tag_group)",
	},
	{
		statement:
			"CREATE INDEX source_type IF NOT EXISTS FOR (s:Source) ON (s.source_type)",
	},
];

export const BOOTSTRAP_FULLTEXT: Neo4jStatement[] = [
	{
		statement: `CREATE FULLTEXT INDEX entity_search IF NOT EXISTS
      FOR (e:Entity) ON EACH [e.name, e.summary, e.content]`,
	},
	{
		statement: `CREATE FULLTEXT INDEX tag_search IF NOT EXISTS
      FOR (t:Tag) ON EACH [t.name]`,
	},
];

export const BOOTSTRAP_SCHEMA_SEED: Neo4jStatement[] = [
	{
		statement: `MERGE (m:__Schema:EntityType {name: "Concept"})
      SET m.description = "An abstract idea, topic, or category",
          m.property_hints = "Use for taggable ideas that connect other entities",
          m.created_at = datetime()`,
	},
	{
		statement: `MERGE (m:__Schema:EntityType {name: "Document"})
      SET m.description = "A source document, article, or text artifact",
          m.property_hints = "Store full text in content, metadata in properties",
          m.created_at = datetime()`,
	},
	{
		statement: `MERGE (m:__Schema:EntityType {name: "Note"})
      SET m.description = "A freeform observation, annotation, or insight",
          m.property_hints = "Lightweight entity for capturing thoughts",
          m.created_at = datetime()`,
	},
	{
		statement: `MERGE (m:__Schema:EntityType {name: "Fact"})
      SET m.description = "A discrete, verifiable claim or data point",
          m.property_hints = "Use summary for the claim, content for supporting detail",
          m.created_at = datetime()`,
	},
	{
		statement: `MERGE (m:__Schema:RelType {name: "CONTAINS"})
      SET m.description = "Parent contains child (hierarchical nesting)",
          m.from_types = ["Document", "Collection"],
          m.to_types = ["*"],
          m.created_at = datetime()`,
	},
	{
		statement: `MERGE (m:__Schema:RelType {name: "REFERENCES"})
      SET m.description = "Source references or cites target",
          m.from_types = ["*"],
          m.to_types = ["*"],
          m.created_at = datetime()`,
	},
	{
		statement: `MERGE (m:__Schema:RelType {name: "SUPPORTS"})
      SET m.description = "Evidence or argument that supports a claim",
          m.from_types = ["*"],
          m.to_types = ["*"],
          m.created_at = datetime()`,
	},
	{
		statement: `MERGE (m:__Schema:RelType {name: "CONTRADICTS"})
      SET m.description = "Evidence or argument that contradicts a claim",
          m.from_types = ["*"],
          m.to_types = ["*"],
          m.created_at = datetime()`,
	},
	{
		statement: `MERGE (m:__Schema:RelType {name: "DEPENDS_ON"})
      SET m.description = "Source depends on or requires target",
          m.from_types = ["*"],
          m.to_types = ["*"],
          m.created_at = datetime()`,
	},
	{
		statement: `MERGE (m:__Schema:RelType {name: "CAUSED_BY"})
      SET m.description = "Effect caused by cause (causal link)",
          m.from_types = ["*"],
          m.to_types = ["*"],
          m.created_at = datetime()`,
	},
	{
		statement: `MERGE (m:__Schema:RelType {name: "PRECEDES"})
      SET m.description = "Temporal ordering: source comes before target",
          m.from_types = ["*"],
          m.to_types = ["*"],
          m.created_at = datetime()`,
	},
];

export function allBootstrapStatements(): Neo4jStatement[] {
	return [
		...BOOTSTRAP_CONSTRAINTS,
		...BOOTSTRAP_INDEXES,
		...BOOTSTRAP_FULLTEXT,
		...BOOTSTRAP_SCHEMA_SEED,
	];
}
