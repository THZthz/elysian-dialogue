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

import { v4 as uuidv4 } from "uuid";
import type { LadybugClient } from "@/server/db/ladybug";
import { TOOL_NAMES } from "@/shared/constants";

export const NODE_PROPERTY_TAGS = [
  "string",
  "number",
  "number[]",
  "json",
  "embedded",
  "unique",
] as const;
export type NodePropertyTag = (typeof NODE_PROPERTY_TAGS)[number];

export interface NodePropertyDef {
  name: string;
  description: string;
  tags: NodePropertyTag[];
}

export interface NodeTypeDef {
  name: string;
  category: "INTERNAL" | "PREDEFINED" | "GM_DEFINED";
  description: string;
  properties: NodePropertyDef[];
}

export const REL_PROPERTY_TAGS = ["string", "number", "number[]", "json", "embedded"] as const;
export type RelPropertyTag = (typeof REL_PROPERTY_TAGS)[number];

export interface RelPropertyDef {
  name: string;
  description: string;
  tags: RelPropertyTag[];
}

export interface RelTypeDef {
  name: string;
  sourceLabel: string;
  targetLabel: string;
  category: "INTERNAL" | "PREDEFINED" | "GM_DEFINED";
  description: string;
  properties: RelPropertyDef[];
}

function tagToLadybugType(tags: string[]): string {
  if (tags.includes("json")) return "JSON";
  if (tags.includes("number[]")) return "DOUBLE[]";
  if (tags.includes("number")) return "DOUBLE";
  return "STRING";
}

function buildColumnDef(p: NodePropertyDef, isPk: boolean): string {
  const lbType = tagToLadybugType(p.tags);
  const pkSuffix = isPk ? " PRIMARY KEY" : "";
  return `\`${p.name}\` ${lbType}${pkSuffix}`;
}

function buildPKColumns(props: NodePropertyDef[]): string[] {
  const pkProps: string[] = [];
  for (const p of props) {
    if (p.tags.includes("unique")) pkProps.push(p.name);
  }
  return pkProps.filter(Boolean);
}

function generateNodeDDL(def: NodeTypeDef): string {
  const pk = buildPKColumns(def.properties);
  const pkSet = new Set(pk);
  const cols = def.properties.map((p) => buildColumnDef(p, pk.length === 1 && pkSet.has(p.name)));
  const colStr = cols.join(", ");
  const pkStr = pk.length > 1 ? `, PRIMARY KEY (${pk.map((n) => `\`${n}\``).join(", ")})` : "";
  return `CREATE NODE TABLE \`${def.name}\` (${colStr}${pkStr});`;
}

function generateRelDDL(def: RelTypeDef): string {
  const cols = def.properties.map((p) => buildColumnDef(p, false));
  return `CREATE REL TABLE \`${def.name}\` (FROM \`${def.sourceLabel}\` TO \`${def.targetLabel}\`${cols.length > 0 ? ", " + cols.join(", ") : ""});`;
}

// WARNING: The schema description should be useful since it will be used by GM, which has no prior knowledge.

const CREATED_AT_PROP: any = {
  name: "_created_at",
  description: "ISO 8601 timestamp of creation.",
  tags: ["string"],
};
const UPDATED_AT_PROP: any = {
  name: "_updated_at",
  description: "ISO 8601 timestamp of last update.",
  tags: ["string"],
};

const ENTITY_PROPS: NodePropertyDef[] = [
  { name: "_uid", description: "UUID.", tags: ["string"] },
  { name: "name", description: "Unique name.", tags: ["string", "embedded", "unique"] },
  { name: "brief", description: "One-line summary.", tags: ["string", "embedded"] },
  { name: "description", description: "Full description.", tags: ["string", "embedded"] },
  {
    name: "metadata",
    description:
      "JSON: { stats, conditions, opinions, aliases }. Fully optional. \`stats\` (skill→value) is for player only.",
    tags: ["json"],
  },
  CREATED_AT_PROP,
  UPDATED_AT_PROP,
];

const PREDEFINED_NODES: NodeTypeDef[] = [
  {
    name: "Character",
    category: "PREDEFINED",
    description: "A world character (NPC or player).",
    properties: [...ENTITY_PROPS],
  },
  {
    name: "Object",
    category: "PREDEFINED",
    description: "A world object (items, artifacts, weapons).",
    properties: [...ENTITY_PROPS],
  },
  {
    name: "Location",
    category: "PREDEFINED",
    description: "A world location (rooms, buildings, areas).",
    properties: [...ENTITY_PROPS],
  },
  {
    name: "Note",
    category: "PREDEFINED",
    description: `GM scratchpad note. Can link to Entities, Scenes, or Plots via ABOUT_CHARACTER / ABOUT_OBJECT / ABOUT_LOCATION / ABOUT_SCENE / ABOUT_PLOT. Managed by \`${TOOL_NAMES.EDIT_NOTE}\`.`,
    properties: [
      {
        name: "name",
        description: "Unique note name.",
        tags: ["string", "unique", "embedded"],
      },
      { name: "content", description: "Note text..", tags: ["string", "embedded"] },
      CREATED_AT_PROP,
      UPDATED_AT_PROP,
    ],
  },
  {
    name: "Plot",
    category: "PREDEFINED",
    description: `A narrative plot with status, branches and flags. Drives story progression. Managed by \`${TOOL_NAMES.EDIT_PLOT}\`.`,
    properties: [
      {
        name: "name",
        description: "Unique plot name.",
        tags: ["string", "unique", "embedded"],
      },
      {
        name: "description",
        description: "Full plot descriptions.",
        tags: ["string", "embedded"],
      },
      { name: "brief", description: "One-line summary.", tags: ["string", "embedded"] },
      {
        name: "status",
        description: "Plot lifecycle: PENDING → ACTIVE → COMPLETED/ABANDONED.",
        tags: ["string"],
      },
      { name: "trigger_condition", description: "Plot activation condition.", tags: ["string"] },
      { name: "flags", description: "JSON for key-value pair of flags.", tags: ["json"] },
      CREATED_AT_PROP,
      UPDATED_AT_PROP,
    ],
  },
  {
    name: "Disposition",
    category: "PREDEFINED",
    description:
      "A Character's disposition toward a target entity. Stored as a NODE (not a relationship). Match via (npc:Character)-[:HAS_DISPOSITION]->(d:Disposition {target_name: '...'}).",
    properties: [
      { name: "_uid", description: "UUID.", tags: ["string", "unique"] },
      {
        name: "source_name",
        description: "Source NPC that holds this disposition.",
        tags: ["string"],
      },
      { name: "target_name", description: "Target character name.", tags: ["string"] },
      { name: "sentiment", description: "One word sentiment label.", tags: ["string"] },
      { name: "summary", description: "Brief explanation.", tags: ["string"] },
      CREATED_AT_PROP,
      UPDATED_AT_PROP,
    ],
  },
  {
    name: "Scene",
    category: "PREDEFINED",
    description:
      "A narrative scene tracking time, location, characters, log, and dialogue options. Active scene has end_time IS NULL.",
    properties: [
      { name: "name", description: "Unique scene ID (scene_XXXX).", tags: ["string", "unique"] },
      {
        name: "start_time",
        description: "Scene start time: day * 48 + half-hour.",
        tags: ["number"],
      },
      { name: "end_time", description: "Scene end time. NULL = still active.", tags: ["number"] },
      {
        name: "location_name",
        description: "Location.name for this scene. NULL for placeholder scenes.",
        tags: ["string"],
      },
      {
        name: "characters",
        description: "JSON array of character names present in this scene.",
        tags: ["json"],
      },
      {
        name: "log",
        description: "JSON array of log entries (gm, player, roll types).",
        tags: ["json"],
      },
      {
        name: "options",
        description: "JSON: current dialogue options for the active scene.",
        tags: ["json"],
      },
      UPDATED_AT_PROP,
    ],
  },
  {
    name: "Conversation",
    category: "INTERNAL",
    description: "Singleton game session",
    properties: [
      { name: "_uid", description: "UUID", tags: ["string", "unique"] },
      { name: "_created_at", description: "Creation timestamp", tags: ["string"] },
      { name: "_updated_at", description: "Update timestamp", tags: ["string"] },
    ],
  },
  {
    name: "GMTurnMessage",
    category: "INTERNAL",
    description:
      "Singleton node storing the game session. Internal bookkeeping — not visible to GM.",
    properties: [
      { name: "_uid", description: "UUID.", tags: ["string", "unique"] },
      { name: "turn_number", description: "Turn number.", tags: ["number"] },
      { name: "message_index", description: "Message index within turn.", tags: ["number"] },
      { name: "role", description: "Message role.", tags: ["string"] },
      { name: "content", description: "JSON message content.", tags: ["json"] },
      { name: "provider_options", description: "JSON provider options.", tags: ["json"] },
      CREATED_AT_PROP,
    ],
  },
  {
    name: "IdCounter",
    category: "INTERNAL",
    description: "Atomic message ID counter.",
    properties: [
      { name: "_uid", description: "UUID.", tags: ["string", "unique"] },
      { name: "value", description: "Current counter value.", tags: ["number"] },
    ],
  },
  {
    name: "NodeType",
    category: "INTERNAL",
    description: "Schema node type metadata",
    properties: [
      { name: "name", description: "Node type name.", tags: ["string", "unique"] },
      { name: "category", description: "INTERNAL, PREDEFINED or GM_DEFINED.", tags: ["string"] },
      { name: "description", description: "Type description.", tags: ["string"] },
      { name: "properties", description: "JSON property definitions.", tags: ["json"] },
    ],
  },
  {
    name: "RelationshipType",
    category: "INTERNAL",
    description: "Schema relationship type metadata",
    properties: [
      { name: "_uid", description: "UUID.", tags: ["string", "unique"] },
      { name: "name", description: "Relationship type name.", tags: ["string"] },
      { name: "source_label", description: "Source node label.", tags: ["string"] },
      { name: "target_label", description: "Target node label.", tags: ["string"] },
      { name: "category", description: "INTERNAL, PREDEFINED or GM_DEFINED.", tags: ["string"] },
      { name: "description", description: "Type description.", tags: ["string"] },
      { name: "properties", description: "JSON property definitions.", tags: ["json"] },
    ],
  },
];

const PREDEFINED_RELS: RelTypeDef[] = [
  {
    name: "_HAS_GM_MESSAGE",
    sourceLabel: "Conversation",
    targetLabel: "GMTurnMessage",
    category: "INTERNAL",
    description: "GM message container.",
    properties: [CREATED_AT_PROP],
  },
  {
    name: "_FIRST_GM_MESSAGE",
    sourceLabel: "Conversation",
    targetLabel: "GMTurnMessage",
    category: "INTERNAL",
    description: "First GM message.",
    properties: [CREATED_AT_PROP],
  },
  {
    name: "_NEXT_GM_MESSAGE",
    sourceLabel: "GMTurnMessage",
    targetLabel: "GMTurnMessage",
    category: "INTERNAL",
    description: "GM message chain.",
    properties: [CREATED_AT_PROP],
  },
  {
    name: "LOCATED_AT",
    sourceLabel: "Character",
    targetLabel: "Location",
    category: "PREDEFINED",
    description: "Character at location.",
    properties: [
      {
        name: "brief",
        description:
          "Spatial position detail — how/where exactly the character is located (e.g., 'hiding behind crates', 'slumped at the bar').",
        tags: ["string", "embedded"],
      },
      { name: "created_at", description: "Birth time: day * 48 + half-hour.", tags: ["number"] },
      { name: "valid_at", description: "Death time. NULL = still valid.", tags: ["number"] },
      CREATED_AT_PROP,
      UPDATED_AT_PROP,
    ],
  },
  {
    name: "LOCATED_AT",
    sourceLabel: "Object",
    targetLabel: "Location",
    category: "PREDEFINED",
    description: "Object at location.",
    properties: [
      {
        name: "brief",
        description: "Spatial position detail — where exactly the object is located.",
        tags: ["string", "embedded"],
      },
      { name: "created_at", description: "Birth time: day * 48 + half-hour.", tags: ["number"] },
      { name: "valid_at", description: "Death time. NULL = still valid.", tags: ["number"] },
      CREATED_AT_PROP,
      UPDATED_AT_PROP,
    ],
  },
  {
    name: "LOCATED_AT",
    sourceLabel: "Object",
    targetLabel: "Character",
    category: "PREDEFINED",
    description: "Character carries object.",
    properties: [
      {
        name: "brief",
        description: "How the item is carried (e.g., 'concealed in a boot', 'worn openly on hip').",
        tags: ["string", "embedded"],
      },
      { name: "created_at", description: "Birth time: day * 48 + half-hour.", tags: ["number"] },
      { name: "valid_at", description: "Death time. NULL = still valid.", tags: ["number"] },
      CREATED_AT_PROP,
      UPDATED_AT_PROP,
    ],
  },
  {
    name: "LOCATED_IN",
    sourceLabel: "Location",
    targetLabel: "Location",
    category: "PREDEFINED",
    description:
      "A location is contained within a larger location (e.g., a basement inside a tavern).",
    properties: [
      {
        name: "brief",
        description:
          "Access or containment detail (e.g., 'accessed through a trapdoor behind the bar').",
        tags: ["string", "embedded"],
      },
      { name: "created_at", description: "Birth time: day * 48 + half-hour.", tags: ["number"] },
      { name: "valid_at", description: "Death time. NULL = still valid.", tags: ["number"] },
      CREATED_AT_PROP,
      UPDATED_AT_PROP,
    ],
  },
  {
    name: "HAS_DISPOSITION",
    sourceLabel: "Character",
    targetLabel: "Disposition",
    category: "PREDEFINED",
    description: "Character has disposition.",
    properties: [
      { name: "created_at", description: "Birth time: day * 48 + half-hour.", tags: ["number"] },
      { name: "valid_at", description: "Death time. NULL = still valid.", tags: ["number"] },
      CREATED_AT_PROP,
      UPDATED_AT_PROP,
    ],
  },
  {
    name: "ABOUT_CHARACTER",
    sourceLabel: "Note",
    targetLabel: "Character",
    category: "PREDEFINED",
    description: `Note about character. Managed by \`${TOOL_NAMES.EDIT_NOTE}\`.`,
    properties: [CREATED_AT_PROP],
  },
  {
    name: "ABOUT_OBJECT",
    sourceLabel: "Note",
    targetLabel: "Object",
    category: "PREDEFINED",
    description: `Note about object. Managed by \`${TOOL_NAMES.EDIT_NOTE}\`.`,
    properties: [CREATED_AT_PROP],
  },
  {
    name: "ABOUT_LOCATION",
    sourceLabel: "Note",
    targetLabel: "Location",
    category: "PREDEFINED",
    description: `Note about location. Managed by \`${TOOL_NAMES.EDIT_NOTE}\`.`,
    properties: [CREATED_AT_PROP],
  },
  {
    name: "ABOUT_PLOT",
    sourceLabel: "Note",
    targetLabel: "Plot",
    category: "PREDEFINED",
    description: `Note about plot. Managed by \`${TOOL_NAMES.EDIT_NOTE}\`.`,
    properties: [CREATED_AT_PROP],
  },
  {
    name: "BRANCHES_TO",
    sourceLabel: "Plot",
    targetLabel: "Plot",
    category: "PREDEFINED",
    description: "Plot branching",
    properties: [CREATED_AT_PROP],
  },
  {
    name: "COMPLETED_AT",
    sourceLabel: "Plot",
    targetLabel: "Scene",
    category: "PREDEFINED",
    description: `The scene where plot completed. Managed by \`${TOOL_NAMES.EDIT_PLOT}\`.`,
    properties: [CREATED_AT_PROP],
  },
  {
    name: "STARTED_AT",
    sourceLabel: "Plot",
    targetLabel: "Scene",
    category: "PREDEFINED",
    description: "The scene where plot started. Managed by editPlot.",
    properties: [CREATED_AT_PROP],
  },
  {
    name: "NEXT_SCENE",
    sourceLabel: "Scene",
    targetLabel: "Scene",
    category: "PREDEFINED",
    description: "Chronological scene chain. Replaces NEXT_TIMEPOINT.",
    properties: [
      { name: "reason", description: "Why scene changed.", tags: ["string"] },
      CREATED_AT_PROP,
      UPDATED_AT_PROP,
    ],
  },
  {
    name: "ABOUT_SCENE",
    sourceLabel: "Note",
    targetLabel: "Scene",
    category: "PREDEFINED",
    description: "Note about scene. Managed by editNote.",
    properties: [CREATED_AT_PROP],
  },
  {
    name: "CARRIES",
    sourceLabel: "Character",
    targetLabel: "Object",
    category: "PREDEFINED",
    description: "Character carries object.",
    properties: [
      {
        name: "brief",
        description: "How the item is carried.",
        tags: ["string", "embedded"],
      },
      { name: "created_at", description: "Birth time: day * 48 + half-hour.", tags: ["number"] },
      { name: "valid_at", description: "Death time. NULL = still valid.", tags: ["number"] },
      UPDATED_AT_PROP,
      CREATED_AT_PROP,
    ],
  },
];

export class SchemaRegistry {
  private nodes = new Map<string, NodeTypeDef>();
  private rels = new Map<string, RelTypeDef>();

  private relKey(name: string, source: string, target: string): string {
    return `${name}|${source}|${target}`;
  }

  registerNode(def: NodeTypeDef): void {
    this.nodes.set(def.name, def);
  }

  registerRel(def: RelTypeDef): void {
    this.rels.set(this.relKey(def.name, def.sourceLabel, def.targetLabel), def);
  }

  getNodeType(name: string): NodeTypeDef | undefined {
    return this.nodes.get(name);
  }

  getRelType(name: string, source: string, target: string): RelTypeDef | undefined {
    return this.rels.get(this.relKey(name, source, target));
  }

  getRelTypeByName(name: string): RelTypeDef[] {
    const results: RelTypeDef[] = [];
    for (const def of this.rels.values()) {
      if (def.name === name) results.push(def);
    }
    return results;
  }

  isTemporalRelType(def: RelTypeDef): boolean {
    const names = new Set(def.properties.map((p) => p.name));
    return names.has("created_at") && names.has("valid_at");
  }

  getAllNodeTypes(): NodeTypeDef[] {
    return [...this.nodes.values()];
  }

  getAllRelTypes(): RelTypeDef[] {
    return [...this.rels.values()];
  }

  generateNodeDDL(name: string): string | null {
    const def = this.nodes.get(name);
    if (!def) return null;
    return generateNodeDDL(def);
  }

  generateRelDDL(name: string, source: string, target: string): string | null {
    const def = this.rels.get(this.relKey(name, source, target));
    if (!def) return null;
    return generateRelDDL(def);
  }

  allNodeDDL(): string[] {
    return [...this.nodes.values()].map(generateNodeDDL);
  }

  allRelDDL(): string[] {
    return [...this.rels.values()].map(generateRelDDL);
  }

  registerPredefined(): void {
    for (const node of PREDEFINED_NODES) this.registerNode(node);
    for (const rel of PREDEFINED_RELS) this.registerRel(rel);
  }

  async syncFromDB(client: LadybugClient): Promise<void> {
    const nodeTypes = await client.query(
      "MATCH (nt:NodeType) RETURN nt.name AS name, nt.category AS category, nt.description AS description, nt.properties AS properties",
    );
    for (const row of nodeTypes.rows) {
      const name = row.name as string;
      const category = row.category as string;
      if (category === "GM_DEFINED" && !this.nodes.has(name)) {
        const description = (row.description as string) || "";
        const props = (row.properties as NodePropertyDef[]) || [];
        this.registerNode({ name, category: "GM_DEFINED", description, properties: props });
      }
    }

    const relTypes = await client.query(
      "MATCH (rt:RelationshipType) RETURN rt.name AS name, rt.source_label AS source_label, rt.target_label AS target_label, rt.category AS category, rt.description AS description, rt.properties AS properties",
    );
    for (const row of relTypes.rows) {
      const name = row.name as string;
      const src = row.source_label as string;
      const tgt = row.target_label as string;
      const category = row.category as string;
      if (category === "GM_DEFINED" && !this.rels.has(this.relKey(name, src, tgt))) {
        const description = (row.description as string) || "";
        const props = (row.properties as RelPropertyDef[]) || [];
        this.registerRel({
          name,
          sourceLabel: src,
          targetLabel: tgt,
          category: "GM_DEFINED",
          description,
          properties: props,
        });
      }
    }

    const tables = await client.query("CALL show_tables() RETURN *");
    for (const row of tables.rows) {
      const tableName = row.name as string;
      const tableType = row.type as string;
      if (tableType === "NODE" && !this.nodes.has(tableName)) {
        this.registerNode({
          name: tableName,
          category: "GM_DEFINED",
          description: "",
          properties: [],
        });
      }
    }
  }

  async persistNodeType(client: LadybugClient, name: string): Promise<void> {
    const def = this.nodes.get(name);
    if (!def) return;
    await client.query(
      `MERGE (nt:NodeType {name: $name})
       SET nt.category = $category, nt.description = $description, nt.properties = $properties`,
      {
        name: def.name,
        category: def.category,
        description: def.description,
        properties: JSON.stringify(def.properties),
      },
    );
  }

  async persistRelType(
    client: LadybugClient,
    name: string,
    source: string,
    target: string,
  ): Promise<void> {
    const def = this.rels.get(this.relKey(name, source, target));
    if (!def) return;

    // LadybugDB requires PK in the node pattern. MATCH by business key first.
    const existing = await client.query(
      "MATCH (rt:RelationshipType {name: $name, source_label: $src, target_label: $tgt}) RETURN rt._uid AS _uid",
      { name: def.name, src: def.sourceLabel, tgt: def.targetLabel },
    );

    if (existing.rows.length > 0) {
      await client.query(
        "MATCH (rt:RelationshipType {_uid: $_uid}) SET rt.category = $category, rt.description = $description, rt.properties = $properties",
        {
          _uid: existing.rows[0]._uid,
          category: def.category,
          description: def.description,
          properties: JSON.stringify(def.properties),
        },
      );
    } else {
      await client.query(
        "CREATE (rt:RelationshipType {_uid: $_uid, name: $name, source_label: $src, target_label: $tgt, category: $category, description: $description, properties: $properties})",
        {
          _uid: uuidv4(),
          name: def.name,
          src: def.sourceLabel,
          tgt: def.targetLabel,
          category: def.category,
          description: def.description,
          properties: JSON.stringify(def.properties),
        },
      );
    }
  }

  getEmbeddingText(label: string, props: Record<string, unknown>): string {
    const def = this.nodes.get(label);
    if (!def) return "";
    return def.properties
      .filter((p) => p.tags.includes("embedded"))
      .map((p) => String(props[p.name] ?? ""))
      .filter(Boolean)
      .join(" ");
  }

  getVectorSearchableNodeTypes(): NodeTypeDef[] {
    return this.getAllNodeTypes().filter((def) =>
      def.properties.some((p) => p.tags.includes("embedded")),
    );
  }

  getVectorSearchableRelTypes(): RelTypeDef[] {
    return this.getAllRelTypes().filter((def) =>
      def.properties.some((p) => p.tags.includes("embedded")),
    );
  }

  getInternalTypeNames(): string[] {
    return ["Conversation", "GMTurnMessage", "IdCounter", "NodeType", "RelationshipType"];
  }

  private static instance: SchemaRegistry | null = null;

  static getInstance(): SchemaRegistry {
    if (!SchemaRegistry.instance) {
      SchemaRegistry.instance = new SchemaRegistry();
      SchemaRegistry.instance.registerPredefined();
    }
    return SchemaRegistry.instance;
  }

  static resetInstance(): void {
    SchemaRegistry.instance = null;
  }
}

export function getSchemaRegistry(): SchemaRegistry {
  return SchemaRegistry.getInstance();
}
