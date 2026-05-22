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
import { getMemoryClient, MemoryClient } from "@/server/memory/client";
import { RelationshipManager } from "@/server/relationshipManager";
import type { RelationshipPropertyDef } from "@/server/relationshipManager";
import { getEmbedder } from "@/server/memory/embedder";
import { getQdrantClient } from "@/server/memory/qdrant";
import { encodeSparse } from "@/server/memory/sparseEncoder";
import { extractInternalAndUnknownKeys, wrapSafe } from "@/server/llm/tools/shared";
import { TOOL_NAMES } from "@/shared/constants";

const REL_ACTIONS = ["CREATE", "UPDATE", "DELETE"] as const;

const inputSchema = z.object({
  action: z.enum(REL_ACTIONS).default("CREATE").describe("Action to perform."),
  relationshipType: z
    .string()
    .describe(
      "The relationship type (e.g. 'LOCATED_AT', 'ALLIED_WITH', 'HOSTILE_TOWARDS', or GM-defined). Must be registered in the world schema and writable. Discover available types via getContext SCHEMA_DUMP.",
    ),
  sourceLabel: z
    .string()
    .describe("Label of the source node (e.g. 'Entity', 'Character', 'Location')."),
  sourceMatch: z
    .record(z.string(), z.string())
    .describe("Key-value pairs to locate the source node (e.g. { name: 'Tavern' } for an Entity)."),
  targetLabel: z.string().describe("Label of the target node."),
  targetMatch: z
    .record(z.string(), z.string())
    .describe("Key-value pairs to locate the target node (e.g. { name: 'Town Square' })."),
  properties: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe(
      "Properties to set on the relationship (CREATE or UPDATE). _created_at is auto-managed. No _-prefixed keys allowed.",
    ),
});

export const editRelationship = tool({
  title: TOOL_NAMES.EDIT_RELATIONSHIP,
  description: `
CREATE, UPDATE, or DELETE a relationship between two nodes in the world archive.

CREATE — Link two existing nodes. The relationship type must be registered (PREDEFINED or
GM_DEFINED). Uses MERGE semantics — safe to call twice. Both endpoint nodes must already
exist. Use for: moving entities (delete old LOCATED_AT, create new), transferring items
(delete old CARRIES, create new), setting alliances/hostilities, linking notes to entities
or messages.

UPDATE — Change properties on an existing relationship. Only include properties you want
to change. Properties tagged "json" receive partial merge (like editNode UPDATE).

DELETE — Remove a relationship. Use when entities move, items transfer, or relationships change.

Relationship properties for spatial/tactical context:
- LOCATED_AT.brief — spatial position detail (e.g. "hiding behind crates")
- LOCATED_IN.brief — access/containment detail (e.g. "accessed through a trapdoor behind the bar")
- CARRIES.brief — how an item is carried (e.g. "concealed in a boot")
- ALLIED_WITH.brief / HOSTILE_TOWARDS.brief — motive or reason

Convention: use LOCATED_AT for characters/objects at a specific spot. Use LOCATED_IN for
sub-locations nested within a larger location (e.g., a basement inside a tavern).
`.trim(),
  inputSchema,
  execute: wrapSafe(async (args: z.infer<typeof inputSchema>) => {
    const client = getMemoryClient();
    const relManager = RelationshipManager.getCachedInstance();

    // Validate relationship type
    const relDef = relManager.get(args.relationshipType, args.sourceLabel, args.targetLabel);
    if (!relDef) {
      const available = relManager
        .getAll()
        .filter((r) => r.type !== "INTERNAL")
        .map((r) => `${r.name} (${r.sourceLabel || "?"}→${r.targetLabel || "?"})`)
        .join(", ");
      return `ERROR: Relationship type "${args.relationshipType}" with endpoints (:${args.sourceLabel})→(:${args.targetLabel}) is not registered. Available: ${available}`;
    }
    if (!relManager.isAllowedForWrite(args.relationshipType, args.sourceLabel, args.targetLabel)) {
      return `ERROR: Relationship type "${args.relationshipType}" (${relDef.sourceLabel}→${relDef.targetLabel}) is ${relDef.type} and cannot be written to.`;
    }

    const srcEntries = Object.entries(args.sourceMatch);
    const tgtEntries = Object.entries(args.targetMatch);
    if (srcEntries.length === 0) return "ERROR: sourceMatch must not be empty.";
    if (tgtEntries.length === 0) return "ERROR: targetMatch must not be empty.";

    // Extract first key-value pair for the neo4j layer
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
    const hasSchema = relDef.type === "GM_DEFINED" && relDef.properties.length > 0;

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

      // Compute embeddings if the relationship type supports it.
      let nameVec: number[] | null = null;
      let contentVec: number[] | null = null;
      let nameText: string | null = null;

      if (wantsEmbedding) {
        const relManager = RelationshipManager.getCachedInstance();
        nameText = relManager.getEmbeddingNameText(
          args.relationshipType,
          createProps,
          srcVal,
          tgtVal,
        );
        const contentText = relManager.getEmbeddingContentText(args.relationshipType, createProps);

        const tasks: Promise<number[] | null>[] = [];
        tasks.push(
          nameText
            ? getEmbedder()
                .embed(nameText)
                .catch(() => null)
            : Promise.resolve(null),
        );
        tasks.push(
          contentText
            ? getEmbedder()
                .embed(contentText)
                .catch(() => null)
            : Promise.resolve(null),
        );
        const [nv, cv] = await Promise.all(tasks);
        nameVec = nv;
        contentVec = cv;
      }

      const rows = await client.neo4j.mergeRelationship(
        args.sourceLabel,
        srcKey,
        srcVal,
        args.targetLabel,
        tgtKey,
        tgtVal,
        safeType,
        { onCreateProps: createProps },
      );

      if (rows.length === 0) {
        return (
          `ERROR: Could not create relationship. One or both endpoint nodes may not exist — ` +
          `source: (:\`${args.sourceLabel}\` ${JSON.stringify(args.sourceMatch)}), ` +
          `target: (:\`${args.targetLabel}\` ${JSON.stringify(args.targetMatch)}).`
        );
      }

      if (nameVec || contentVec) {
        const pointId = `:rel:${args.relationshipType}:${srcVal}:${tgtVal}`;
        try {
          const contentText = RelationshipManager.getCachedInstance().getEmbeddingContentText(
            args.relationshipType,
            createProps,
          );
          const payload: Record<string, unknown> = {
            node_type: args.relationshipType,
            kind: "relationship",
            object_id: pointId,
            text: contentText || nameText || "",
          };
          for (const [k, v] of Object.entries(createProps)) {
            if (!k.startsWith("_")) payload[k] = v;
          }
          await getQdrantClient().upsert(
            pointId,
            {
              nameVec: nameVec ?? undefined,
              contentVec: contentVec ?? undefined,
              sparseVec: nameText ? encodeSparse(nameText) : undefined,
            },
            payload,
          );
        } catch (err) {
          console.warn(
            `[editRelationship] Qdrant upsert failed for "${args.relationshipType}":`,
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
      const existing = await client.neo4j.executeRead(
        `MATCH (src:\`${args.sourceLabel}\` {${srcKey}: $srcVal})-[r:${safeType}]->(tgt:\`${args.targetLabel}\` {${tgtKey}: $tgtVal}) RETURN r`,
        matchParams,
      );
      if (existing.length === 0) {
        return `ERROR: Relationship not found — (:\`${args.sourceLabel}\` ${JSON.stringify(args.sourceMatch)})-[:${args.relationshipType}]->(:\`${args.targetLabel}\` ${JSON.stringify(args.targetMatch)}).`;
      }
      if (existing.length > 1) {
        return `ERROR: Multiple (${existing.length}) matching relationships found. Use more specific match criteria.`;
      }

      const existingRel = existing[0]?.r as Record<string, unknown> | undefined;

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
          const relManager = RelationshipManager.getCachedInstance();
          if (nameChanged) {
            relNameText = relManager.getEmbeddingNameText(
              args.relationshipType,
              merged,
              srcVal,
              tgtVal,
            );
            if (relNameText) {
              try {
                relNameVec = await getEmbedder().embed(relNameText);
              } catch {
                /* ignore */
              }
            }
          }
          if (contentChanged) {
            const contentText = relManager.getEmbeddingContentText(args.relationshipType, merged);
            if (contentText) {
              try {
                relContentVec = await getEmbedder().embed(contentText);
              } catch {
                /* ignore */
              }
            }
          }
        }
      }

      await client.neo4j.executeWrite(
        `MATCH (src:\`${args.sourceLabel}\` {${srcKey}: $srcVal})-[r:${safeType}]->(tgt:\`${args.targetLabel}\` {${tgtKey}: $tgtVal}) SET ${setters.join(", ")}`,
        setParams,
      );

      if (relNameVec || relContentVec) {
        const pointId = `:rel:${args.relationshipType}:${srcVal}:${tgtVal}`;
        try {
          const merged = { ...existingRel, ...args.properties } as Record<string, unknown>;
          const contentText = RelationshipManager.getCachedInstance().getEmbeddingContentText(
            args.relationshipType,
            merged,
          );
          const payload: Record<string, unknown> = {
            node_type: args.relationshipType,
            kind: "relationship",
            object_id: pointId,
            text: contentText || relNameText || "",
          };
          for (const [k, v] of Object.entries(merged)) {
            if (!k.startsWith("_")) payload[k] = v;
          }
          await getQdrantClient().upsert(
            pointId,
            {
              nameVec: relNameVec ?? undefined,
              contentVec: relContentVec ?? undefined,
              sparseVec: relNameText ? encodeSparse(relNameText) : undefined,
            },
            payload,
          );
        } catch (err) {
          console.warn(
            `[editRelationship] Qdrant upsert failed for "${args.relationshipType}":`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      return `Relationship (:\`${args.sourceLabel}\`)-[:${args.relationshipType}]->(:\`${args.targetLabel}\`) updated properties: ${Object.keys(args.properties).join(", ")}.`;
    }

    // ── DELETE ──
    // Delete Qdrant point first, then Neo4j relationship.
    if (wantsEmbedding) {
      const pointId = `:rel:${args.relationshipType}:${srcVal}:${tgtVal}`;
      try {
        await getQdrantClient().deletePoint(pointId);
      } catch (err) {
        console.warn(
          `[editRelationship] Qdrant delete failed for "${args.relationshipType}":`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const deleted = await client.neo4j.deleteRelationship(
      args.sourceLabel,
      srcKey,
      srcVal,
      args.targetLabel,
      tgtKey,
      tgtVal,
      safeType,
    );

    return deleted
      ? `Relationship (:\`${args.sourceLabel}\`)-[:${args.relationshipType}]->(:\`${args.targetLabel}\`) deleted.`
      : `ERROR: Relationship not found — (:\`${args.sourceLabel}\` ${JSON.stringify(args.sourceMatch)})-[:${args.relationshipType}]->(:\`${args.targetLabel}\` ${JSON.stringify(args.targetMatch)}).`;
  }, TOOL_NAMES.EDIT_RELATIONSHIP),
});
