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
import { TOOL_NAMES } from "@/shared/constants";
import { wrapSafe } from "@/server/llm/tools/shared";
import {
  buildSceneContext,
  buildCharactersBrief,
  buildLocationsBrief,
  buildObjectsBrief,
  buildPlotsBrief,
  buildRelationshipDump,
} from "@/server/llm/sceneContext";
import { Database } from "@/server/db";
import { SchemaRegistry } from "@/server/db/schema";

const CONTEXT_TYPES = [
  "SCENE_CONTEXT",
  "CHARACTERS_BRIEF",
  "LOCATIONS_BRIEF",
  "OBJECTS_BRIEF",
  "PLOTS_BRIEF",
  "SCHEMA_DUMP",
  "RELATIONSHIP_DUMP",
] as const;

type ContextType = (typeof CONTEXT_TYPES)[number];

async function buildSchemaDump(): Promise<string> {
  const db = Database.getExisting();
  const schema = SchemaRegistry.getInstance();
  const internalNames = new Set(schema.getInternalTypeNames());

  // ── Node types from SchemaRegistry (in-memory) ──
  const nodeTypes = schema
    .getAllNodeTypes()
    .filter((n) => !internalNames.has(n.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── Relationship types from SchemaRegistry (in-memory) ──
  const relTypes = schema
    .getAllRelTypes()
    .filter((r) => !r.name.startsWith("_"))
    .sort((a, b) => {
      const srcCmp = (a.sourceLabel || "").localeCompare(b.sourceLabel || "");
      if (srcCmp !== 0) return srcCmp;
      const tgtCmp = (a.targetLabel || "").localeCompare(b.targetLabel || "");
      if (tgtCmp !== 0) return tgtCmp;
      return a.name.localeCompare(b.name);
    });

  // ── Pre-fetch counts per table (no UNWIND — LadybugDB compatible) ──
  const counts: Record<string, number> = {};
  for (const nt of nodeTypes) {
    try {
      const r = await db.graph.query(`MATCH (n:\`${nt.name}\`) RETURN count(n) AS cnt`);
      counts[nt.name] = (r.rows[0]?.cnt as number) ?? 0;
    } catch {
      counts[nt.name] = 0;
    }
  }
  for (const rt of relTypes) {
    try {
      const r = await db.graph.query(`MATCH ()-[r:\`${rt.name}\`]->() RETURN count(r) AS cnt`);
      counts[rt.name] = (r.rows[0]?.cnt as number) ?? 0;
    } catch {
      counts[rt.name] = 0;
    }
  }

  const lines: string[] = [];
  lines.push(`## Schema (from registry by \`${TOOL_NAMES.MANAGE_SCHEMA}\`)`);
  lines.push("");
  lines.push(
    "A list of nodes/relationships, with their counts in database, list of properties. Tags of the property is displayed before its name.",
  );
  lines.push("");

  // ── Node types ──
  lines.push("### Node Types");
  lines.push("");
  for (let idx = 0; idx < nodeTypes.length; idx++) {
    const node = nodeTypes[idx];
    const count = counts[node.name];
    const qty = count !== undefined ? ` (×${count})` : "(×0)";
    const category = node.category === "GM_DEFINED" ? " [GM_DEFINED]" : "";
    lines.push(`${idx + 1}. **${node.name}**${qty}${category}: ${node.description}`);
    if (node.properties.length > 0) {
      const visible = node.properties.filter((p) => !p.name.startsWith("_"));
      for (const prop of visible) {
        const tagStr = prop.tags.length > 0 ? ` (${prop.tags.join(", ")})` : "";
        lines.push(`  -${tagStr} \`${prop.name}\`: ${prop.description}`);
      }
    }
    lines.push("");
  }

  // ── Relationship types ──
  lines.push("### Relationship Types");
  lines.push("");
  for (let idx = 0; idx < relTypes.length; idx++) {
    const rel = relTypes[idx];
    const count = counts[rel.name];
    const qty = count !== undefined ? ` (×${count})` : "";
    const src = rel.sourceLabel || "?";
    const tgt = rel.targetLabel || "?";
    const category = rel.category === "GM_DEFINED" ? " [GM_DEFINED]" : "";
    lines.push(`${idx + 1}. **${rel.name}**${qty} (${src}→${tgt})${category}: ${rel.description}`);
    if (rel.properties.length > 0) {
      const visible = rel.properties.filter((p) => !p.name.startsWith("_"));
      for (const prop of visible) {
        const tagStr = prop.tags.length > 0 ? ` (${prop.tags.join(", ")})` : "";
        lines.push(`  -${tagStr} \`${prop.name}\`: ${prop.description}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

export const getContext = tool({
  title: TOOL_NAMES.GET_CONTEXT,
  description: `
## Brief
Pull pre-built context from the world. Nothing is auto-loaded — you choose what you need.

## Types
- **SCHEMA_DUMP** — Rather important. All registered node types (with full property schemas: names, counts, tags, descriptions) and relationship types (with endpoint constraints and property schemas) in the database. Managed by \`${TOOL_NAMES.MANAGE_SCHEMA}\`.
- CHARACTERS_BRIEF — All characters with location.
- LOCATIONS_BRIEF — All locations with brief descriptions.
- OBJECTS_BRIEF — All objects with carrier or location.
- PLOTS_BRIEF — All plots with status, brief, and flags.
- SCENE_CONTEXT — Time, location, nearby NPCs/objects, inventory and NPC dispositions that is related to player.
- RELATIONSHIP_DUMP — All active relationships grouped by type. LOCATED_AT/LOCATED_IN are grouped by location showing occupants and access details.
`.trim(),
  inputSchema: z.object({
    types: z
      .array(z.enum(CONTEXT_TYPES))
      .default(["SCENE_CONTEXT"])
      .describe("Which context sections to return. Default: SCENE_CONTEXT only."),
  }),
  execute: wrapSafe(async (args: { types: ContextType[] }) => {
    const sections = args.types.length > 0 ? args.types : ["SCENE_CONTEXT"];

    const builders: Record<ContextType, () => Promise<string>> = {
      SCENE_CONTEXT: buildSceneContext,
      CHARACTERS_BRIEF: buildCharactersBrief,
      LOCATIONS_BRIEF: buildLocationsBrief,
      OBJECTS_BRIEF: buildObjectsBrief,
      PLOTS_BRIEF: buildPlotsBrief,
      SCHEMA_DUMP: buildSchemaDump,
      RELATIONSHIP_DUMP: buildRelationshipDump,
    };

    // TODO: Rewrite in Promise.all?
    const results: string[] = [];
    for (const type of sections) {
      try {
        const section = await builders[type]();
        if (section) results.push(section);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`## ${type}\n\nError: ${msg}\n`);
      }
    }

    return results.join("\n");
  }, TOOL_NAMES.GET_CONTEXT),
});
