/**
 * Chorus — cinematic dialogue engine
 * Copyright (C) 2026 Amias
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { NodePropertyDef } from "@/server/db/schema";
import { SchemaRegistry } from "@/server/db/schema";

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
    expect(schema.getNodeType("Scene")).toBeDefined();
    expect(schema.getNodeType("Disposition")).toBeDefined();
  });

  it("generates valid node DDL with PRIMARY KEY", () => {
    const schema = SchemaRegistry.getInstance();
    const ddl = schema.generateNodeDDL("Character");
    expect(ddl).toContain("CREATE NODE TABLE");
    expect(ddl).toContain("Character");
    expect(ddl).toContain("PRIMARY KEY");
    expect(ddl).toContain("name");
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
    const props: NodePropertyDef[] = [
      { name: "name", description: "Faction name", tags: ["string", "unique"] },
      { name: "power", description: "Power level", tags: ["number"] },
    ];
    schema.registerNode({
      name: "Faction",
      category: "GM_DEFINED",
      description: "A faction",
      properties: props,
    });

    const def = schema.getNodeType("Faction");
    expect(def).toBeDefined();
    expect(def!.category).toBe("GM_DEFINED");
    expect(def!.properties).toHaveLength(2);
  });

  it("generates correct DDL for GM_DEFINED type", () => {
    const schema = SchemaRegistry.getInstance();
    schema.registerNode({
      name: "Faction",
      category: "GM_DEFINED",
      description: "A faction",
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
      name: "ALLIED_WITH",
      sourceLabel: "Character",
      targetLabel: "Character",
      category: "GM_DEFINED",
      description: "Alliance",
      properties: [],
    });
    const def = schema.getRelType("ALLIED_WITH", "Character", "Character");
    expect(def).toBeDefined();
    expect(def!.category).toBe("GM_DEFINED");
  });

  it("getRelTypeByName returns all matching rels", () => {
    const schema = SchemaRegistry.getInstance();
    const results = schema.getRelTypeByName("LOCATED_AT");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.name === "LOCATED_AT")).toBe(true);
  });

  it("generates correct embedding text", () => {
    const schema = SchemaRegistry.getInstance();
    const text = schema.getEmbeddingText("Character", {
      name: "Alice",
      brief: "A brave knight",
      description: "Alice wields a glowing sword",
    });
    expect(text).toContain("Alice");
    expect(text).toContain("A brave knight");
    expect(text).toContain("Alice wields a glowing sword");
  });

  it("getVectorSearchableNodeTypes returns only embeddable types", () => {
    const schema = SchemaRegistry.getInstance();
    const searchable = schema.getVectorSearchableNodeTypes();
    expect(searchable.length).toBeGreaterThan(0);
    // Disposition has no embedded properties — should not appear
    expect(searchable.some((t) => t.name === "Disposition")).toBe(false);
    // Character has embedded properties — should appear
    expect(searchable.some((t) => t.name === "Character")).toBe(true);
  });

  it("getVectorSearchableRelTypes returns embeddable relationships", () => {
    const schema = SchemaRegistry.getInstance();
    const searchable = schema.getVectorSearchableRelTypes();
    // LOCATED_AT has embedded brief — should appear
    expect(searchable.some((t) => t.name === "LOCATED_AT")).toBe(true);
    // ABOUT_PLOT has no embedded props — should not appear
    expect(searchable.some((t) => t.name === "ABOUT_PLOT")).toBe(false);
  });

  it("getInternalTypeNames excludes hidden types from schema dump", () => {
    const schema = SchemaRegistry.getInstance();
    const internals = schema.getInternalTypeNames();
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
