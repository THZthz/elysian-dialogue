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

import { z } from "zod";
import type { Tool } from "@/sdk";
import { Database } from "@/server/db";
import { wrapSafe } from "@/server/llm/tools/shared";
import { TOOL_NAMES } from "@/shared/constants";

const NOTE_ACTIONS = ["CREATE", "UPDATE", "DELETE"] as const;

const inputSchema = z.object({
  noteName: z.string().describe("The unique name of the note."),
  action: z.enum(NOTE_ACTIONS).default("CREATE").describe("Action taken for the note."),
  // .nullable() is needed because LLMs often output null for omitted optional fields
  content: z
    .string()
    .nullable()
    .optional()
    .describe("Note content."),
  aboutEntities: z
    .array(z.string())
    .nullable()
    .optional()
    .describe(
      "Entity (Character/Object/Location) names to link this note to. Replaces existing ABOUT_CHARACTER / ABOUT_OBJECT / ABOUT_LOCATION links — pass [] to clear all.",
    ),
  aboutScenes: z
    .array(z.string())
    .nullable()
    .optional()
    .describe(
      "Scene name values to link this note to. Replaces existing ABOUT_SCENE links — pass [] to clear all.",
    ),
  aboutPlots: z
    .array(z.string())
    .nullable()
    .optional()
    .describe(
      "Plot names to link this note to. Replaces existing ABOUT_PLOT links — pass [] to clear all.",
    ),
});

export const editNote: Tool<typeof inputSchema> = {
  name: TOOL_NAMES.EDIT_NOTE,
  description: `CREATE, UPDATE (partial overwrite), or DELETE a note. Write a note when tracking a unresolved threads, characters' biography/backstory, etc.`,
  schema: inputSchema,
  execute: wrapSafe(async (args: z.infer<typeof inputSchema>) => {
    const db = Database.getExisting();

    if (args.action == "DELETE") {
      const existing = await db.notes.getByName(args.noteName);
      if (!existing) return `ERROR: \`(:Note {name: "${args.noteName}"})\` is not found.`;
      await db.notes.delete(args.noteName);
      return `\`(:Note {name: "${args.noteName}"})\` is successfully deleted.`;
    }

    if (args.action == "CREATE") {
      if (!args.content) return `ERROR: Parameter \`content\` is required for CREATE.`;
      await db.notes.create(args.noteName, args.content);
      if (args.aboutEntities) {
        for (const name of args.aboutEntities) await db.notes.linkToEntity(args.noteName, name);
      }
      if (args.aboutScenes) {
        for (const uid of args.aboutScenes) await db.notes.linkToScene(args.noteName, uid);
      }
      if (args.aboutPlots) {
        for (const name of args.aboutPlots) await db.notes.linkToPlot(args.noteName, name);
      }
      return `\`(:Note {name: "${args.noteName}"})\` is successfully created (${args.content.length} chars, currently linked to ${args.aboutEntities?.length ?? 0} entities, ${args.aboutScenes?.length ?? 0} scenes, and ${args.aboutPlots?.length ?? 0} plots).`;
    }

    const existing = await db.notes.getByName(args.noteName);
    if (!existing) return `ERROR: \`(:Note {name: "${args.noteName}"})\` is not found.`;

    let flags = 0x0;
    // != null catches both null and undefined (LLM may output null for omitted fields).
    if (args.content != null) {
      flags |= 0x1;
      await db.notes.update(args.noteName, args.content);
    }

    // Handle link changes: clearLinks removes all link types, so batch together.
    const anyLinksChanged =
      args.aboutEntities != null || args.aboutScenes != null || args.aboutPlots != null;
    if (anyLinksChanged) {
      await db.notes.clearLinks(args.noteName);
      // Rebuild from provided arrays, preserving existing links for arrays not provided.
      const entities = args.aboutEntities ?? existing.linkedEntities;
      const scenes = args.aboutScenes ?? existing.linkedScenes;
      const plots = args.aboutPlots ?? existing.linkedPlots;
      if (args.aboutEntities != null) flags |= 0x2;
      if (args.aboutScenes != null) flags |= 0x4;
      if (args.aboutPlots != null) flags |= 0x8;
      for (const name of entities) await db.notes.linkToEntity(args.noteName, name);
      for (const uid of scenes) await db.notes.linkToScene(args.noteName, uid);
      for (const name of plots) await db.notes.linkToPlot(args.noteName, name);
    }

    const updatedFields = [];
    if (flags & 0x1) updatedFields.push("note content");
    if (flags & 0x2) updatedFields.push("all entities links");
    if (flags & 0x4) updatedFields.push("all scenes links");
    if (flags & 0x8) updatedFields.push("all plots links");
    return `\`(:Note {name: "${args.noteName}"})\` is successfully updated (overwritten ${updatedFields.join(", ")}).`;
  }, TOOL_NAMES.EDIT_NOTE),
};
