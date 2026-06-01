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

import { tool } from "ai";
import { z } from "zod";
import { Database } from "@/server/db";
import { getSchemaRegistry } from "@/server/db/schema";
import { extractInternalAndUnknownKeys, wrapSafe } from "@/server/llm/tools/shared";
import { TOOL_NAMES } from "@/shared/constants";

const ENTITY_LABELS = ["Character", "Object", "Location"] as const;
type EntityLabel = (typeof ENTITY_LABELS)[number];

function isEntityLabel(label: string): label is EntityLabel {
  return (ENTITY_LABELS as readonly string[]).includes(label);
}

function visibleProps(node: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!node) return out;
  for (const [k, v] of Object.entries(node)) {
    if (!k.startsWith("_")) out[k] = v;
  }
  return out;
}

const inputSchema = z.object({
  nodeLabel: z.string().describe(
    `
	Node label to operate on (e.g. \`Character\`, \`Object\`, \`Location\`, or a GM-defined label).
	Must be registered in the world schema and writable. Discover available types and their property
	schemas via \`${TOOL_NAMES.GET_CONTEXT}\` (SCHEMA_DUMP).
	`.trim(),
  ),
  action: z
    .enum(["READ", "UPSERT", "DELETE"])
    .describe("READ to look up nodes, UPSERT to create or update, DELETE to remove."),
  match: z.record(z.string(), z.union([z.array(z.string()), z.string()])).describe(
    `
	Key-value pairs to locate nodes. Values can be strings or string arrays (for READ batch lookup).
	For UPSERT/DELETE: multi-key AND semantics, values must be strings.
	For READ: single key required. Array values allowed for batch lookup.
	Examples: { name: 'Tavern' } or { name: ['Player', 'Bartender'] } for READ.
	`.trim(),
  ),
  properties: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe(
      `
	Key-value pairs to set on the node. Must match the property schema for this node type.
	For new nodes, both \`match\` keys and \`properties\` are combined as initial values.
	For existing nodes, only include properties you want to change (partial update).
	Properties tagged "json" receive partial merge.
	System properties (_uid, _created_at, _updated_at) are managed automatically.
	`.trim(),
    ),
});

function validateMatchForAction(
  action: "READ" | "UPSERT" | "DELETE",
  match: Record<string, string | string[]>,
): string | null {
  const keys = Object.keys(match);
  if (keys.length === 0) return "match must not be empty.";

  if (action === "READ") {
    if (keys.length > 1) return "READ requires a single match key.";
    return null; // arrays allowed for batch
  }

  // UPSERT / DELETE: reject array values
  for (const [k, v] of Object.entries(match)) {
    if (Array.isArray(v))
      return `match key "${k}" has an array value. Arrays are only allowed for READ.`;
  }
  return null;
}

function getMatchValues(match: Record<string, string | string[]>): string[] {
  const key = Object.keys(match)[0];
  const val = match[key];
  return Array.isArray(val) ? val : [val];
}

export const manageNode = tool({
  title: TOOL_NAMES.MANAGE_NODE,
  description: `
## Brief
READ, UPSERT, or DELETE nodes. UPSERT creates-or-updates a single node with JSON partial merge
and embedding updates. DELETE removes a node and all its relationships. READ looks up one or
more nodes by a single property key without writing Cypher.

## Actions
- **READ**: Look up nodes by a single match key. Accepts array values for batch lookup
  (e.g. { name: ["Player", "Bartender"] }). Returns all visible properties for each match.
  Does NOT route through the entity model — uses raw Cypher for efficiency on batch reads.
- **UPSERT**: Create-or-update a single node. If it exists, properties are partially updated
  (JSON partial merge). If not, it's created using both \`match\` keys and \`properties\`.
- **DELETE**: Remove a node and all its relationships (DETACH DELETE).

## Node types
Can be used for Character, Object, Location, Disposition, and any GM-defined node type
registered by \`${TOOL_NAMES.MANAGE_SCHEMA}\`. It is not recommended to use this tool to
directly edit Note or Plot (use \`${TOOL_NAMES.EDIT_NOTE}\` / \`${TOOL_NAMES.EDIT_PLOT}\`).

## Disposition
Stored as a NODE (not a relationship), linked via (npc:Character)-[:HAS_DISPOSITION]->(d:Disposition).
Sentiment keywords can be protective, trusting, fearful, hostile, attracted, suspicious, resentful, grateful, indifferent, etc.
Set or update disposition when an NPC's feelings shift due to player actions.

## Example (UPSERT)
Since \`metadata\` is tagged as "json" of node Character in SCHEMA_DUMP, you can partial update player's stats like:
\`\`\`
{
  "nodeLabel": "Character",
  "action": "UPSERT",
  "match": { "_uid": "#player#" },
  "properties": {
    "metadata": {
      "stats": { "logic": 3, "rhetoric": 2 }
    }
  }
}
\`\`\`
`.trim(),
  inputSchema,
  execute: wrapSafe(async (args: z.infer<typeof inputSchema>) => {
    const db = Database.getExisting();
    const registry = getSchemaRegistry();

    // Validate node label ever registered
    const nodeDef = registry.getNodeType(args.nodeLabel);
    const available = new Set(
      registry
        .getAllNodeTypes()
        .filter((n) => n.category !== "INTERNAL")
        .map((n) => n.name),
    );
    if (!nodeDef) {
      return `ERROR: Node label "${args.nodeLabel}" is not registered. Available labels: ${[...available].join(", ")}.`;
    }

    if (!available.has(args.nodeLabel)) {
      return `ERROR: Node label "${args.nodeLabel}" is internal and cannot be written to.`;
    }

    // Build allowed property names from the schema.
    // PREDEFINED types accept any non-_-prefixed property.
    // GM_DEFINED types have explicit schemas and must be validated strictly.
    const schemaProps = new Set(
      nodeDef.properties.map((p) => p.name).filter((name) => !name.startsWith("_")),
    );
    const hasSchema = nodeDef.category === "GM_DEFINED";

    function isPropsKeyExistAndNotInternal(props: Record<string, unknown>): string | null {
      const { internalKeys, unknownKeys } = extractInternalAndUnknownKeys(
        schemaProps,
        hasSchema,
        props,
      );
      const errorTextParts: string[] = [];
      if (internalKeys.length > 0)
        errorTextParts.push(
          `Property "${internalKeys.join("/")}" is internal (prefixed with '_') and cannot be set (managed internally by the engine).`,
        );
      if (unknownKeys.length > 0)
        errorTextParts.push(
          `Unknown property "${unknownKeys.join("/")}" for node type "${args.nodeLabel}". Allowed: ${[...schemaProps].join(", ")}`,
        );
      return errorTextParts.length > 0 ? errorTextParts.join(" ") : null;
    }

    function isMatchKeysInternal(match: Record<string, string>): string | null {
      const errorKeys: string[] = [];
      for (const key of Object.keys(match)) {
        if (key.startsWith("_")) errorKeys.push(key);
      }
      return errorKeys.length > 0
        ? `Parameter \`match\` contain invalid key "${errorKeys.join("/")}", which ${errorKeys.length > 1 ? "are" : "is"} internal and managed by the engine.`
        : null;
    }

    // Serialize plain objects to JSON strings for graph compatibility.
    function toPropertyValue(v: unknown): unknown {
      if (v === null || v === undefined) return v;
      if (typeof v === "object" && !Array.isArray(v)) return JSON.stringify(v);
      return v;
    }

    function buildWhere(match: Record<string, string>, params: Record<string, unknown>): string {
      const parts = Object.entries(match).map(([key, value], i) => {
        const pName = `mk${i}`;
        params[pName] = value;
        return `n.\`${key}\` = $${pName}`;
      });
      return parts.join(" AND ");
    }

    const allSchemaProps = new Set(nodeDef.properties.map((p) => p.name));
    const useModel = isEntityLabel(args.nodeLabel);

    // ── READ ──
    if (args.action === "READ") {
      const matchErr = validateMatchForAction("READ", args.match);
      if (matchErr) return `ERROR: ${matchErr}`;

      const matchKey = Object.keys(args.match)[0];
      const values = getMatchValues(args.match);

      const result = await db.graph.query(
        `MATCH (n:\`${args.nodeLabel}\`) WHERE n.\`${matchKey}\` IN $values RETURN n`,
        { values },
      );

      if (result.rows.length === 0) {
        return `No "${args.nodeLabel}" nodes found matching ${matchKey} in [${values.join(", ")}].`;
      }

      const found = new Set<string>();
      const lines: string[] = [];
      for (const row of result.rows) {
        const n = (row.n || row) as Record<string, unknown>;
        const matchVal = String(n[matchKey] ?? "");
        found.add(matchVal);
        lines.push(JSON.stringify(n, null, 2));
      }

      const notFound = values.filter((v) => !found.has(v));
      if (notFound.length > 0) {
        lines.push(`Not found: ${notFound.join(", ")}`);
      }

      return lines.join("\n");
    }

    // ── DELETE ──
    if (args.action === "DELETE") {
      const matchErr = validateMatchForAction("DELETE", args.match);
      if (matchErr) return `ERROR: ${matchErr}`;
      const internalErr = isMatchKeysInternal(args.match as Record<string, string>);
      if (internalErr) return `ERROR: ${internalErr}`;

      if (useModel) {
        const deleted = await db.entities.delete(
          args.nodeLabel as EntityLabel,
          args.match as Record<string, string>,
        );
        return deleted > 0
          ? `Node "${args.nodeLabel}" matched by ${JSON.stringify(args.match)} deleted.`
          : `ERROR: No "${args.nodeLabel}" node found matching ${JSON.stringify(args.match)}.`;
      }

      const params: Record<string, unknown> = {};
      const where = buildWhere(args.match as Record<string, string>, params);
      const result = await db.graph.query(
        `MATCH (n:\`${args.nodeLabel}\`) WHERE ${where} DETACH DELETE n RETURN count(n) AS deleted`,
        params,
      );
      return (result.rows[0]?.deleted as number) > 0
        ? `Node "${args.nodeLabel}" matched by ${JSON.stringify(args.match)} deleted.`
        : `ERROR: No "${args.nodeLabel}" node found matching ${JSON.stringify(args.match)}.`;
    }

    // ── UPSERT ──
    if (args.action === "UPSERT") {
      const matchErr = validateMatchForAction("UPSERT", args.match);
      if (matchErr) return `ERROR: ${matchErr}`;
      const internalErr = isMatchKeysInternal(args.match as Record<string, string>);
      if (internalErr) return `ERROR: ${internalErr}`;

      const matchParams: Record<string, unknown> = {};
      const where = buildWhere(args.match as Record<string, string>, matchParams);

      // Check if node already exists
      const existing = await db.graph.query(
        `MATCH (n:\`${args.nodeLabel}\`) WHERE ${where} RETURN n`,
        matchParams,
      );
      if (existing.rows.length > 1) {
        return `ERROR: There are ${existing.rows.length} matching nodes. Use more specific match criteria.`;
      }

      const exists = existing.rows.length === 1;

      // ── UPDATE existing node ──
      if (exists) {
        if (!args.properties || Object.keys(args.properties).length === 0) {
          return "ERROR: Node already exists but no properties were provided to update.";
        }

        const propErr = isPropsKeyExistAndNotInternal(args.properties);
        if (propErr) return `ERROR: ${propErr}`;

        if (useModel) {
          const entity = await db.entities.update(
            args.nodeLabel as EntityLabel,
            args.match as Record<string, string>,
            args.properties,
          );
          if (!entity) {
            return `ERROR: No "${args.nodeLabel}" node found matching ${JSON.stringify(args.match)}.`;
          }
          return `Node "${args.nodeLabel}" "${entity.name}" updated properties: ${Object.keys(args.properties).join(", ")}.`;
        }

        const existingNode = existing.rows[0]?.n as Record<string, unknown> | undefined;

        // Properties tagged "json" are stored as JSON strings. Read the existing value
        // and shallow-merge the incoming ones so partial updates don't clobber.
        const propertiesToSet = { ...args.properties };
        const jsonPropNames = new Set(
          nodeDef.properties.filter((p) => p.tags.includes("json")).map((p) => p.name),
        );
        for (const key of Object.keys(args.properties)) {
          if (!jsonPropNames.has(key)) continue;
          const incoming = args.properties[key] as Record<string, unknown>;
          const existingRaw = existingNode?.[key];
          let existingObj: Record<string, unknown> = {};
          if (existingRaw && typeof existingRaw === "object" && !Array.isArray(existingRaw)) {
            existingObj = existingRaw as Record<string, unknown>;
          }
          propertiesToSet[key] = { ...existingObj, ...incoming };
        }

        const setParams: Record<string, unknown> = { ...matchParams };
        const setters: string[] = [];
        if (allSchemaProps.has("_updated_at")) setters.push("n._updated_at = current_timestamp()");
        for (const [key, value] of Object.entries(propertiesToSet)) {
          const pName = `s_${key}`;
          setParams[pName] = toPropertyValue(value);
          setters.push(`n.\`${key}\` = $${pName}`);
        }

        await db.graph.query(
          `MATCH (n:\`${args.nodeLabel}\`) WHERE ${where} SET ${setters.join(", ")}`,
          setParams,
        );

        return `Node "${args.nodeLabel}" updated properties: ${Object.keys(args.properties).join(", ")}.`;
      }

      // ── CREATE new node ──
      if (!args.properties || Object.keys(args.properties).length === 0) {
        return "ERROR: Parameter `properties` is required to create a new node.";
      }

      if (useModel) {
        const props = args.properties;
        const entity = await db.entities.create(args.nodeLabel as EntityLabel, {
          name: (args.match.name ?? props.name) as string,
          brief: props.brief as string | undefined,
          description: props.description as string | undefined,
          metadata: props.metadata as Record<string, unknown> | undefined,
        });
        return `Node "${args.nodeLabel}" "${entity.name}" created.`;
      }

      // Non-entity types: merge match keys as initial property values
      const mergedProps = { ...args.match, ...args.properties };
      const mergedErr = isPropsKeyExistAndNotInternal(mergedProps);
      if (mergedErr) return `ERROR: ${mergedErr}`;

      const params: Record<string, unknown> = {};
      const setters: string[] = [];
      if (allSchemaProps.has("_created_at")) setters.push("n._created_at = current_timestamp()");
      if (allSchemaProps.has("_updated_at")) setters.push("n._updated_at = current_timestamp()");
      for (const [key, value] of Object.entries(mergedProps)) {
        const pName = `p_${key}`;
        params[pName] = toPropertyValue(value);
        setters.push(`n.\`${key}\` = $${pName}`);
      }

      const result = await db.graph.query(
        `CREATE (n:\`${args.nodeLabel}\`) SET ${setters.join(", ")} RETURN n`,
        params,
      );
      const created = result.rows[0]?.n as Record<string, unknown> | undefined;
      const v = visibleProps(created);
      const propSummary =
        Object.keys(v).length > 0 ? ` with keys: ${Object.keys(v).join(", ")}` : "";
      return `Node "${args.nodeLabel}" created${propSummary}.`;
    }

    return `ERROR: Unknown action "${args.action}". Valid actions: READ, UPSERT, DELETE.`;
  }, TOOL_NAMES.MANAGE_NODE),
});
