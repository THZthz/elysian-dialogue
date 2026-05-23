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

import type { Neo4jClient } from "@/server/memory/neo4j";
import { TOOL_NAMES } from "@/shared/constants";

/** The meaning of those tags is basically the same with NODE_PROPERTY_TAGS. */
export const RELATIONSHIP_PROPERTY_TAGS = [
  "string",
  "number",
  "number[]",
  "json",
  "embedded_name",
  "embedded_content",
  "index",
  "composite_index_1",
  "composite_index_2",
  "composite_index_3",
] as const;
export type RelationshipPropertyTag = (typeof RELATIONSHIP_PROPERTY_TAGS)[number];

export interface RelationshipPropertyDef {
  name: string;
  description: string;
  tags: RelationshipPropertyTag[];
}

export interface RelationshipDef {
  name: string;
  description: string;
  type: "INTERNAL" | "PREDEFINED" | "GM_DEFINED";
  sourceLabel: string;
  targetLabel: string;
  properties: RelationshipPropertyDef[];
}

function makeKey(name: string, sourceLabel: string, targetLabel: string): string {
  return `${name}||${sourceLabel}||${targetLabel}`;
}

const INTERNAL_TYPES: {
  name: string;
  description: string;
  sourceLabel: string;
  targetLabel: string;
}[] = [
  {
    name: "_HAS_GM_MESSAGE",
    description: "Links a Conversation node to its GMTurnMessage nodes.",
    sourceLabel: "Conversation",
    targetLabel: "GMTurnMessage",
  },
  {
    name: "_FIRST_GM_MESSAGE",
    description: "Points to the first GMTurnMessage in a Conversation's ordered linked list.",
    sourceLabel: "Conversation",
    targetLabel: "GMTurnMessage",
  },
  {
    name: "_NEXT_GM_MESSAGE",
    description: "Sequentially links GMTurnMessage nodes in conversation order.",
    sourceLabel: "GMTurnMessage",
    targetLabel: "GMTurnMessage",
  },
  {
    name: "_NEXT_ASSISTANT_MESSAGE",
    description: "Sequentially links AssistantMessage nodes in conversation order.",
    sourceLabel: "AssistantMessage",
    targetLabel: "AssistantMessage",
  },
];

const PREDEFINED_TYPES: {
  name: string;
  description: string;
  sourceLabel: string;
  targetLabel: string;
  properties?: RelationshipPropertyDef[];
}[] = [
  {
    name: "HAS_MESSAGE",
    description: `Links a Conversation node to its Message nodes. Automatically written by \`${TOOL_NAMES.GENERATE_DIALOGUE}\`.`,
    sourceLabel: "Conversation",
    targetLabel: "Message",
  },
  {
    name: "FIRST_MESSAGE",
    description: `Points to the first Message in a Conversation's ordered linked list. Automatically written by \`${TOOL_NAMES.GENERATE_DIALOGUE}\`.`,
    sourceLabel: "Conversation",
    targetLabel: "Message",
  },
  {
    name: "NEXT_MESSAGE",
    description: `Sequentially links Message nodes in conversation order. Automatically written by \`${TOOL_NAMES.GENERATE_DIALOGUE}\`.`,
    sourceLabel: "Message",
    targetLabel: "Message",
  },
  {
    name: "NEXT_TIMEPOINT",
    description: `Links TimePoint nodes in chronological sequence. Records the reason for the time advance. Automatically written by \`${TOOL_NAMES.ADVANCE_TIME}\`.`,
    sourceLabel: "TimePoint",
    targetLabel: "TimePoint",
    properties: [
      {
        name: "reason",
        description: "Narrative reason for advancing time from the previous TimePoint to this one.",
        tags: ["string"],
      },
    ],
  },
  {
    name: "CURRENT_TIMEPOINT",
    description: `Points to the current TimePoint from a TimeAnchor node. Automatically written by \`${TOOL_NAMES.ADVANCE_TIME}\`.`,
    sourceLabel: "TimeAnchor",
    targetLabel: "TimePoint",
  },
  {
    name: "AT_TIME",
    description: `Links a Message to the TimePoint when it was created. Automatically written by \`${TOOL_NAMES.GENERATE_DIALOGUE}\`.`,
    sourceLabel: "Message",
    targetLabel: "TimePoint",
  },
  {
    name: "STARTED_AT",
    description: `Marks the TimePoint when a Plot started. Automatically written by \`${TOOL_NAMES.EDIT_PLOT}\`.`,
    sourceLabel: "Plot",
    targetLabel: "TimePoint",
  },
  {
    name: "ACTIVE_AT",
    description: `Marks the TimePoint when a Plot became active. Automatically written by \`${TOOL_NAMES.EDIT_PLOT}\`.`,
    sourceLabel: "Plot",
    targetLabel: "TimePoint",
  },
  {
    name: "COMPLETED_AT",
    description: `Marks the TimePoint when a Plot completed. Automatically written by \`${TOOL_NAMES.EDIT_PLOT}\`.`,
    sourceLabel: "Plot",
    targetLabel: "TimePoint",
  },
  {
    name: "LOCATED_AT",
    description: "A character is physically present at a location.",
    sourceLabel: "Character",
    targetLabel: "Location",
    properties: [
      {
        name: "brief",
        description:
          "Spatial position detail — how/where exactly the character is located (e.g., 'hiding behind crates', 'slumped at the bar').",
        tags: ["string", "embedded_content"],
      },
    ],
  },
  {
    name: "LOCATED_AT",
    description: "An object is physically present at a location.",
    sourceLabel: "Object",
    targetLabel: "Location",
    properties: [
      {
        name: "brief",
        description: "Spatial position detail — where exactly the object is located.",
        tags: ["string", "embedded_content"],
      },
    ],
  },
  {
    name: "CARRIES",
    description: "A character is carrying or in possession of an object.",
    sourceLabel: "Character",
    targetLabel: "Object",
    properties: [
      {
        name: "brief",
        description: "How the item is carried (e.g., 'concealed in a boot', 'worn openly on hip').",
        tags: ["string", "embedded_content"],
      },
    ],
  },
  {
    name: "LOCATED_IN",
    description:
      "A location is contained within a larger location (e.g., a basement inside a tavern).",
    sourceLabel: "Location",
    targetLabel: "Location",
    properties: [
      {
        name: "brief",
        description:
          "Access or containment detail (e.g., 'accessed through a trapdoor behind the bar').",
        tags: ["string", "embedded_content"],
      },
    ],
  },
  {
    name: "HAS_DISPOSITION",
    description: "Links a Character to its Disposition node.",
    sourceLabel: "Character",
    targetLabel: "Disposition",
  },
  {
    name: "ABOUT_ENTITY",
    description: `A Note is about or references a Character. Automatically written by \`${TOOL_NAMES.EDIT_NOTE}\`.`,
    sourceLabel: "Note",
    targetLabel: "Character",
  },
  {
    name: "ABOUT_ENTITY",
    description: `A Note is about or references an Object. Automatically written by \`${TOOL_NAMES.EDIT_NOTE}\`.`,
    sourceLabel: "Note",
    targetLabel: "Object",
  },
  {
    name: "ABOUT_ENTITY",
    description: `A Note is about or references a Location. Automatically written by \`${TOOL_NAMES.EDIT_NOTE}\`.`,
    sourceLabel: "Note",
    targetLabel: "Location",
  },
  {
    name: "ABOUT_MESSAGE",
    description: `A Note is about or references a specific Message. Automatically written by \`${TOOL_NAMES.EDIT_NOTE}\`.`,
    sourceLabel: "Note",
    targetLabel: "Message",
  },
  {
    name: "ABOUT_PLOT",
    description: `A Note is about or references a specific Plot. Automatically written by \`${TOOL_NAMES.EDIT_NOTE}\`.`,
    sourceLabel: "Note",
    targetLabel: "Plot",
  },
  {
    name: "BRANCHES_TO",
    description: `A parent Plot branches to a child sub-plot. Automatically written by \`${TOOL_NAMES.EDIT_PLOT}\`.`,
    sourceLabel: "Plot",
    targetLabel: "Plot",
  },
];

export class RelationshipManager {
  private registry = new Map<string, RelationshipDef>();

  private constructor() {
    for (const t of INTERNAL_TYPES) {
      this.registry.set(makeKey(t.name, t.sourceLabel, t.targetLabel), {
        ...t,
        type: "INTERNAL",
        properties: [],
      });
    }
    for (const t of PREDEFINED_TYPES) {
      this.registry.set(makeKey(t.name, t.sourceLabel, t.targetLabel), {
        ...t,
        type: "PREDEFINED",
        properties: t.properties ?? [],
      });
    }
  }

  register(
    name: string,
    description: string,
    type: "INTERNAL" | "PREDEFINED" | "GM_DEFINED",
    sourceLabel: string,
    targetLabel: string,
    properties?: RelationshipPropertyDef[],
  ): void {
    const key = makeKey(name, sourceLabel, targetLabel);
    const existing = this.registry.get(key);
    if (existing) {
      if (existing.type !== type) {
        console.warn(
          `[RelationshipManager] "${key}" already registered as ${existing.type}, ignoring re-registration as ${type}`,
        );
      }
      return;
    }
    this.registry.set(key, {
      name,
      description,
      type,
      sourceLabel,
      targetLabel,
      properties: properties ?? [],
    });
  }

  get(name: string, sourceLabel: string, targetLabel: string): RelationshipDef | undefined {
    // Exact match first, then try wildcard ("" sentinel)
    const exact = this.registry.get(makeKey(name, sourceLabel, targetLabel));
    if (exact) return exact;
    // Fall back to wildcard entry if one exists
    return this.registry.get(makeKey(name, "", ""));
  }

  getByName(name: string): RelationshipDef[] {
    const prefix = `${name}||`;
    const results: RelationshipDef[] = [];
    for (const [key, def] of this.registry) {
      if (key.startsWith(prefix)) {
        results.push(def);
      }
    }
    return results;
  }

  getAll(): RelationshipDef[] {
    return [...this.registry.values()];
  }

  getByType(type: "INTERNAL" | "PREDEFINED" | "GM_DEFINED"): RelationshipDef[] {
    return [...this.registry.values()].filter((r) => r.type === type);
  }

  isAllowedForWrite(name: string, sourceLabel: string, targetLabel: string): boolean {
    const def = this.get(name, sourceLabel, targetLabel);
    if (!def) return false;
    return def.type === "PREDEFINED" || def.type === "GM_DEFINED";
  }

  isAllowedForRead(name: string, sourceLabel: string, targetLabel: string): boolean {
    return this.get(name, sourceLabel, targetLabel) !== undefined;
  }

  /** Build name vector text from structural info: {source} --[{type}]--> {target}. */
  getEmbeddingNameText(
    name: string,
    _props: Record<string, unknown>,
    sourceName?: string,
    targetName?: string,
  ): string {
    if (sourceName && targetName) {
      return `${sourceName} --[${name}]--> ${targetName}`;
    }
    return `[${name}]`;
  }

  /** Build content vector text from embedded_content-tagged properties. */
  getEmbeddingContentText(name: string, props: Record<string, unknown>): string {
    const defs = this.getByName(name);
    const def = defs[0];
    if (!def) return "";
    const embeddedProps = def.properties.filter((p) => p.tags.includes("embedded_content"));
    return embeddedProps
      .map((p) => {
        const val = props[p.name];
        return val ? `## ${p.name}\n${val}` : "";
      })
      .filter((v) => v.length > 0)
      .join("\n");
  }

  // Keep getEmbeddingText as convenience
  getEmbeddingText(name: string, props: Record<string, unknown>): string {
    return this.getEmbeddingContentText(name, props);
  }

  updateDescription(
    name: string,
    sourceLabel: string,
    targetLabel: string,
    description: string,
  ): boolean {
    const def = this.registry.get(makeKey(name, sourceLabel, targetLabel));
    if (!def || def.type !== "GM_DEFINED") return false;
    def.description = description;
    return true;
  }

  updateDefinition(
    name: string,
    sourceLabel: string,
    targetLabel: string,
    updates: { description?: string; properties?: RelationshipPropertyDef[] },
  ): boolean {
    const def = this.registry.get(makeKey(name, sourceLabel, targetLabel));
    if (!def || def.type !== "GM_DEFINED") return false;
    if (updates.description !== undefined) def.description = updates.description;
    if (updates.properties !== undefined) def.properties = updates.properties;
    return true;
  }

  unregister(name: string, sourceLabel: string, targetLabel: string): boolean {
    const key = makeKey(name, sourceLabel, targetLabel);
    const def = this.registry.get(key);
    if (!def || def.type !== "GM_DEFINED") return false;
    this.registry.delete(key);
    return true;
  }

  // Reload GM_DEFINED types from restored Neo4j after a checkpoint restore.
  async reloadGmDefined(client: Neo4jClient): Promise<void> {
    // Clear existing GM_DEFINED entries
    for (const [key, def] of this.registry) {
      if (def.type === "GM_DEFINED") {
        this.registry.delete(key);
      }
    }
    // Reload from Neo4j
    const rows = await client.executeRead(
      `MATCH (rt:RelationshipType {category: 'GM_DEFINED'}) RETURN rt`,
    );
    for (const row of rows) {
      const rt = row.rt as Record<string, unknown>;
      const name = rt.name as string;
      const description = (rt.description as string) || "";
      const sourceLabel = (rt.source_label as string) || "";
      const targetLabel = (rt.target_label as string) || "";
      let properties: RelationshipPropertyDef[] = [];
      try {
        properties = JSON.parse(rt.properties as string) as RelationshipPropertyDef[];
      } catch {
        /* ignore malformed */
      }
      if (name) {
        this.register(name, description, "GM_DEFINED", sourceLabel, targetLabel, properties);
      }
    }
  }

  reset(): void {
    for (const [key, def] of this.registry) {
      if (def.type === "GM_DEFINED") {
        this.registry.delete(key);
      }
    }
  }

  async syncToNeo4j(client: Neo4jClient): Promise<void> {
    for (const def of this.registry.values()) {
      await client.executeWrite(
        `MERGE (rt:RelationshipType {name: $name, source_label: $sourceLabel, target_label: $targetLabel})
         SET rt.description = $description,
             rt.category = $category,
             rt.properties = $properties`,
        {
          name: def.name,
          description: def.description,
          category: def.type,
          sourceLabel: def.sourceLabel,
          targetLabel: def.targetLabel,
          properties: def.properties.length > 0 ? JSON.stringify(def.properties) : null,
        },
      );

      // Create regular index for properties with tag "index".
      for (const propName of def.properties
        .filter((p) => p.tags.includes("index"))
        .map((p) => p.name)) {
        const indexName = `rel_${def.name.toLowerCase()}_${propName}_idx`;
        try {
          await client.executeWrite(
            `CREATE INDEX ${indexName} IF NOT EXISTS FOR ()-[r:\`${def.name}\`]-() ON (r.\`${propName}\`)`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[RelationshipManager] Index on ${indexName} not created: ${msg}`);
        }
      }

      // Create composite index for each composite_index group.
      for (const index of ["composite_index_1", "composite_index_2", "composite_index_3"]) {
        const props = def.properties
          .filter((p) => p.tags.includes(index as RelationshipPropertyTag))
          .map((p) => p.name);
        if (props.length < 2) continue;
        const indexName = `rel_${def.name.toLowerCase()}_${props.join("_")}_idx${index.at(-1)}`;
        try {
          await client.executeWrite(
            `CREATE INDEX ${indexName} IF NOT EXISTS FOR ()-[r:\`${def.name}\`]-() ON (${props.map((name) => `r.\`${name}\``).join(", ")})`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[RelationshipManager] Composite index on ${indexName} not created: ${msg}`,
          );
        }
      }
    }
  }

  // ── Singleton ──

  private static instance: RelationshipManager | null = null;

  static getCachedInstance(): RelationshipManager {
    if (!RelationshipManager.instance) {
      RelationshipManager.instance = new RelationshipManager();
    }
    return RelationshipManager.instance;
  }
}
