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
import { SchemaRegistry, type RelTypeDef, getSchemaRegistry } from "@/server/db/schema";
import { extractInternalAndUnknownKeys, wrapSafe } from "@/server/llm/tools/shared";
import { getEmbedder } from "@/server/search/embedder";
import { encodeSparse } from "@/server/search/sparseEncoder";
import { TOOL_NAMES } from "@/shared/constants";

// Schema stores pipe-delimited source/target labels (e.g. "Character|Object").
// The LLM passes individual labels, so we need fuzzy matching.
function matchesEndpoint(defLabel: string, queryLabel: string): boolean {
  if (defLabel === queryLabel) return true;
  if (defLabel.includes("|")) {
    return defLabel.split("|").includes(queryLabel);
  }
  return false;
}

function findRelType(
  schema: SchemaRegistry,
  name: string,
  srcLabel: string,
  tgtLabel: string,
): RelTypeDef | undefined {
  const candidates = schema.getRelTypeByName(name);
  return candidates.find(
    (def) =>
      matchesEndpoint(def.sourceLabel, srcLabel) && matchesEndpoint(def.targetLabel, tgtLabel),
  );
}

function isTemporalRel(def: RelTypeDef): boolean {
  return SchemaRegistry.getInstance().isTemporalRelType(def);
}

function getRelEmbeddingContentText(def: RelTypeDef, props: Record<string, unknown>): string {
  return def.properties
    .filter((p) => p.tags.includes("embedded"))
    .map((p) => String(props[p.name] ?? ""))
    .filter(Boolean)
    .join(" ");
}

function getRelEmbeddingNameText(
  name: string,
  _props: Record<string, unknown>,
  srcVal: string,
  tgtVal: string,
): string {
  return `[${name}] ${srcVal} -> ${tgtVal}`;
}

const inputSchema = z.object({
  relationshipType: z
    .string()
    .describe(
      `The relationship type (e.g. 'LOCATED_AT', 'CARRIES', 'LOCATED_IN', or GM-defined). Must be registered in the world schema and writable. Use Disposition nodes for character attitudes instead of relationships. Discover available types via \`${TOOL_NAMES.GET_CONTEXT}\` SCHEMA_DUMP.`,
    ),
  action: z.enum(["READ", "UPSERT"]).describe("READ to look up relationships, UPSERT to create or update."),
  sourceLabel: z
    .string()
    .optional()
    .describe("Label of the source node (e.g. 'Character', 'Object', 'Location'). Required for UPSERT and most READ modes."),
  sourceMatch: z
    .record(z.string(), z.union([z.array(z.string()), z.string()]))
    .optional()
    .describe(
      "Key-value pairs to locate the source node (e.g. { name: 'Tavern' }). Arrays allowed for READ batch lookup.",
    ),
  targetLabel: z
    .string()
    .optional()
    .describe("Label of the target node. Required for UPSERT and most READ modes."),
  targetMatch: z
    .record(z.string(), z.union([z.array(z.string()), z.string()]))
    .optional()
    .describe(
      "Key-value pairs to locate the target node (e.g. { name: 'Town Square' }). Arrays allowed for READ batch lookup.",
    ),
  properties: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe(
      "Properties to set on the relationship (CREATE or UPDATE). No _-prefixed keys allowed since they are managed internally.",
    ),
});

export const manageRelationship = tool({
  title: TOOL_NAMES.MANAGE_RELATIONSHIP,
  description: `
## Brief
READ or UPSERT relationships between nodes. UPSERT creates-or-updates a single relationship
with auto-set temporal props and JSON partial merge. READ looks up relationships without
writing Cypher — find all outgoing/incoming rels for a node, or a specific relationship.

## Actions
- **UPSERT**: Create-or-update a single relationship. Both endpoint nodes must exist.
  Auto-sets \`created_at\`/\`valid_at\` for temporal relationships. JSON partial merge on update.
- **READ**: Look up relationships. Modes (detected from which fields are provided):
  - sourceMatch + targetMatch + relationshipType → specific relationship details
  - sourceMatch + relationshipType → all outgoing rels of that type from source
  - sourceMatch only → all outgoing rels from source, grouped by type
  - targetMatch + relationshipType → all incoming rels of that type to target
  - targetMatch only → all incoming rels to target, grouped by type
  - sourceMatch + targetMatch (no rel type) → all rels between the two nodes, grouped by type

It is not recommended to use this tool to directly **edit** ABOUT_CHARACTER/ABOUT_OBJECT/
ABOUT_LOCATION/ABOUT_SCENE/ABOUT_PLOT (managed by \`${TOOL_NAMES.EDIT_NOTE}\`),
STARTED_AT/COMPLETED_AT/BRANCHES_TO (managed by \`${TOOL_NAMES.EDIT_PLOT}\`).

## Upsert behavior
The relationship type must be registered by \`${TOOL_NAMES.MANAGE_SCHEMA}\`. You can get
existing relationships' schema by \`${TOOL_NAMES.GET_CONTEXT}\` with SCHEMA_DUMP.
- **New relationship**: \`created_at\` is auto-set to the active scene time and \`valid_at\`
  starts NULL for temporal relationships. Endpoint nodes must both exist.
- **Existing relationship**: properties are partially updated. Properties tagged "json"
  receive partial merge. \`created_at\` is preserved (immutable birth time).

## Temporal relationships
All state-changing relationships (LOCATED_AT, LOCATED_IN, CARRIES, HAS_DISPOSITION) are
temporal. Set \`valid_at\` to end a relationship instead of deleting — the relationship
history is preserved.

## Spatial/tactical properties
- LOCATED_AT.brief — spatial position detail (e.g. "hiding behind crates")
- LOCATED_IN.brief — access/containment detail (e.g. "accessed through a trapdoor behind the bar")
- CARRIES.brief — how an item is carried (e.g. "concealed in a boot")

Convention: use LOCATED_AT for characters/objects at a specific spot. Use LOCATED_IN for
sub-locations nested within a larger location (e.g., a basement inside a tavern).
`.trim(),
  inputSchema,
  execute: wrapSafe(async (args: z.infer<typeof inputSchema>) => {
    const db = Database.getExisting();
    const registry = getSchemaRegistry();

    // Validate relationship type (supports pipe-delimited source/target labels)
    const relDef = findRelType(registry, args.relationshipType, args.sourceLabel ?? "", args.targetLabel ?? "");
    if (!relDef) {
      const available = registry
        .getAllRelTypes()
        .filter((r) => !r.name.startsWith("_"))
        .map((r) => `${r.name} (${r.sourceLabel || "?"}→${r.targetLabel || "?"})`)
        .join(", ");
      return `ERROR: Relationship type "${args.relationshipType}" with endpoints (:${args.sourceLabel ?? "?"})→(:${args.targetLabel ?? "?"}) is not registered. Available: ${available}`;
    }
    if (args.relationshipType.startsWith("_")) {
      return `ERROR: Relationship type "${args.relationshipType}" (${relDef.sourceLabel}→${relDef.targetLabel}) is internal and cannot be written to.`;
    }

    // Block _-prefixed match keys on endpoints (all actions)
    if (args.sourceMatch) {
      for (const key of Object.keys(args.sourceMatch)) {
        if (key.startsWith("_")) return `ERROR: sourceMatch key "${key}" is internal.`;
      }
    }
    if (args.targetMatch) {
      for (const key of Object.keys(args.targetMatch)) {
        if (key.startsWith("_")) return `ERROR: targetMatch key "${key}" is internal.`;
      }
    }

    // ── READ ──
    if (args.action === "READ") {
      const hasSource = args.sourceMatch && Object.keys(args.sourceMatch).length > 0;
      const hasTarget = args.targetMatch && Object.keys(args.targetMatch).length > 0;

      if (!hasSource && !hasTarget) {
        return "ERROR: READ requires at least one of sourceMatch or targetMatch.";
      }
      if (hasSource && !args.sourceLabel) {
        return "ERROR: sourceLabel is required when sourceMatch is provided.";
      }
      if (hasTarget && !args.targetLabel) {
        return "ERROR: targetLabel is required when targetMatch is provided.";
      }

      const safeType = args.relationshipType ? args.relationshipType.replace(/[^A-Za-z0-9_]/g, "_") : null;

      const buildMatchClause = (
        label: string,
        match: Record<string, string | string[]>,
        alias: string,
      ): { clause: string; params: Record<string, unknown> } => {
        const params: Record<string, unknown> = {};
        const key = Object.keys(match)[0];
        const val = match[key];
        const values = Array.isArray(val) ? val : [val];
        params[`${alias}_vals`] = values;
        return {
          clause: `MATCH (${alias}:\`${label}\`) WHERE ${alias}.\`${key}\` IN $${alias}_vals`,
          params,
        };
      };

      const allParams: Record<string, unknown> = {};
      const clauses: string[] = [];
      const returns: string[] = [];

      if (hasSource) {
        const src = buildMatchClause(args.sourceLabel!, args.sourceMatch!, "src");
        clauses.push(src.clause);
        Object.assign(allParams, src.params);
      }
      if (hasTarget) {
        const tgt = buildMatchClause(args.targetLabel!, args.targetMatch!, "tgt");
        clauses.push(tgt.clause);
        Object.assign(allParams, tgt.params);
      }

      let relMatch: string;
      if (safeType) {
        relMatch = `[r:\`${safeType}\`]`;
      } else {
        relMatch = "[r]";
      }

      const srcRef = hasSource ? "(src)" : "()";
      const tgtRef = hasTarget ? "(tgt)" : "()";
      clauses.push(`MATCH ${srcRef}-${relMatch}->${tgtRef}`);

      // Filter temporal relationships to active only
      const temporalTypes = new Set(["LOCATED_AT", "LOCATED_IN", "CARRIES", "HAS_DISPOSITION"]);
      if (safeType && temporalTypes.has(args.relationshipType!)) {
        clauses.push("WHERE r.valid_at IS NULL");
      }

      returns.push("type(r) AS relType");
      returns.push("properties(r) AS props");
      if (hasTarget) returns.push("tgt.name AS tgtName, label(tgt) AS tgtLabel");
      if (hasSource) returns.push("src.name AS srcName, label(src) AS srcLabel");

      const query = `${clauses.join(" ")} RETURN ${returns.join(", ")} LIMIT 100`;
      const result = await db.graph.query(query, allParams);

      if (result.rows.length === 0) {
        const desc = safeType ? ` of type "${args.relationshipType}"` : "";
        return `No relationships${desc} found matching the criteria.`;
      }

      // Group by relationship type
      const byType = new Map<string, Array<Record<string, unknown>>>();
      for (const row of result.rows) {
        const rType = (row.relType as string) || "?";
        if (!byType.has(rType)) byType.set(rType, []);
        byType.get(rType)!.push(row as Record<string, unknown>);
      }

      const lines: string[] = [];
      for (const [rType, rows] of [...byType.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`### ${rType}`);
        for (const row of rows) {
          const src = row.srcName ? `(:${row.srcLabel} "${row.srcName}")` : "?";
          const tgt = row.tgtName ? `(:${row.tgtLabel} "${row.tgtName}")` : "?";
          const props = row.props as Record<string, unknown>;
          const visible = Object.entries(props || {})
            .filter(([k]) => !k.startsWith("_"))
            .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
            .join(", ");
          lines.push(`- ${src}-[:${rType}]->${tgt}${visible ? ` (${visible})` : ""}`);
        }
        lines.push("");
      }
      return lines.join("\n");
    }

    // ── UPSERT ──
    if (!args.sourceLabel) return "ERROR: sourceLabel is required for UPSERT.";
    if (!args.targetLabel) return "ERROR: targetLabel is required for UPSERT.";
    if (!args.sourceMatch || Object.keys(args.sourceMatch).length === 0) return "ERROR: sourceMatch is required for UPSERT.";
    if (!args.targetMatch || Object.keys(args.targetMatch).length === 0) return "ERROR: targetMatch is required for UPSERT.";

    // Reject array values
    for (const [k, v] of Object.entries(args.sourceMatch)) {
      if (Array.isArray(v)) return `ERROR: sourceMatch key "${k}" has an array value. Arrays are only allowed for READ.`;
    }
    for (const [k, v] of Object.entries(args.targetMatch)) {
      if (Array.isArray(v)) return `ERROR: targetMatch key "${k}" has an array value. Arrays are only allowed for READ.`;
    }

    if (args.action === "UPSERT") {
      const srcEntries = Object.entries(args.sourceMatch!);
      const tgtEntries = Object.entries(args.targetMatch!);

      // Extract first key-value pair for the graph layer
      const [srcKey, srcVal] = srcEntries[0];
      const [tgtKey, tgtVal] = tgtEntries[0];

      const safeType = args.relationshipType.replace(/[^A-Za-z0-9_]/g, "_");

      // Property validation helpers
      const schemaProps = new Set(
        relDef.properties.map((p) => p.name).filter((name) => !name.startsWith("_")),
      );
      const hasSchema = relDef.category === "GM_DEFINED" && relDef.properties.length > 0;

      function validateProps(props: Record<string, unknown>): string | null {
        const { internalKeys, unknownKeys } = extractInternalAndUnknownKeys(
          schemaProps,
          hasSchema,
          props,
        );
        const parts: string[] = [];
        if (internalKeys.length > 0)
          parts.push(
            `Property "${internalKeys.join("/")}" is internal (prefixed with '_') and cannot be set.`,
          );
        if (unknownKeys.length > 0)
          parts.push(
            `Unknown property "${unknownKeys.join("/")}" for relationship type "${args.relationshipType}". Allowed: ${[...schemaProps].join(", ")}`,
          );
        return parts.length > 0 ? parts.join(" ") : null;
      }

      function serializeValue(v: unknown): unknown {
        if (v === null || v === undefined) return v;
        if (typeof v === "object" && !Array.isArray(v)) return JSON.stringify(v);
        return v;
      }

      const wantsEmbedding = relDef.properties.some((p) => p.tags.includes("embedded"));

      // Check if relationship already exists
      const existing = await db.graph.query(
        `MATCH (src:\`${args.sourceLabel}\` {\`${srcKey}\`: $srcVal})-[r:\`${safeType}\`]->(tgt:\`${args.targetLabel}\` {\`${tgtKey}\`: $tgtVal}) RETURN r`,
        { srcVal, tgtVal },
      );
      if (existing.rows.length > 1) {
        return `ERROR: Multiple (${existing.rows.length}) matching relationships found. Use more specific match criteria.`;
      }

      const exists = existing.rows.length === 1;

      // ── UPDATE existing relationship ──
      if (exists) {
        if (!args.properties || Object.keys(args.properties).length === 0) {
          return "ERROR: Relationship already exists but no properties were provided to update.";
        }

        const propErr = validateProps(args.properties);
        if (propErr) return `ERROR: ${propErr}`;

        const existingRel = existing.rows[0]?.r as Record<string, unknown> | undefined;

        // JSON partial merge: read existing JSON props and shallow-merge incoming keys
        const jsonPropNames = new Set(
          relDef.properties.filter((p) => p.tags.includes("json")).map((p) => p.name),
        );
        const propertiesToSet: Record<string, unknown> = { ...args.properties };
        for (const key of Object.keys(args.properties)) {
          if (!jsonPropNames.has(key)) continue;
          const incoming = args.properties[key] as Record<string, unknown>;
          const existingRaw = existingRel?.[key];
          let parsed: Record<string, unknown> = {};
          if (typeof existingRaw === "string") {
            try {
              const p = JSON.parse(existingRaw);
              if (p && typeof p === "object" && !Array.isArray(p)) {
                parsed = p;
              }
            } catch {
              /* unparseable — overwrite */
            }
          } else if (existingRaw && typeof existingRaw === "object" && !Array.isArray(existingRaw)) {
            parsed = existingRaw as Record<string, unknown>;
          }
          propertiesToSet[key] = { ...parsed, ...incoming };
        }

        // Strip managed created_at — birth time is immutable
        if (isTemporalRel(relDef)) {
          delete propertiesToSet["created_at"];
        }
        // Auto-set _updated_at if the relationship type has it
        if (relDef.properties.some((p) => p.name === "_updated_at")) {
          propertiesToSet["_updated_at"] = new Date().toISOString();
        }

        const setParams: Record<string, unknown> = { srcVal, tgtVal };
        const setters: string[] = [];
        for (const [key, value] of Object.entries(propertiesToSet)) {
          const pName = `s_${key}`;
          setParams[pName] = serializeValue(value);
          setters.push(`r.\`${key}\` = $${pName}`);
        }

        // Recompute embedding if any embedded-tagged property changed.
        let relContentVec: number[] | null = null;
        let relNameText: string | null = null;
        if (wantsEmbedding) {
          const embeddedNames = new Set(
            relDef.properties.filter((p) => p.tags.includes("embedded")).map((p) => p.name),
          );
          if (Object.keys(args.properties).some((k) => embeddedNames.has(k))) {
            const merged = { ...existingRel, ...args.properties };
            const embedder = getEmbedder();
            relNameText = getRelEmbeddingNameText(args.relationshipType, merged, srcVal as string, tgtVal as string);
            const contentText = getRelEmbeddingContentText(relDef, merged);
            if (contentText) {
              try {
                relContentVec = await embedder.embed(contentText);
              } catch {
                /* ignore */
              }
            }
          }
        }

        await db.graph.query(
          `MATCH (src:\`${args.sourceLabel}\` {\`${srcKey}\`: $srcVal})-[r:\`${safeType}\`]->(tgt:\`${args.targetLabel}\` {\`${tgtKey}\`: $tgtVal}) SET ${setters.join(", ")}`,
          setParams,
        );

        if (relContentVec) {
          const pointId = `:rel:${args.relationshipType}:${srcVal}:${tgtVal}`;
          try {
            const merged = { ...existingRel, ...args.properties } as Record<string, unknown>;
            const contentText = getRelEmbeddingContentText(relDef, merged);
            const payload: Record<string, unknown> = {
              node_type: args.relationshipType,
              kind: "relationship",
              object_id: pointId,
              text: contentText || relNameText || "",
            };
            for (const [k, v] of Object.entries(merged)) {
              if (!k.startsWith("_")) payload[k] = v;
            }
            const contentVecFA = relContentVec
              ? new Float32Array(relContentVec)
              : new Float32Array(0);
            const sparse = relNameText
              ? encodeSparse(relNameText)
              : { indices: [] as number[], values: [] as number[] };
            db.vectors.upsert(
              pointId,
              args.relationshipType,
              "relationship",
              contentVecFA,
              sparse,
              payload,
            );
          } catch (err) {
            console.warn(
              `[manageRelationship] Vector upsert failed for "${args.relationshipType}":`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }

        return `Relationship (:${args.sourceLabel})-[:${args.relationshipType}]->(:${args.targetLabel}) updated properties: ${Object.keys(args.properties).join(", ")}.`;
      }

      // ── CREATE new relationship ──
      let createProps: Record<string, unknown> = {};
      if (args.properties) {
        const propErr = validateProps(args.properties);
        if (propErr) return `ERROR: ${propErr}`;
        const tempManaged = isTemporalRel(relDef)
          ? new Set(["created_at", "valid_at"])
          : new Set<string>();
        for (const [key, value] of Object.entries(args.properties)) {
          if (tempManaged.has(key)) continue;
          createProps[key] = serializeValue(value);
        }
      }

      // Auto-set temporal properties for state-changing relationships
      if (isTemporalRel(relDef)) {
        const activeScene = await db.scene.getActive();
        createProps["created_at"] = activeScene?.start_time ?? 0;
        createProps["valid_at"] = null;
      }
      // Auto-set _updated_at if the relationship type has it
      if (relDef.properties.some((p) => p.name === "_updated_at")) {
        createProps["_updated_at"] = new Date().toISOString();
      }

      // TODO: auto-expire old relationship of same type+source when a new one is created
      // (e.g., moving character to new location should expire old LOCATED_AT)

      // Compute embeddings if the relationship type supports it.
      let contentVec: number[] | null = null;
      let nameText: string | null = null;

      if (wantsEmbedding) {
        nameText = getRelEmbeddingNameText(args.relationshipType, createProps, srcVal as string, tgtVal as string);
        const contentText = getRelEmbeddingContentText(relDef, createProps);

        const embedder = getEmbedder();
        contentVec = contentText ? await embedder.embed(contentText).catch(() => null) : null;
      }

      await db.graph.mergeRelationship(
        args.sourceLabel!,
        srcKey,
        srcVal,
        args.targetLabel!,
        tgtKey,
        tgtVal,
        safeType,
        Object.keys(createProps).length > 0 ? createProps : undefined,
      );

      // Verify the relationship was created (endpoints must both exist for MERGE to succeed)
      const checkResult = await db.graph.query(
        `MATCH (src:\`${args.sourceLabel}\` {\`${srcKey}\`: $srcVal})-[r:\`${safeType}\`]->(tgt:\`${args.targetLabel}\` {\`${tgtKey}\`: $tgtVal}) RETURN count(r) AS cnt`,
        { srcVal, tgtVal },
      );
      if ((checkResult.rows[0]?.cnt as number) === 0) {
        return (
          `ERROR: Could not create relationship. One or both endpoint nodes may not exist — ` +
          `source: (:\`${args.sourceLabel}\` ${JSON.stringify(args.sourceMatch)}), ` +
          `target: (:\`${args.targetLabel}\` ${JSON.stringify(args.targetMatch)}).`
        );
      }

      if (contentVec) {
        const pointId = `:rel:${args.relationshipType}:${srcVal}:${tgtVal}`;
        try {
          const contentText = getRelEmbeddingContentText(relDef, createProps);
          const payload: Record<string, unknown> = {
            node_type: args.relationshipType,
            kind: "relationship",
            object_id: pointId,
            text: contentText || nameText || "",
          };
          for (const [k, v] of Object.entries(createProps)) {
            if (!k.startsWith("_")) payload[k] = v;
          }
          const contentVecFA = contentVec ? new Float32Array(contentVec) : new Float32Array(0);
          const sparse = nameText
            ? encodeSparse(nameText)
            : { indices: [] as number[], values: [] as number[] };
          db.vectors.upsert(
            pointId,
            args.relationshipType,
            "relationship",
            contentVecFA,
            sparse,
            payload,
          );
        } catch (err) {
          console.warn(
            `[manageRelationship] Vector upsert failed for "${args.relationshipType}":`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      return `Relationship (:${args.sourceLabel})-[:${args.relationshipType}]->(:${args.targetLabel}) created successfully.`;
    }

    return `ERROR: Unknown action "${args.action}". Use READ or UPSERT.`;
  }, TOOL_NAMES.MANAGE_RELATIONSHIP),
});
