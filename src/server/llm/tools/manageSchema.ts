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
import { wrapSafe } from "@/server/llm/tools/shared";
import { TOOL_NAMES } from "@/shared/constants";

const NODE_PROPERTY_TAGS = [
  "string",
  "number",
  "number[]",
  "json",
  "embedded_name",
  "embedded_content",
  "unique",
  "index",
  "composite_unique_1",
  "composite_unique_2",
  "composite_unique_3",
  "composite_index_1",
  "composite_index_2",
  "composite_index_3",
] as const;

const RELATIONSHIP_PROPERTY_TAGS = [
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

export const manageSchema = tool({
  title: TOOL_NAMES.MANAGE_SCHEMA,
  description: `
## Brief
Register or unregister node types and relationship types in the world schema.

Must be called BEFORE creating a node with a new label or a relationship with a new type.
PREDEFINED types (Character, Object, Location, Plot, Note, Disposition, etc.) are already registered —
you don't need to re-register them.

Node types — provide name (PascalCase) + optional property schema with tags.

Relationship types — provide name (UPPER_SNAKE) + required sourceLabel/targetLabel to
constrain which node types can sit at each endpoint. Tags: same as node tags except
'unique' and 'composite_unique_X' (not supported for relationship properties).

Only GM_DEFINED types can be unregistered. PREDEFINED and INTERNAL types are permanent.

## Tags dictionary
- \`string\`: normal string
- \`number\`: normal number
- \`number[]\`: list of numbers
- \`json\`: Saved as a JSON string. But when used in tools supporting partial update, will automatically unfold the JSON string property to avoid the whole string being overwritten
- \`embedded_name\`: used for identity/exact-match vector (name_vec) when the property is created or updated
- \`embedded_content\`: used for semantic/meaning vector (content_vec) when the property is created or updated
- \`unique\`: will create a unique constraint on this property, not available for relationship
- \`composite_unique_X\`: will create a composite unique constraint for all specified properties, not available for relationship
- \`index\`: will create a regular index on this property
- \`composite_index_X\`: will create composite index on all specified properties
`.trim(),
  inputSchema: z.object({
    target: z
      .enum(["NODE", "RELATIONSHIP"])
      .describe("Whether to register a node type (label) or a relationship type."),
    action: z
      .enum(["REGISTER", "UNREGISTER"])
      .describe(
        "Register a new type or remove an existing one. Only GM-defined types can be unregistered.",
      ),
    name: z
      .string()
      .describe(
        "The name of the node label (e.g. 'Artifact') or relationship type (e.g. 'CONNECTED_TO'). Use PascalCase for node labels, UPPER_SNAKE for relationships.",
      ),
    description: z
      .string()
      .nullable()
      .optional()
      .describe(
        "For register: describes what the node type represents or what the relationship type means. For unregister: not needed.",
      ),
    properties: z
      .array(
        z.object({
          name: z.string().describe("Property name (snake_case, e.g. 'power_level')."),
          description: z.string().describe("What this property stores."),
          tags: z
            .array(z.enum(NODE_PROPERTY_TAGS))
            .describe(
              "Comma-separated tags describing the property. " +
                "For nodes: 'string', 'number', 'number[]', 'json', 'embedded_name', 'embedded_content', 'unique', 'index', 'composite_unique_1', 'composite_unique_2', 'composite_unique_3', 'composite_index_1', 'composite_index_2', 'composite_index_3'. " +
                "For relationships: same tags except 'unique' and 'composite_unique_X' (not supported for relationship properties).",
            ),
        }),
      )
      .nullable()
      .optional()
      .describe(
        "For action=register: the property schema for the new type (nodes or relationships).",
      ),
    sourceLabel: z
      .string()
      .optional()
      .describe(
        "The node label that sits at the source (tail) of this relationship. E.g. 'Character'. Required for relationship registration.",
      ),
    targetLabel: z
      .string()
      .optional()
      .describe(
        "The node label that sits at the target (head) of this relationship. E.g. 'Location'. Required for relationship registration.",
      ),
  }),
  execute: wrapSafe(async (args) => {
    const db = Database.getExisting();

    if (args.action === "REGISTER") {
      if (args.target === "NODE") {
        const existing = db.schema.getNodeType(args.name);
        if (existing && existing.category !== "GM_DEFINED") {
          return `ERROR: Cannot register "${args.name}": it is a ${existing.category} type and cannot be modified.`;
        }

        const inputProps = (args.properties ?? []).filter((p) => !!p?.name);
        // Preserve existing properties if none provided on update
        const props = existing && inputProps.length === 0 ? existing.properties : inputProps;

        db.schema.registerNode({
          name: args.name,
          category: "GM_DEFINED",
          description: args.description ?? existing?.description ?? "No description provided.",
          properties: props,
        });

        const ddl = db.schema.generateNodeDDL(args.name);
        if (ddl) await db.graph.query(ddl);
        await db.schema.persistNodeType(db.graph, args.name);

        const propSummary =
          props.length > 0
            ? ` with ${props.length} property(s): ${props.map((p) => p.name).join(", ")}`
            : "";
        return `Registered node type "${args.name}"${propSummary}. It is now available for use via ${TOOL_NAMES.QUERY_WORLD} (WRITE action).`;
      }

      if (args.target === "RELATIONSHIP") {
        const srcLabel = args.sourceLabel;
        const tgtLabel = args.targetLabel;
        if (!srcLabel || !tgtLabel) {
          return `ERROR: sourceLabel and targetLabel are required for relationship registration.`;
        }

        const existing = db.schema.getRelType(args.name, srcLabel, tgtLabel);
        if (existing && existing.category !== "GM_DEFINED") {
          return `Cannot register "${args.name}" (${srcLabel}→${tgtLabel}): it is a ${existing.category} type and cannot be modified.`;
        }

        const inputProps = (args.properties ?? [])
          .filter((p) => !!p?.name)
          .map((p) => ({
            name: p.name,
            description: p.description,
            tags: p.tags.filter((t) =>
              (RELATIONSHIP_PROPERTY_TAGS as readonly string[]).includes(t),
            ),
          }));
        // Preserve existing properties if none provided on update
        const relProps = existing && inputProps.length === 0 ? existing.properties : inputProps;

        db.schema.registerRel({
          name: args.name,
          sourceLabel: srcLabel,
          targetLabel: tgtLabel,
          category: "GM_DEFINED",
          description: args.description ?? existing?.description ?? "No description provided.",
          properties: relProps,
        });

        const relDDL = db.schema.generateRelDDL(args.name, srcLabel, tgtLabel);
        if (relDDL) await db.graph.query(relDDL);
        await db.schema.persistRelType(db.graph, args.name, srcLabel, tgtLabel);

        const endpoints = `(${srcLabel})→(${tgtLabel})`;
        const propSummary =
          relProps.length > 0
            ? ` with ${relProps.length} property(s): ${relProps.map((p) => p.name).join(", ")}`
            : "";
        return `Registered relationship type "${args.name}"${endpoints}${propSummary}. It is now available for use via ${TOOL_NAMES.QUERY_WORLD} (WRITE action).`;
      }
    }

    if (args.action === "UNREGISTER") {
      if (args.target === "NODE") {
        const existing = db.schema.getNodeType(args.name);
        if (!existing || existing.category !== "GM_DEFINED") {
          return `Cannot unregister "${args.name}": it is not a GM_DEFINED type.`;
        }
        await db.graph.query("MATCH (nt:NodeType {name: $name}) DETACH DELETE nt", {
          name: args.name,
        });
        return `Unregistered node type "${args.name}".`;
      }

      if (args.target === "RELATIONSHIP") {
        const srcLabel = args.sourceLabel;
        const tgtLabel = args.targetLabel;
        if (!srcLabel || !tgtLabel) {
          return `ERROR: sourceLabel and targetLabel are required for relationship unregistration.`;
        }
        const existing = db.schema.getRelType(args.name, srcLabel, tgtLabel);
        if (!existing || existing.category !== "GM_DEFINED") {
          return `Cannot unregister "${args.name}" (${srcLabel}→${tgtLabel}): it is not a GM_DEFINED type.`;
        }
        await db.graph.query(
          "MATCH (rt:RelationshipType {name: $name, source_label: $src, target_label: $tgt}) DETACH DELETE rt",
          { name: args.name, src: srcLabel, tgt: tgtLabel },
        );
        return `Unregistered relationship type "${args.name}" (${srcLabel}→${tgtLabel}).`;
      }
    }

    return "Invalid action. Use 'register' or 'unregister'.";
  }, TOOL_NAMES.MANAGE_SCHEMA),
});
