/**
 * Chorus — cinematic RPG-style dialogue engine
 * Copyright (C) 2026  Amias
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

const NOTE_ACTIONS = ["CREATE", "UPDATE", "DELETE"] as const;

const inputSchema = z.object({
  noteName: z.string().describe("The name of the note (used as lookup key)."),
  action: z.enum(NOTE_ACTIONS).default("CREATE").describe("Action taken for the note."),
  // .nullable() is needed because LLMs often output null for omitted optional fields
  content: z
    .string()
    .nullable()
    .optional()
    .describe(
      `
Note text. CREATE: required. UPDATE: optional (set to overwrite). DELETE: omit.`.trim(),
    ),
  aboutEntities: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("Entity names to link this note to. Replaces existing links — pass [] to clear all."),
  aboutMessages: z
    .array(z.string())
    .nullable()
    .optional()
    .describe(
      "Message IDs to link this note to. Replaces existing links — pass [] to clear all. Link to messages to anchor notes to TimePoints via :Message AT_TIME → :TimePoint.",
    ),
  aboutPlots: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("Plot names to link this note to. Replaces existing links — pass [] to clear all."),
});

export const editNote = tool({
  title: TOOL_NAMES.EDIT_NOTE,
  description: `
## Brief
Your scratchpad — CREATE, UPDATE (partial overwrite), or DELETE a note. Notes can be
linked to entities via \`aboutEntities\` (ABOUT_ENTITY), messages via \`aboutMessages\`
(ABOUT_MESSAGE), and plots via \`aboutPlots\` (ABOUT_PLOT) for cross-referencing to the world,
timeline, and story arcs.

## Write a note
Write a note when tracking a suspicion or theory, an NPC made a promise/plan/threat,
a clue appeared but its meaning is unresolved, a player choice deserves future consequence.
A good note reads like a concise reminder to yourself, and positively contributes to story progression.

## Search a note
Do not readily use \`${TOOL_NAMES.SEARCH_WORLD}\`, consider relationships ABOUT_ENTITY, ABOUT_PLOT
or ABOUT_MESSAGE first if you have a clear target.
`.trim(),
  inputSchema,
  execute: wrapSafe(async (args: z.infer<typeof inputSchema>) => {
    const db = Database.getExisting();

    if (args.action == "DELETE") {
      const existing = await db.notes.getByName(args.noteName);
      if (!existing) return `ERROR: Note "${args.noteName}" is not found.`;
      await db.notes.delete(args.noteName);
      return `Note "${args.noteName}" is successfully deleted`;
    }

    if (args.action == "CREATE") {
      if (!args.content) return `ERROR: Parameter "content" is required for CREATE.`;
      await db.notes.create(args.noteName, args.content);
      if (args.aboutEntities) {
        for (const name of args.aboutEntities) await db.notes.linkToEntity(args.noteName, name);
      }
      if (args.aboutMessages) {
        for (const id of args.aboutMessages) await db.notes.linkToMessage(args.noteName, id);
      }
      if (args.aboutPlots) {
        for (const name of args.aboutPlots) await db.notes.linkToPlot(args.noteName, name);
      }
      return `Note "${args.noteName}" is successfully created (${args.content.length} chars, ${args.aboutEntities?.length ?? 0} entities linked, ${args.aboutMessages?.length ?? 0} messages linked, ${args.aboutPlots?.length ?? 0} plots linked).`;
    }

    const existing = await db.notes.getByName(args.noteName);
    if (!existing) return `ERROR: Note "${args.noteName}" not found.`;

    let flags = 0x0;
    // != null catches both null and undefined (LLM may output null for omitted fields).
    if (args.content != null) {
      flags |= 0x1;
      await db.notes.update(args.noteName, args.content);
    }

    // Handle link changes: clearLinks removes all link types, so batch together.
    const anyLinksChanged = args.aboutEntities != null || args.aboutMessages != null || args.aboutPlots != null;
    if (anyLinksChanged) {
      await db.notes.clearLinks(args.noteName);
      // Rebuild from provided arrays, preserving existing links for arrays not provided.
      const entities = args.aboutEntities ?? existing.linkedEntities;
      const messages = args.aboutMessages ?? existing.linkedMessages;
      const plots = args.aboutPlots ?? existing.linkedPlots;
      if (args.aboutEntities != null) flags |= 0x2;
      if (args.aboutMessages != null) flags |= 0x4;
      if (args.aboutPlots != null) flags |= 0x8;
      for (const name of entities) await db.notes.linkToEntity(args.noteName, name);
      for (const id of messages) await db.notes.linkToMessage(args.noteName, id);
      for (const name of plots) await db.notes.linkToPlot(args.noteName, name);
    }

    const updatedFields = [];
    if (flags & 0x1) updatedFields.push("content");
    if (flags & 0x2) updatedFields.push("all entities links");
    if (flags & 0x4) updatedFields.push("all messages links");
    if (flags & 0x8) updatedFields.push("all plots links");
    return `Note "${args.noteName}" is successfully updated (${updatedFields.join(", ")} is overwritten).`;
  }, TOOL_NAMES.EDIT_NOTE),
});
