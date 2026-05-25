import { describe, it, expect, beforeEach } from "vitest";
import { SchemaRegistry, NodeTypeDef, RelTypeDef, PropertyDef } from "@/server/db/schema";

describe("SchemaRegistry", () => {
  beforeEach(() => {
    SchemaRegistry.resetInstance();
  });

  it("registers predefined node types on init", () => {
    const schema = SchemaRegistry.getInstance();
    expect(schema.getNodeType("Character")).toBeDefined();
    expect(schema.getNodeType("Object")).toBeDefined();
    expect(schema.getNodeType("Location")).toBeDefined();
    expect(schema.getNodeType("Plot")).toBeDefined();
    expect(schema.getNodeType("Note")).toBeDefined();
    expect(schema.getNodeType("Message")).toBeDefined();
    expect(schema.getNodeType("Disposition")).toBeDefined();
  });

  it("generates valid node DDL with PRIMARY KEY", () => {
    const schema = SchemaRegistry.getInstance();
    const ddl = schema.generateNodeDDL("Character");
    expect(ddl).toContain("CREATE NODE TABLE");
    expect(ddl).toContain("Character");
    expect(ddl).toContain("PRIMARY KEY");
    expect(ddl).toContain("uid");
  });

  it("generates valid relationship DDL", () => {
    const schema = SchemaRegistry.getInstance();
    const ddl = schema.generateRelDDL("LOCATED_AT", "Character", "Location");
    expect(ddl).toContain("CREATE REL TABLE");
    expect(ddl).toContain("LOCATED_AT");
    expect(ddl).toContain("Character");
    expect(ddl).toContain("Location");
  });

  it("registers and retrieves GM_DEFINED node types", () => {
    const schema = SchemaRegistry.getInstance();
    const props: PropertyDef[] = [
      { name: "name", description: "Faction name", tags: ["string", "unique"] },
      { name: "power", description: "Power level", tags: ["number"] },
    ];
    schema.registerNode({ name: "Faction", category: "GM_DEFINED", description: "A faction", properties: props });

    const def = schema.getNodeType("Faction");
    expect(def).toBeDefined();
    expect(def!.category).toBe("GM_DEFINED");
    expect(def!.properties).toHaveLength(2);
  });

  it("generates correct DDL for GM_DEFINED type", () => {
    const schema = SchemaRegistry.getInstance();
    schema.registerNode({
      name: "Faction", category: "GM_DEFINED", description: "A faction",
      properties: [
        { name: "name", description: "Name", tags: ["string", "unique"] },
        { name: "power", description: "Power", tags: ["number"] },
      ],
    });
    const ddl = schema.generateNodeDDL("Faction");
    expect(ddl).toContain("CREATE NODE TABLE");
    expect(ddl).toContain("Faction");
    expect(ddl).toContain("`name` STRING PRIMARY KEY");
    expect(ddl).toContain("`power` DOUBLE");
  });

  it("registers and retrieves GM_DEFINED relationship types", () => {
    const schema = SchemaRegistry.getInstance();
    schema.registerRel({
      name: "ALLIED_WITH", sourceLabel: "Character", targetLabel: "Character",
      category: "GM_DEFINED", description: "Alliance", properties: [],
    });
    const def = schema.getRelType("ALLIED_WITH", "Character", "Character");
    expect(def).toBeDefined();
    expect(def!.category).toBe("GM_DEFINED");
  });

  it("getRelTypeByName returns all matching rels", () => {
    const schema = SchemaRegistry.getInstance();
    const results = schema.getRelTypeByName("LOCATED_AT");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.name === "LOCATED_AT")).toBe(true);
  });

  it("generates correct embedding content text", () => {
    const schema = SchemaRegistry.getInstance();
    const text = schema.getEmbeddingContentText("Character", {
      name: "Alice", brief: "A brave knight", description: "Alice wields a glowing sword",
    });
    expect(text).toContain("A brave knight");
    expect(text).toContain("Alice wields a glowing sword");
  });

  it("generates correct embedding name text", () => {
    const schema = SchemaRegistry.getInstance();
    const text = schema.getEmbeddingNameText("Character", { name: "Alice" });
    expect(text).toContain("Alice");
  });

  it("getVectorSearchableNodeTypes returns only embeddable types", () => {
    const schema = SchemaRegistry.getInstance();
    const searchable = schema.getVectorSearchableNodeTypes();
    expect(searchable.length).toBeGreaterThan(0);
    // TimeAnchor has no embedded properties — should not appear
    expect(searchable.some(t => t.name === "TimeAnchor")).toBe(false);
    // Character has embedded_name + embedded_content — should appear
    expect(searchable.some(t => t.name === "Character")).toBe(true);
  });

  it("getVectorSearchableRelTypes returns embeddable relationships", () => {
    const schema = SchemaRegistry.getInstance();
    const searchable = schema.getVectorSearchableRelTypes();
    // LOCATED_AT has embedded_content brief — should appear
    expect(searchable.some(t => t.name === "LOCATED_AT")).toBe(true);
    // HAS_MESSAGE has no embedded props — should not appear
    expect(searchable.some(t => t.name === "HAS_MESSAGE")).toBe(false);
  });

  it("getInternalTypeNames excludes hidden types from schema dump", () => {
    const schema = SchemaRegistry.getInstance();
    const internals = schema.getInternalTypeNames();
    expect(internals).toContain("Conversation");
    expect(internals).toContain("GMTurnMessage");
    expect(internals).toContain("IdCounter");
    expect(internals).not.toContain("Character");
  });

  it("returns null for unknown node DDL", () => {
    const schema = SchemaRegistry.getInstance();
    expect(schema.generateNodeDDL("NonExistent")).toBeNull();
  });

  it("returns null for unknown rel type", () => {
    const schema = SchemaRegistry.getInstance();
    expect(schema.getRelType("NOPE", "A", "B")).toBeUndefined();
  });
});
