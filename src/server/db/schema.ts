import { v4 as uuidv4 } from "uuid";
import type { LadybugClient } from "@/server/db/ladybug";

export interface PropertyDef {
  name: string;
  description: string;
  tags: string[];
}

export interface NodeTypeDef {
  name: string;
  category: "PREDEFINED" | "GM_DEFINED";
  description: string;
  properties: PropertyDef[];
}

export interface RelTypeDef {
  name: string;
  sourceLabel: string;
  targetLabel: string;
  category: "PREDEFINED" | "GM_DEFINED";
  description: string;
  properties: PropertyDef[];
}

function tagToLadybugType(tags: string[]): string {
  if (tags.includes("number[]")) return "DOUBLE[]";
  if (tags.includes("number")) return "DOUBLE";
  return "STRING";
}

function buildColumnDef(p: PropertyDef, isPk: boolean): string {
  const lbType = tagToLadybugType(p.tags);
  const pkSuffix = isPk ? " PRIMARY KEY" : "";
  return `\`${p.name}\` ${lbType}${pkSuffix}`;
}

function buildPKColumns(props: PropertyDef[]): string[] {
  const pkProps: string[] = [];
  for (const p of props) {
    if (p.tags.includes("unique")) pkProps.push(p.name);
    if (p.tags.includes("composite_unique_1")) pkProps[0] = p.name;
    if (p.tags.includes("composite_unique_2")) pkProps[1] = p.name;
    if (p.tags.includes("composite_unique_3")) pkProps[2] = p.name;
  }
  return pkProps.filter(Boolean);
}

function generateNodeDDL(def: NodeTypeDef): string {
  const pk = buildPKColumns(def.properties);
  const pkSet = new Set(pk);
  const cols = def.properties.map((p) => buildColumnDef(p, pk.length === 1 && pkSet.has(p.name)));
  const colStr = cols.join(", ");
  const pkStr = pk.length > 1 ? `, PRIMARY KEY (${pk.join(", ")})` : "";
  return `CREATE NODE TABLE \`${def.name}\` (${colStr}${pkStr});`;
}

function generateRelDDL(def: RelTypeDef): string {
  const cols = def.properties.map((p) => buildColumnDef(p, false));
  return `CREATE REL TABLE \`${def.name}\` (FROM \`${def.sourceLabel}\` TO \`${def.targetLabel}\`${cols.length > 0 ? ", " + cols.join(", ") : ""});`;
}

const ENTITY_PROPS: PropertyDef[] = [
  { name: "uid", description: "UUID primary key", tags: ["string", "unique"] },
  { name: "name", description: "Entity name", tags: ["string", "embedded_name"] },
  { name: "brief", description: "One-line summary", tags: ["string", "embedded_content"] },
  { name: "description", description: "Full description", tags: ["string", "embedded_content"] },
  { name: "metadata", description: "JSON: stats, conditions, opinions, aliases", tags: ["json"] },
  { name: "_created_at", description: "Creation timestamp", tags: ["string"] },
  { name: "_updated_at", description: "Update timestamp", tags: ["string"] },
];

const PREDEFINED_NODES: NodeTypeDef[] = [
  { name: "Character", category: "PREDEFINED", description: "Player or NPC", properties: ENTITY_PROPS },
  { name: "Object", category: "PREDEFINED", description: "World objects, items", properties: ENTITY_PROPS },
  { name: "Location", category: "PREDEFINED", description: "Rooms, buildings, areas", properties: ENTITY_PROPS },
  {
    name: "Message", category: "PREDEFINED", description: "Conversation messages",
    properties: [
      { name: "id", description: "Message ID", tags: ["string", "unique"] },
      { name: "content", description: "Message text", tags: ["string", "embedded_content"] },
      { name: "timestamp", description: "ISO timestamp", tags: ["string"] },
      { name: "metadata", description: "JSON: speaker, type", tags: ["json"] },
    ],
  },
  {
    name: "Note", category: "PREDEFINED", description: "GM scratchpad notes",
    properties: [
      { name: "name", description: "Note name", tags: ["string", "unique", "embedded_name"] },
      { name: "content", description: "Note text", tags: ["string", "embedded_content"] },
      { name: "_created_at", description: "Creation timestamp", tags: ["string"] },
      { name: "_updated_at", description: "Update timestamp", tags: ["string"] },
    ],
  },
  {
    name: "Plot", category: "PREDEFINED", description: "Narrative plots",
    properties: [
      { name: "name", description: "Plot name", tags: ["string", "unique", "embedded_name"] },
      { name: "description", description: "Plot description", tags: ["string", "embedded_content"] },
      { name: "brief", description: "One-line summary", tags: ["string", "embedded_content"] },
      { name: "status", description: "PENDING/ACTIVE/COMPLETED/ABANDONED", tags: ["string"] },
      { name: "trigger_condition", description: "Activation condition", tags: ["string"] },
      { name: "flags", description: "JSON array of flags", tags: ["json"] },
      { name: "_created_at", description: "Creation timestamp", tags: ["string"] },
      { name: "_updated_at", description: "Update timestamp", tags: ["string"] },
    ],
  },
  {
    name: "Disposition", category: "PREDEFINED", description: "NPC sentiment toward target",
    properties: [
      { name: "uid", description: "UUID", tags: ["string", "unique"] },
      { name: "source_name", description: "NPC name", tags: ["string"] },
      { name: "target_name", description: "Target name", tags: ["string"] },
      { name: "sentiment", description: "Sentiment label", tags: ["string"] },
      { name: "summary", description: "Brief explanation", tags: ["string"] },
      { name: "_created_at", description: "Creation timestamp", tags: ["string"] },
      { name: "_updated_at", description: "Update timestamp", tags: ["string"] },
    ],
  },
  {
    name: "TimePoint", category: "PREDEFINED", description: "Point in game time",
    properties: [
      { name: "uid", description: "UUID", tags: ["string", "unique"] },
      { name: "day", description: "Day number", tags: ["number"] },
      { name: "hour", description: "Hour (0-23.5)", tags: ["number"] },
      { name: "label", description: "Time segment label", tags: ["string"] },
      { name: "_created_at", description: "Creation timestamp", tags: ["string"] },
    ],
  },
  {
    name: "TimeAnchor", category: "PREDEFINED", description: "Singleton anchor to current TimePoint",
    properties: [
      { name: "uid", description: "Always 'anchor'", tags: ["string", "unique"] },
    ],
  },
  {
    name: "Conversation", category: "PREDEFINED", description: "Singleton game session",
    properties: [
      { name: "uid", description: "UUID", tags: ["string", "unique"] },
      { name: "options", description: "JSON: current dialogue options", tags: ["json"] },
      { name: "_created_at", description: "Creation timestamp", tags: ["string"] },
      { name: "_updated_at", description: "Update timestamp", tags: ["string"] },
    ],
  },
  {
    name: "GMTurnMessage", category: "PREDEFINED", description: "AI SDK messages for GM continuity",
    properties: [
      { name: "uid", description: "UUID", tags: ["string", "unique"] },
      { name: "turn_number", description: "Turn number", tags: ["number"] },
      { name: "message_index", description: "Message index within turn", tags: ["number"] },
      { name: "role", description: "Message role", tags: ["string"] },
      { name: "content", description: "JSON message content", tags: ["json"] },
      { name: "provider_options", description: "JSON provider options", tags: ["json"] },
      { name: "_created_at", description: "Creation timestamp", tags: ["string"] },
    ],
  },
  {
    name: "IdCounter", category: "PREDEFINED", description: "Atomic message ID counter",
    properties: [
      { name: "uid", description: "UUID", tags: ["string", "unique"] },
      { name: "value", description: "Current counter value", tags: ["number"] },
    ],
  },
  {
    name: "NodeType", category: "PREDEFINED", description: "Schema node type metadata",
    properties: [
      { name: "name", description: "Node type name", tags: ["string", "unique"] },
      { name: "category", description: "PREDEFINED or GM_DEFINED", tags: ["string"] },
      { name: "description", description: "Type description", tags: ["string"] },
      { name: "properties", description: "JSON property definitions", tags: ["json"] },
    ],
  },
  {
    name: "RelationshipType", category: "PREDEFINED", description: "Schema relationship type metadata",
    properties: [
      { name: "uid", description: "UUID", tags: ["string", "unique"] },
      { name: "name", description: "Relationship type name", tags: ["string"] },
      { name: "source_label", description: "Source node label", tags: ["string"] },
      { name: "target_label", description: "Target node label", tags: ["string"] },
      { name: "category", description: "PREDEFINED or GM_DEFINED", tags: ["string"] },
      { name: "description", description: "Type description", tags: ["string"] },
      { name: "properties", description: "JSON property definitions", tags: ["json"] },
    ],
  },
];

const CREATED_AT = { name: "_created_at", description: "Creation timestamp", tags: ["string"] } as PropertyDef;

const PREDEFINED_RELS: RelTypeDef[] = [
  { name: "LOCATED_AT", sourceLabel: "Character", targetLabel: "Location", category: "PREDEFINED", description: "Character at location", properties: [{ name: "brief", description: "Narrative context", tags: ["string", "embedded_content"] }, CREATED_AT] },
  { name: "LOCATED_AT", sourceLabel: "Object", targetLabel: "Location", category: "PREDEFINED", description: "Object at location", properties: [{ name: "brief", description: "Narrative context", tags: ["string", "embedded_content"] }, CREATED_AT] },
  { name: "CARRIES", sourceLabel: "Character", targetLabel: "Object", category: "PREDEFINED", description: "Character carries object", properties: [{ name: "brief", description: "How/why carried", tags: ["string", "embedded_content"] }, CREATED_AT] },
  { name: "LOCATED_IN", sourceLabel: "Location", targetLabel: "Location", category: "PREDEFINED", description: "Location hierarchy", properties: [{ name: "brief", description: "Narrative context", tags: ["string", "embedded_content"] }, CREATED_AT] },
  { name: "HAS_DISPOSITION", sourceLabel: "Character", targetLabel: "Disposition", category: "PREDEFINED", description: "Character has disposition", properties: [CREATED_AT] },
  { name: "ABOUT_ENTITY", sourceLabel: "Note", targetLabel: "Character", category: "PREDEFINED", description: "Note about character", properties: [CREATED_AT] },
  { name: "ABOUT_ENTITY", sourceLabel: "Note", targetLabel: "Object", category: "PREDEFINED", description: "Note about object", properties: [CREATED_AT] },
  { name: "ABOUT_ENTITY", sourceLabel: "Note", targetLabel: "Location", category: "PREDEFINED", description: "Note about location", properties: [CREATED_AT] },
  { name: "ABOUT_MESSAGE", sourceLabel: "Note", targetLabel: "Message", category: "PREDEFINED", description: "Note about message", properties: [CREATED_AT] },
  { name: "ABOUT_PLOT", sourceLabel: "Note", targetLabel: "Plot", category: "PREDEFINED", description: "Note about plot", properties: [CREATED_AT] },
  { name: "HAS_MESSAGE", sourceLabel: "Conversation", targetLabel: "Message", category: "PREDEFINED", description: "Conversation has message", properties: [CREATED_AT] },
  { name: "FIRST_MESSAGE", sourceLabel: "Conversation", targetLabel: "Message", category: "PREDEFINED", description: "First message link", properties: [CREATED_AT] },
  { name: "NEXT_MESSAGE", sourceLabel: "Message", targetLabel: "Message", category: "PREDEFINED", description: "Message linked list", properties: [CREATED_AT] },
  { name: "BRANCHES_TO", sourceLabel: "Plot", targetLabel: "Plot", category: "PREDEFINED", description: "Plot branching", properties: [CREATED_AT] },
  { name: "CURRENT_TIMEPOINT", sourceLabel: "TimeAnchor", targetLabel: "TimePoint", category: "PREDEFINED", description: "Current time", properties: [CREATED_AT] },
  { name: "NEXT_TIMEPOINT", sourceLabel: "TimePoint", targetLabel: "TimePoint", category: "PREDEFINED", description: "Time progression", properties: [{ name: "reason", description: "Why time advanced", tags: ["string"] }, CREATED_AT] },
  { name: "AT_TIME", sourceLabel: "Message", targetLabel: "TimePoint", category: "PREDEFINED", description: "Message at time", properties: [CREATED_AT] },
  { name: "STARTED_AT", sourceLabel: "Plot", targetLabel: "TimePoint", category: "PREDEFINED", description: "Plot start time", properties: [CREATED_AT] },
  { name: "ACTIVE_AT", sourceLabel: "Plot", targetLabel: "TimePoint", category: "PREDEFINED", description: "Plot active time", properties: [CREATED_AT] },
  { name: "COMPLETED_AT", sourceLabel: "Plot", targetLabel: "TimePoint", category: "PREDEFINED", description: "Plot completion time", properties: [CREATED_AT] },
  { name: "_HAS_GM_MESSAGE", sourceLabel: "Conversation", targetLabel: "GMTurnMessage", category: "PREDEFINED", description: "GM message container", properties: [CREATED_AT] },
  { name: "_FIRST_GM_MESSAGE", sourceLabel: "Conversation", targetLabel: "GMTurnMessage", category: "PREDEFINED", description: "First GM message", properties: [CREATED_AT] },
  { name: "_NEXT_GM_MESSAGE", sourceLabel: "GMTurnMessage", targetLabel: "GMTurnMessage", category: "PREDEFINED", description: "GM message chain", properties: [CREATED_AT] },
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
    const nodeTypes = await client.query("MATCH (nt:NodeType) RETURN nt.name AS name, nt.category AS category, nt.description AS description, nt.properties AS properties");
    for (const row of nodeTypes.rows) {
      const name = row.name as string;
      const category = row.category as string;
      if (category === "GM_DEFINED" && !this.nodes.has(name)) {
        const description = row.description as string || "";
        const props = typeof row.properties === "string" ? JSON.parse(row.properties) as PropertyDef[] : (row.properties as PropertyDef[]) || [];
        this.registerNode({ name, category: "GM_DEFINED", description, properties: props });
      }
    }

    const relTypes = await client.query("MATCH (rt:RelationshipType) RETURN rt.name AS name, rt.source_label AS source_label, rt.target_label AS target_label, rt.category AS category, rt.description AS description, rt.properties AS properties");
    for (const row of relTypes.rows) {
      const name = row.name as string;
      const src = row.source_label as string;
      const tgt = row.target_label as string;
      const category = row.category as string;
      if (category === "GM_DEFINED" && !this.rels.has(this.relKey(name, src, tgt))) {
        const description = row.description as string || "";
        const props = typeof row.properties === "string" ? JSON.parse(row.properties) as PropertyDef[] : (row.properties as PropertyDef[]) || [];
        this.registerRel({ name, sourceLabel: src, targetLabel: tgt, category: "GM_DEFINED", description, properties: props });
      }
    }

    const tables = await client.query("CALL show_tables() RETURN *");
    for (const row of tables.rows) {
      const tableName = row.name as string;
      const tableType = row.type as string;
      if (tableType === "NODE" && !this.nodes.has(tableName)) {
        this.registerNode({ name: tableName, category: "GM_DEFINED", description: "", properties: [] });
      }
    }
  }

  async persistNodeType(client: LadybugClient, name: string): Promise<void> {
    const def = this.nodes.get(name);
    if (!def) return;
    await client.query(
      `MERGE (nt:NodeType {name: $name})
       SET nt.category = $category, nt.description = $description, nt.properties = $properties`,
      { name: def.name, category: def.category, description: def.description, properties: JSON.stringify(def.properties) },
    );
  }

  async persistRelType(client: LadybugClient, name: string, source: string, target: string): Promise<void> {
    const def = this.rels.get(this.relKey(name, source, target));
    if (!def) return;

    // LadybugDB requires PK in the node pattern. MATCH by business key first.
    const existing = await client.query(
      "MATCH (rt:RelationshipType {name: $name, source_label: $src, target_label: $tgt}) RETURN rt.uid AS uid",
      { name: def.name, src: def.sourceLabel, tgt: def.targetLabel },
    );

    if (existing.rows.length > 0) {
      await client.query(
        "MATCH (rt:RelationshipType {uid: $uid}) SET rt.category = $category, rt.description = $description, rt.properties = $properties",
        { uid: existing.rows[0].uid, category: def.category, description: def.description, properties: JSON.stringify(def.properties) },
      );
    } else {
      await client.query(
        "CREATE (rt:RelationshipType {uid: $uid, name: $name, source_label: $src, target_label: $tgt, category: $category, description: $description, properties: $properties})",
        { uid: uuidv4(), name: def.name, src: def.sourceLabel, tgt: def.targetLabel, category: def.category, description: def.description, properties: JSON.stringify(def.properties) },
      );
    }
  }

  getEmbeddingContentText(label: string, props: Record<string, unknown>): string {
    const def = this.nodes.get(label);
    if (!def) return "";
    return def.properties
      .filter((p) => p.tags.includes("embedded_content"))
      .map((p) => String(props[p.name] ?? ""))
      .filter(Boolean)
      .join(" ");
  }

  getEmbeddingNameText(label: string, props: Record<string, unknown>): string {
    const def = this.nodes.get(label);
    if (!def) return "";
    return def.properties
      .filter((p) => p.tags.includes("embedded_name"))
      .map((p) => String(props[p.name] ?? ""))
      .filter(Boolean)
      .join(" ");
  }

  getEmbeddingText(label: string, props: Record<string, unknown>): string {
    return [this.getEmbeddingNameText(label, props), this.getEmbeddingContentText(label, props)].filter(Boolean).join(" ");
  }

  getVectorSearchableNodeTypes(): NodeTypeDef[] {
    return this.getAllNodeTypes().filter((def) =>
      def.properties.some((p) => p.tags.includes("embedded_name") || p.tags.includes("embedded_content"))
    );
  }

  getVectorSearchableRelTypes(): RelTypeDef[] {
    return this.getAllRelTypes().filter((def) =>
      def.properties.some((p) => p.tags.includes("embedded_name") || p.tags.includes("embedded_content"))
    );
  }

  getInternalTypeNames(): string[] {
    return ["Conversation", "GMTurnMessage", "IdCounter", "NodeType", "RelationshipType", "TimeAnchor"];
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

export function getNodeManager(): SchemaRegistry {
  return SchemaRegistry.getInstance();
}
