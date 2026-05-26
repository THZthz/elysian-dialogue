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
import { SchemaRegistry, type RelTypeDef } from "@/server/db/schema";
import { extractInternalAndUnknownKeys, wrapSafe } from "@/server/llm/tools/shared";
import { getEmbedder } from "@/server/search/embedder";
import { encodeSparse } from "@/server/search/sparseEncoder";
import { TOOL_NAMES } from "@/shared/constants";

const REL_ACTIONS = ["CREATE", "UPDATE"] as const;

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

function getRelEmbeddingContentText(def: RelTypeDef, props: Record<string, unknown>): string {
  return def.properties
    .filter((p) => p.tags.includes("embedded_content"))
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
  action: z.enum(REL_ACTIONS).default("CREATE").describe("Action to perform."),
  relationshipType: z
    .string()
    .describe(
      `The relationship type (e.g. 'LOCATED_AT', 'CARRIES', 'LOCATED_IN', or GM-defined). Must be registered in the world schema and writable. Use Disposition nodes for character attitudes instead of relationships. Discover available types via \`${TOOL_NAMES.GET_CONTEXT}\` SCHEMA_DUMP.`,
    ),
  sourceLabel: z
    .string()
    .describe("Label of the source node (e.g. 'Character', 'Object', 'Location')."),
  sourceMatch: z
    .record(z.string(), z.string())
    .describe(
      "Key-value pairs to locate the source node (e.g. { name: 'Tavern' } for a Location).",
    ),
  targetLabel: z.string().describe("Label of the target node."),
  targetMatch: z
    .record(z.string(), z.string())
    .describe("Key-value pairs to locate the target node (e.g. { name: 'Town Square' })."),
  properties: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe(
      "Properties to set on the relationship (CREATE or UPDATE). No _-prefixed keys allowed since they are managed internally.",
    ),
});

export const editRelationship = tool({
  title: TOOL_NAMES.EDIT_RELATIONSHIP,
  description: `
## Brief
CREATE, UPDATE, or DELETE a relationship between two nodes in the world archive. It is not recommended
to use this tool to directly edit ABOUT_ENTITY, ABOUT_MESSAGE, ABOUT_PLOT, STARTED_AT, ACTIVE_AT,
COMPLETED_AT or BRANCHES_TO.

## CREATE
Link two existing nodes. The relationship type must be registered by \`${TOOL_NAMES.MANAGE_SCHEMA}\`.
Uses MERGE semantics — safe to call twice. Both endpoint nodes must already exist.

## UPDATE
Partially change properties on an existing relationship. Only include properties you want
to change. Properties tagged "json" receive partial merge (like editNode UPDATE).

## Others
All state-changing relationships (LOCATED_AT, LOCATED_IN, CARRIES, HAS_DISPOSITION) are
temporal — created_at and valid_at are managed automatically. Use UPDATE to set valid_at
to end a relationship instead of deleting.

## Others
Relationship properties for spatial/tactical context:
- LOCATED_AT.brief — spatial position detail (e.g. "hiding behind crates")
- LOCATED_IN.brief — access/containment detail (e.g. "accessed through a trapdoor behind the bar")
- CARRIES.brief — how an item is carried (e.g. "concealed in a boot")
- CARRIES.brief — how/where an item is carried

Convention: use LOCATED_AT for characters/objects at a specific spot. Use LOCATED_IN for
sub-locations nested within a larger location (e.g., a basement inside a tavern).
`.trim(),
  inputSchema,
  execute: wrapSafe(async (args: z.infer<typeof inputSchema>) => {
    const db = Database.getExisting();
    const schema = SchemaRegistry.getInstance();

    // Validate relationship type (supports pipe-delimited source/target labels)
    const relDef = findRelType(schema, args.relationshipType, args.sourceLabel, args.targetLabel);
    if (!relDef) {
      const available = schema
        .getAllRelTypes()
        .filter((r) => !r.name.startsWith("_"))
        .map((r) => `${r.name} (${r.sourceLabel || "?"}→${r.targetLabel || "?"})`)
        .join(", ");
      return `ERROR: Relationship type "${args.relationshipType}" with endpoints (:${args.sourceLabel})→(:${args.targetLabel}) is not registered. Available: ${available}`;
    }
    if (args.relationshipType.startsWith("_")) {
      return `ERROR: Relationship type "${args.relationshipType}" (${relDef.sourceLabel}→${relDef.targetLabel}) is internal and cannot be written to.`;
    }

    const srcEntries = Object.entries(args.sourceMatch);
    const tgtEntries = Object.entries(args.targetMatch);
    if (srcEntries.length === 0) return "ERROR: sourceMatch must not be empty.";
    if (tgtEntries.length === 0) return "ERROR: targetMatch must not be empty.";

    // Extract first key-value pair for the graph layer
    const [srcKey, srcVal] = srcEntries[0];
    const [tgtKey, tgtVal] = tgtEntries[0];

    const safeType = args.relationshipType.replace(/[^A-Za-z0-9_]/g, "_");

    // Block _-prefixed match keys on endpoints (all actions)
    for (const key of Object.keys(args.sourceMatch)) {
      if (key.startsWith("_")) return `ERROR: sourceMatch key "${key}" is internal.`;
    }
    for (const key of Object.keys(args.targetMatch)) {
      if (key.startsWith("_")) return `ERROR: targetMatch key "${key}" is internal.`;
    }

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

    const wantsNameEmbedding = relDef.properties.some((p) => p.tags.includes("embedded_name"));
    const wantsContentEmbedding = relDef.properties.some((p) =>
      p.tags.includes("embedded_content"),
    );
    const wantsEmbedding = wantsNameEmbedding || wantsContentEmbedding;

    // ── CREATE ──
    if (args.action === "CREATE") {
      let createProps: Record<string, unknown> = {};
      if (args.properties) {
        const propErr = validateProps(args.properties);
        if (propErr) return `ERROR: ${propErr}`;
        for (const [key, value] of Object.entries(args.properties)) {
          createProps[key] = serializeValue(value);
        }
      }

      // TODO: auto-expire old relationship of same type+source when a new one is created
      // (e.g., moving character to new location should expire old LOCATED_AT)

      // Compute embeddings if the relationship type supports it.
      let nameVec: number[] | null = null;
      let contentVec: number[] | null = null;
      let nameText: string | null = null;

      if (wantsEmbedding) {
        nameText = getRelEmbeddingNameText(args.relationshipType, createProps, srcVal, tgtVal);
        const contentText = getRelEmbeddingContentText(relDef, createProps);

        const embedder = getEmbedder();
        const tasks: Promise<number[] | null>[] = [];
        tasks.push(nameText ? embedder.embed(nameText).catch(() => null) : Promise.resolve(null));
        tasks.push(
          contentText ? embedder.embed(contentText).catch(() => null) : Promise.resolve(null),
        );
        const [nv, cv] = await Promise.all(tasks);
        nameVec = nv;
        contentVec = cv;
      }

      await db.graph.mergeRelationship(
        args.sourceLabel,
        srcKey,
        srcVal,
        args.targetLabel,
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

      if (nameVec || contentVec) {
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
          const nameVecFA = nameVec ? new Float32Array(nameVec) : new Float32Array(0);
          const contentVecFA = contentVec ? new Float32Array(contentVec) : new Float32Array(0);
          const sparse = nameText
            ? encodeSparse(nameText)
            : { indices: [] as number[], values: [] as number[] };
          db.vectors.upsert(
            pointId,
            args.relationshipType,
            "relationship",
            nameVecFA,
            contentVecFA,
            sparse,
            payload,
          );
        } catch (err) {
          console.warn(
            `[editRelationship] Vector upsert failed for "${args.relationshipType}":`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      return `Relationship (:\`${args.sourceLabel}\`)-[:${args.relationshipType}]->(:\`${args.targetLabel}\`) created successfully.`;
    }

    // ── UPDATE ──
    if (args.action === "UPDATE") {
      if (!args.properties || Object.keys(args.properties).length === 0) {
        return "ERROR: No properties to update.";
      }

      const propErr = validateProps(args.properties);
      if (propErr) return `ERROR: ${propErr}`;

      // Find the existing relationship
      const matchParams: Record<string, unknown> = {
        srcVal: srcVal,
        tgtVal: tgtVal,
      };
      const existing = await db.graph.query(
        `MATCH (src:\`${args.sourceLabel}\` {${srcKey}: $srcVal})-[r:${safeType}]->(tgt:\`${args.targetLabel}\` {${tgtKey}: $tgtVal}) RETURN r`,
        matchParams,
      );
      if (existing.rows.length === 0) {
        return `ERROR: Relationship not found — (:\`${args.sourceLabel}\` ${JSON.stringify(args.sourceMatch)})-[:${args.relationshipType}]->(:\`${args.targetLabel}\` ${JSON.stringify(args.targetMatch)}).`;
      }
      if (existing.rows.length > 1) {
        return `ERROR: Multiple (${existing.rows.length}) matching relationships found. Use more specific match criteria.`;
      }

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

      const setParams: Record<string, unknown> = { srcVal: srcVal, tgtVal: tgtVal };
      const setters: string[] = [];
      for (const [key, value] of Object.entries(propertiesToSet)) {
        const pName = `s_${key}`;
        setParams[pName] = serializeValue(value);
        setters.push(`r.\`${key}\` = $${pName}`);
      }

      // Recompute embedding if any embedded-tagged property changed.
      let relNameVec: number[] | null = null;
      let relContentVec: number[] | null = null;
      let relNameText: string | null = null;
      if (wantsEmbedding) {
        const nameEmbeddedNames = new Set(
          relDef.properties.filter((p) => p.tags.includes("embedded_name")).map((p) => p.name),
        );
        const contentEmbeddedNames = new Set(
          relDef.properties.filter((p) => p.tags.includes("embedded_content")).map((p) => p.name),
        );
        const nameChanged = Object.keys(args.properties).some((k) => nameEmbeddedNames.has(k));
        const contentChanged = Object.keys(args.properties).some((k) =>
          contentEmbeddedNames.has(k),
        );
        if (nameChanged || contentChanged) {
          const merged = { ...existingRel, ...args.properties };
          const embedder = getEmbedder();
          if (nameChanged) {
            relNameText = getRelEmbeddingNameText(args.relationshipType, merged, srcVal, tgtVal);
            if (relNameText) {
              try {
                relNameVec = await embedder.embed(relNameText);
              } catch {
                /* ignore */
              }
            }
          }
          if (contentChanged) {
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
      }

      await db.graph.query(
        `MATCH (src:\`${args.sourceLabel}\` {${srcKey}: $srcVal})-[r:${safeType}]->(tgt:\`${args.targetLabel}\` {${tgtKey}: $tgtVal}) SET ${setters.join(", ")}`,
        setParams,
      );

      if (relNameVec || relContentVec) {
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
          const nameVecFA = relNameVec ? new Float32Array(relNameVec) : new Float32Array(0);
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
            nameVecFA,
            contentVecFA,
            sparse,
            payload,
          );
        } catch (err) {
          console.warn(
            `[editRelationship] Vector upsert failed for "${args.relationshipType}":`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      return `Relationship (:\`${args.sourceLabel}\`)-[:${args.relationshipType}]->(:\`${args.targetLabel}\`) updated properties: ${Object.keys(args.properties).join(", ")}.`;
    }
  }, TOOL_NAMES.EDIT_RELATIONSHIP),
});
