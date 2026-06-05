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

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Tool } from "@/sdk";
import { TOOL_NAMES } from "@/shared/constants";
import { wrapSafe } from "@/server/llm/tools/shared";
import {
  buildCharactersBrief,
  buildLocationsBrief,
  buildObjectsBrief,
  buildPlotsBrief,
  buildRelationshipDump,
  buildScenesBrief,
  buildTimeline,
  buildEntityProfile,
} from "@/server/llm/sceneContext";
import { Database } from "@/server/db";
import { SchemaRegistry } from "@/server/db/schema";
import { CURRICULUM } from "@/server/llm/curriculum";

const __dirname = dirname(fileURLToPath(import.meta.url));

let _promptsDict: Record<string, string> = {};

function loadPrompt(name: string) {
  if (!_promptsDict[name]) {
    const p = join(__dirname, "..", "prompts", name);
    _promptsDict[name] = readFileSync(p, "utf-8");
  }
  return _promptsDict[name];
}

const CONTEXT_TYPES = [
  "CHARACTERS_BRIEF",
  "LOCATIONS_BRIEF",
  "OBJECTS_BRIEF",
  "PLOTS_BRIEF",
  "SCENES_BRIEF",
  "SCHEMA_DUMP",
  "RELATIONSHIP_DUMP",
  "TIMELINE",
  "ENTITY_PROFILE",
  "CYPHER_COOKBOOK",
  "STORYTELLING_GUIDE",
  "CROSS_SECTION_PRINCIPLE",
  "WRITING_RED_LINES",
  "SHOW_DONT_TELL",
  "SUBTEXT_TECHNIQUES",
  "DIALOGUE_STYLE",
  "CHARACTER_ARC",
  "GHOST_LIE_FLAW",
  "SECONDARY_CHARACTER_DESIGN",
  "DRAMATIC_ACTION",
  "STRUCTURE_SELECTION_GUIDE",
  "SAVE_THE_CAT",
  "STORY_CIRCLE",
  "MCKEE_PRINCIPLES",
  "LITERARY_STYLE_VARIANTS",
  "SUBPLOT_INTERWEAVING",
  "FORESHADOWING_SYSTEM",
  "DUAL_TRACK_RHYTHM",
  "DURATION_ESTIMATION",
  "PACING_PLANNING",
  "PACING_TRAP_WARNING",
  "PACING_DIAGNOSTICS",
  "INTER_EPISODE_RHYTHM",
  "NARRATIVE_PURPOSE",
  "ACTION_REACTION",
  "CUT_CONNECTION_LOGIC",
  "DIALOGUE_SCENE_DIVERSITY",
  "SHOT_GROUPS",
  "STORYBOARD_DOUBLE_CHECK",
  "IMAGE_SYSTEM",
  "SCRIPT_MICRO_ADJUSTMENT",
  "DURATION_ESTIMATION_DATA",
  "TONE_SETTING_FRAMEWORK",
  "NARRATIVE_STANCE",
  "MOOD_LIBRARY",
  "GENRE_CONVENTIONS",
  "ACTION_CONFLICT",
  "RELATIONSHIP_DRAMA",
  "NARRATIVE_FORM",
  "SOCIAL_PERSPECTIVE",
  "OPENING_HOOKS",
  "ULTRA_SHORT_STRUCTURES",
  "CONCEPT_COMBINATION_METHODS",
  "HOW_TO_TELL_METHODS",
  "AV_LANGUAGE_ARSENAL",
  "WORLD_BUILDING_MODEL",
  "INFORMATION_RELEASE_SCHEDULE",
  "HIDDEN_LINE_DESIGN",
  "SERIES_TYPES",
  "ARC_BUDGET_ALLOCATION",
  "CONTINUITY_MANAGEMENT",
  "TOPIC_SELECTION_TOOLKIT",
  "CROSS_FORMAT_BORROWING",
  "SELF_CHECK_SYSTEM",
  "WORKFLOW_DISCIPLINE",
  "INPUT_COMPATIBILITY",
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
    const qty = count !== undefined ? `(×${count})` : "(×0)";
    const category = node.category as string;
    lines.push(`${idx + 1}. **${node.name}** ${qty} ${category}: ${node.description}`);
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
    const category = rel.category as string;
    lines.push(`${idx + 1}. **${rel.name}**${qty} (${src}→${tgt}) ${category}: ${rel.description}`);
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

const inputSchema = z.object({
  types: z.array(z.enum(CONTEXT_TYPES)).describe("Which context sections to return."),
  relationshipHistory: z
    .boolean()
    .optional()
    .describe(
      "For RELATIONSHIP_DUMP: when true, shows all relationships including expired with time ranges.",
    ),
  entityName: z
    .string()
    .optional()
    .describe("For ENTITY_PROFILE: the name of the entity to profile."),
  entityLabel: z
    .string()
    .optional()
    .describe(
      "For ENTITY_PROFILE: the label of the entity to profile (e.g. 'Character', 'Object').",
    ),
});

export const getContext: Tool<typeof inputSchema> = {
  name: TOOL_NAMES.GET_CONTEXT,
  description: `
## Brief
Pull pre-built context from the world. Nothing is auto-loaded — you choose what you need.

## Types
- **SCHEMA_DUMP** — All registered node types (with full property schemas: names, counts, tags, descriptions) and relationship types (with endpoint constraints and property schemas) in the database. Synchronized  with \`${TOOL_NAMES.MANAGE_SCHEMA}\`.
- CHARACTERS_BRIEF — All characters with location.
- LOCATIONS_BRIEF — All locations with brief descriptions.
- OBJECTS_BRIEF — All objects with carrier or location.
- PLOTS_BRIEF — All plots with status, brief, and flags.
- SCENES_BRIEF — All scenes ordered by time, with location, characters, and transition reason.
- RELATIONSHIP_DUMP — All active relationships grouped by type. LOCATED_AT/LOCATED_IN are grouped by location showing occupants and access details.
- TIMELINE — Chronological log of all temporal relationship changes (created/expired), most recent first.
- ENTITY_PROFILE — Everything about one node: properties, location, carried items, dispositions, notes, scene appearances, and relationship history. Requires entityName + entityLabel.
- CYPHER_COOKBOOK - The graph database is LadybugDB, its Cypher syntax is slightly different from most-used graph database Neo4j.
`.trim(),
  schema: inputSchema,
  execute: wrapSafe(async (args: z.infer<typeof inputSchema>) => {
    if (args.types.includes("ENTITY_PROFILE")) {
      if (!args.entityName || !args.entityLabel) {
        return "ERROR: entityName and entityLabel are required when ENTITY_PROFILE is requested.";
      }
    }
    const sections: ContextType[] = args.types.length > 0 ? args.types : [];

    const builders: Record<ContextType, () => Promise<string>> = {
      CHARACTERS_BRIEF: buildCharactersBrief,
      LOCATIONS_BRIEF: buildLocationsBrief,
      OBJECTS_BRIEF: buildObjectsBrief,
      PLOTS_BRIEF: buildPlotsBrief,
      SCENES_BRIEF: buildScenesBrief,
      SCHEMA_DUMP: buildSchemaDump,
      RELATIONSHIP_DUMP: () => buildRelationshipDump(!!(args as any).relationshipHistory),
      TIMELINE: buildTimeline,
      ENTITY_PROFILE: () => {
        const extra = args as any;
        return buildEntityProfile(extra.entityName, extra.entityLabel);
      },
      CYPHER_COOKBOOK: async () => loadPrompt("CYPHER_COOKBOOK"),
      STORYTELLING_GUIDE: async () => loadPrompt("STORYTELLING_GUIDE"),
      CROSS_SECTION_PRINCIPLE: async () => loadPrompt("CROSS_SECTION_PRINCIPLE"),
      WRITING_RED_LINES: async () => loadPrompt("WRITING_RED_LINES"),
      SHOW_DONT_TELL: async () => loadPrompt("SHOW_DONT_TELL"),
      SUBTEXT_TECHNIQUES: async () => loadPrompt("SUBTEXT_TECHNIQUES"),
      DIALOGUE_STYLE: async () => loadPrompt("DIALOGUE_STYLE"),
      CHARACTER_ARC: async () => loadPrompt("CHARACTER_ARC"),
      GHOST_LIE_FLAW: async () => loadPrompt("GHOST_LIE_FLAW"),
      SECONDARY_CHARACTER_DESIGN: async () => loadPrompt("SECONDARY_CHARACTER_DESIGN"),
      DRAMATIC_ACTION: async () => loadPrompt("DRAMATIC_ACTION"),
      STRUCTURE_SELECTION_GUIDE: async () => loadPrompt("STRUCTURE_SELECTION_GUIDE"),
      SAVE_THE_CAT: async () => loadPrompt("SAVE_THE_CAT"),
      STORY_CIRCLE: async () => loadPrompt("STORY_CIRCLE"),
      MCKEE_PRINCIPLES: async () => loadPrompt("MCKEE_PRINCIPLES"),
      LITERARY_STYLE_VARIANTS: async () => loadPrompt("LITERARY_STYLE_VARIANTS"),
      SUBPLOT_INTERWEAVING: async () => loadPrompt("SUBPLOT_INTERWEAVING"),
      FORESHADOWING_SYSTEM: async () => loadPrompt("FORESHADOWING_SYSTEM"),
      DUAL_TRACK_RHYTHM: async () => loadPrompt("DUAL_TRACK_RHYTHM"),
      DURATION_ESTIMATION: async () => loadPrompt("DURATION_ESTIMATION"),
      PACING_PLANNING: async () => loadPrompt("PACING_PLANNING"),
      PACING_TRAP_WARNING: async () => loadPrompt("PACING_TRAP_WARNING"),
      PACING_DIAGNOSTICS: async () => loadPrompt("PACING_DIAGNOSTICS"),
      INTER_EPISODE_RHYTHM: async () => loadPrompt("INTER_EPISODE_RHYTHM"),
      NARRATIVE_PURPOSE: async () => loadPrompt("NARRATIVE_PURPOSE"),
      ACTION_REACTION: async () => loadPrompt("ACTION_REACTION"),
      CUT_CONNECTION_LOGIC: async () => loadPrompt("CUT_CONNECTION_LOGIC"),
      DIALOGUE_SCENE_DIVERSITY: async () => loadPrompt("DIALOGUE_SCENE_DIVERSITY"),
      SHOT_GROUPS: async () => loadPrompt("SHOT_GROUPS"),
      STORYBOARD_DOUBLE_CHECK: async () => loadPrompt("STORYBOARD_DOUBLE_CHECK"),
      IMAGE_SYSTEM: async () => loadPrompt("IMAGE_SYSTEM"),
      SCRIPT_MICRO_ADJUSTMENT: async () => loadPrompt("SCRIPT_MICRO_ADJUSTMENT"),
      DURATION_ESTIMATION_DATA: async () => loadPrompt("DURATION_ESTIMATION_DATA"),
      TONE_SETTING_FRAMEWORK: async () => loadPrompt("TONE_SETTING_FRAMEWORK"),
      NARRATIVE_STANCE: async () => loadPrompt("NARRATIVE_STANCE"),
      MOOD_LIBRARY: async () => loadPrompt("MOOD_LIBRARY"),
      GENRE_CONVENTIONS: async () => loadPrompt("GENRE_CONVENTIONS"),
      ACTION_CONFLICT: async () => loadPrompt("ACTION_CONFLICT"),
      RELATIONSHIP_DRAMA: async () => loadPrompt("RELATIONSHIP_DRAMA"),
      NARRATIVE_FORM: async () => loadPrompt("NARRATIVE_FORM"),
      SOCIAL_PERSPECTIVE: async () => loadPrompt("SOCIAL_PERSPECTIVE"),
      OPENING_HOOKS: async () => loadPrompt("OPENING_HOOKS"),
      ULTRA_SHORT_STRUCTURES: async () => loadPrompt("ULTRA_SHORT_STRUCTURES"),
      CONCEPT_COMBINATION_METHODS: async () => loadPrompt("CONCEPT_COMBINATION_METHODS"),
      HOW_TO_TELL_METHODS: async () => loadPrompt("HOW_TO_TELL_METHODS"),
      AV_LANGUAGE_ARSENAL: async () => loadPrompt("AV_LANGUAGE_ARSENAL"),
      WORLD_BUILDING_MODEL: async () => loadPrompt("WORLD_BUILDING_MODEL"),
      INFORMATION_RELEASE_SCHEDULE: async () => loadPrompt("INFORMATION_RELEASE_SCHEDULE"),
      HIDDEN_LINE_DESIGN: async () => loadPrompt("HIDDEN_LINE_DESIGN"),
      SERIES_TYPES: async () => loadPrompt("SERIES_TYPES"),
      ARC_BUDGET_ALLOCATION: async () => loadPrompt("ARC_BUDGET_ALLOCATION"),
      CONTINUITY_MANAGEMENT: async () => loadPrompt("CONTINUITY_MANAGEMENT"),
      TOPIC_SELECTION_TOOLKIT: async () => loadPrompt("TOPIC_SELECTION_TOOLKIT"),
      CROSS_FORMAT_BORROWING: async () => loadPrompt("CROSS_FORMAT_BORROWING"),
      SELF_CHECK_SYSTEM: async () => loadPrompt("SELF_CHECK_SYSTEM"),
      WORKFLOW_DISCIPLINE: async () => loadPrompt("WORKFLOW_DISCIPLINE"),
      INPUT_COMPATIBILITY: async () => loadPrompt("INPUT_COMPATIBILITY"),
    };

    const tasks: Promise<void>[] = [];
    const results: string[] = [];
    for (let i = 0; i < sections.length; i++) {
      const type = sections[i];
      tasks.push(
        builders[type]()
          .then((section) => {
            results[i] = section;
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            results[i] = `## ${type}\n\nError: ${msg}\n`;
          }),
      );
    }

    await Promise.all(tasks);

    return results.join("\n");
  }, TOOL_NAMES.GET_CONTEXT),
};
