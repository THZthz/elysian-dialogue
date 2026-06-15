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

import { globSync } from "node:fs";
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
  buildSchemaDump,
  buildEntityProfile,
} from "@/server/llm/sceneContext";

const __dirname = dirname(fileURLToPath(import.meta.url));

const _promptsDict: Record<string, string> = {};

// NOTE: Do we need to clean prompts when it is not used? Load all prompts into memory seems fine for now.
function loadPrompt(name: string): string {
  if (!_promptsDict[name]) {
    const promptsDir = join(__dirname, "..", "prompts");

    const entries = globSync("**/" + name + ".md", {
      cwd: promptsDir,
      withFileTypes: true, // returns Dirent objects
    });

    // Filter only regular files (skip directories with the same name)
    const files = entries.filter((entry) => entry.isFile());

    if (files.length === 0) {
      throw new Error(`Prompt file "${name}" not found in ${promptsDir}`);
    }

    // Use `parentPath` (since v20.12) and `name` to build the full path
    const file = files[0];
    const fullPath = join(file.parentPath, file.name);

    _promptsDict[name] = readFileSync(fullPath, "utf-8").replace(
      /\{\{TOOL_NAMES\.(\w+)\}\}/g,
      (_, key) => (TOOL_NAMES as Record<string, string>)[key] ?? `{{TOOL_NAMES.${key}}}`,
    );
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
] as const;

type ContextType = (typeof CONTEXT_TYPES)[number];

const inputSchema = z.object({
  types: z.array(z.enum(CONTEXT_TYPES)).describe("Which context sections to return."),
  subquery: z
    .object({
      prompt: z
        .string()
        .optional()
        .nullable()
        .describe("For STORYTELLING_GUIDE: a string naming the sub-prompt."),
      relationshipHistory: z
        .boolean()
        .optional()
        .nullable()
        .describe(
          "For RELATIONSHIP_DUMP: when true, includes all relationships including expired ones with time ranges.",
        ),
      entityName: z
        .string()
        .optional()
        .nullable()
        .describe("For ENTITY_PROFILE: the name of the entity to profile."),
      entityLabel: z
        .string()
        .optional()
        .nullable()
        .describe(
          "For ENTITY_PROFILE: the label of the entity to profile (e.g. 'Character', 'Object').",
        ),
    })
    .optional(),
});

export const getContext: Tool<typeof inputSchema> = {
  name: TOOL_NAMES.GET_CONTEXT,
  description: `
## Brief
Pull pre-built context from the world. Nothing is auto-loaded — you choose what you need.

## Types
- **SCHEMA_DUMP** — All registered node types (with full property schemas: names, counts, tags, descriptions) and relationship types (with endpoint constraints and property schemas) in the database. Synchronized with \`${TOOL_NAMES.MANAGE_SCHEMA}\`.
- CHARACTERS_BRIEF — All characters with location.
- LOCATIONS_BRIEF — All locations with brief descriptions.
- OBJECTS_BRIEF — All objects with carrier or location.
- PLOTS_BRIEF — All plots with status, brief, and flags.
- SCENES_BRIEF — All scenes ordered by time, with location, characters, and transition reason.
- RELATIONSHIP_DUMP — All active relationships grouped by type. CHARACTER_AT/OBJECT_AT/LOCATED_IN are grouped by location showing occupants and access details.
- TIMELINE — Chronological log of all temporal relationship changes (created/expired), most recent first.
- ENTITY_PROFILE — Everything about one node: properties, location, carried items, dispositions, notes, scene appearances, and relationship history.
- CYPHER_COOKBOOK — Static content. The graph database is LadybugDB, its Cypher syntax is slightly different from most-used graph database Neo4j.
`.trim(),
  schema: inputSchema,
  execute: wrapSafe(async (args: z.infer<typeof inputSchema>) => {
    const sq = args.subquery;
    const sections: ContextType[] = args.types.length > 0 ? args.types : [];

    const builders: Record<ContextType, () => Promise<string>> = {
      CHARACTERS_BRIEF: buildCharactersBrief,
      LOCATIONS_BRIEF: buildLocationsBrief,
      OBJECTS_BRIEF: buildObjectsBrief,
      PLOTS_BRIEF: buildPlotsBrief,
      SCENES_BRIEF: buildScenesBrief,
      SCHEMA_DUMP: buildSchemaDump,
      RELATIONSHIP_DUMP: () => buildRelationshipDump(!!sq?.relationshipHistory),
      TIMELINE: buildTimeline,
      ENTITY_PROFILE: () => {
        if (!sq?.entityName || !sq?.entityLabel) {
          return Promise.resolve(
            "## ENTITY_PROFILE\n\nERROR: entityName and entityLabel are required when ENTITY_PROFILE is requested.",
          );
        }
        return buildEntityProfile(sq.entityName, sq.entityLabel);
      },
      CYPHER_COOKBOOK: async () => loadPrompt("CYPHER_COOKBOOK"),
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
