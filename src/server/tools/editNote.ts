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
import { getMemoryClient, MemoryClient } from "@/server/memory/client";
import { wrapSafe } from "@/server/tools/shared";
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
    const client = getMemoryClient();

    if (args.action == "DELETE") {
      const deleted = await client.notes.deleteNote(args.noteName);
      return deleted
        ? `Note "${args.noteName}" is successfully deleted`
        : `ERROR: Note "${args.noteName}" is not found.`;
    }

    if (args.action == "CREATE") {
      if (!args.content) return `ERROR: Parameter "content" is required for CREATE.`;
      const note = await client.notes.createNote(args.noteName, args.content);
      if (args.aboutEntities) {
        for (const name of args.aboutEntities) await client.notes.linkToEntity(note.name, name);
      }
      if (args.aboutMessages) {
        for (const id of args.aboutMessages) await client.notes.linkToMessage(note.name, id);
      }
      if (args.aboutPlots) {
        for (const name of args.aboutPlots) await client.notes.linkToPlot(note.name, name);
      }
      return `Note "${note.name}" is successfully created (${note.content.length} chars, ${args.aboutEntities?.length ?? 0} entities linked, ${args.aboutMessages?.length ?? 0} messages linked, ${args.aboutPlots?.length ?? 0} plots linked).`;
    }

    const existing = await client.notes.getNote(args.noteName);
    if (!existing) return `ERROR: Note "${args.noteName}" not found.`;

    let flags = 0x0;
    // != null catches both null and undefined (LLM may output null for omitted fields).
    if (args.content != null) {
      flags |= 0x1;
      await client.notes.updateNote(args.noteName, { content: args.content });
    }
    if (args.aboutEntities != null) {
      flags |= 0x2;
      await client.notes.clearLinks(args.noteName, "ENTITY");
      for (const name of args.aboutEntities) await client.notes.linkToEntity(args.noteName, name);
    }
    if (args.aboutMessages != null) {
      flags |= 0x4;
      await client.notes.clearLinks(args.noteName, "MESSAGE");
      for (const id of args.aboutMessages) await client.notes.linkToMessage(args.noteName, id);
    }
    if (args.aboutPlots != null) {
      flags |= 0x8;
      await client.notes.clearLinks(args.noteName, "PLOT");
      for (const name of args.aboutPlots) await client.notes.linkToPlot(args.noteName, name);
    }

    const updatedFields = [];
    if (flags & 0x1) updatedFields.push("content");
    if (flags & 0x2) updatedFields.push("all entities links");
    if (flags & 0x4) updatedFields.push("all messages links");
    if (flags & 0x8) updatedFields.push("all plots links");
    return `Note "${args.noteName}" is successfully updated (${updatedFields.join(", ")} is overwritten).`;
  }, TOOL_NAMES.EDIT_NOTE),
});

const strippedInputSchema = z.object({
  noteName: z.string().describe("The name of the note (used as lookup key)."),
  action: z.enum(NOTE_ACTIONS).default("CREATE").describe("Action taken for the note."),
  content: z
    .string()
    .nullable()
    .optional()
    .describe(
      `Note text. CREATE: required. UPDATE: optional (set to overwrite). DELETE: omit.`.trim(),
    ),
});

/** GM-scoped: no entity/message/plot linking. Link management is handled by the Assistant. */
export const editNoteGm = tool({
  title: TOOL_NAMES.EDIT_NOTE,
  description: `
## Brief
Your scratchpad — CREATE, UPDATE (partial overwrite), or DELETE a note. To link a note to entities, messages, or plots, use \`${TOOL_NAMES.DELEGATE_TO_ASSISTANT}\`.

## Write a note
Write a note when tracking a suspicion or theory, an NPC made a promise/plan/threat,
a clue appeared but its meaning is unresolved, a player choice deserves future consequence.
A good note reads like a concise reminder to yourself, and positively contributes to story progression.

## Search a note
Use \`${TOOL_NAMES.SEARCH_WORLD}\` with domains: ["Note"] to find notes. You can also search plots with domains: ["Plot"].
`.trim(),
  inputSchema: strippedInputSchema,
  execute: wrapSafe(async (args: z.infer<typeof strippedInputSchema>) => {
    const client = getMemoryClient();

    if (args.action == "DELETE") {
      const deleted = await client.notes.deleteNote(args.noteName);
      return deleted
        ? `Note "${args.noteName}" is successfully deleted`
        : `ERROR: Note "${args.noteName}" is not found.`;
    }

    if (args.action == "CREATE") {
      if (!args.content) return `ERROR: Parameter "content" is required for CREATE.`;
      const note = await client.notes.createNote(args.noteName, args.content);
      return `Note "${note.name}" is successfully created (${note.content.length} chars).`;
    }

    const existing = await client.notes.getNote(args.noteName);
    if (!existing) return `ERROR: Note "${args.noteName}" not found.`;

    if (args.content != null) {
      await client.notes.updateNote(args.noteName, { content: args.content });
    }

    return args.content != null
      ? `Note "${args.noteName}" is successfully updated (content overwritten).`
      : `Note "${args.noteName}" — no changes requested.`;
  }, TOOL_NAMES.EDIT_NOTE),
});
