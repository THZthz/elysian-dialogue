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
import type { EventEmitter } from "@/server/llm/events";
import { wrapSafe } from "@/server/llm/tools/shared";
import { TOOL_NAMES } from "@/shared/constants";

const SCENE_ACTIONS = ["CREATE", "MODIFY"] as const;

function describeTime(time: number): string {
  const day = Math.floor(time / 48);
  const halfHours = time % 48;
  const hour = Math.floor(halfHours / 2);
  const minute = halfHours % 2 === 0 ? "00" : "30";
  const period = hour < 12 ? "AM" : "PM";
  const displayH = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `Day ${day}, ${displayH}:${minute} ${period}`;
}

function toInternalTime(day: number, hour: number): number {
  return day * 48 + hour * 2;
}

const inputSchema = z.object({
  action: z.enum(SCENE_ACTIONS).describe("CREATE a new scene or MODIFY the active one."),
  start_day: z.number().int().nullable().optional().describe("Day number. Required for CREATE."),
  start_hour: z
    .number()
    .nullable()
    .optional()
    .describe(
      "Hour in 24h with optional .5 for half-past (e.g. 9, 14.5, 20). Required for CREATE.",
    ),
  location_name: z.string().nullable().optional().describe("Location.name. Required for CREATE."),
  characters: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("Character names. Required for CREATE. Must include player."),
  reason: z.string().nullable().optional().describe("Why scene changed. Stored on NEXT_SCENE."),
  add_characters: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("MODIFY: merge into characters array."),
  end_day: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("MODIFY: close active scene at this day."),
  end_hour: z
    .number()
    .nullable()
    .optional()
    .describe("MODIFY: close active scene at this hour (24h, .5 for half-past)."),
});

export function createManageSceneTool(events: EventEmitter) {
  return tool({
    title: TOOL_NAMES.MANAGE_SCENE,
    description: `
## Brief
Manage scene transitions. CREATE starts a new scene, MODIFY adjusts or closes the active scene.

## CREATE
Start a new scene. Closes the active scene (if any) and creates a new one.
- \`start_day\`: Mandatory. Integer day number. Required for CREATE.
- \`start_hour\`: Mandatory. Hour in 24h with optional .5 for half-past (e.g. 9, 14.5). Required for CREATE.
- \`location_name\`: Mandatory. Must match an existing Location.name.
- \`characters\`: Mandatory. Array of character names. Must include the player's name.
- \`reason\`: Mandatory. Why the scene is changing (e.g. "Player traveled to the forest").

## MODIFY
Adjust the active scene.
- \`add_characters\`: Optional. Append characters to the current scene's character list.
- \`end_day\`: Optional. Integer day number to close the scene at.
- \`end_hour\`: Optional. Hour in 24h with optional .5 for half-past. Close the active scene at this time. Creates a placeholder for the next scene.

## Inner details
At most one Scene has \`end_time = NULL\` (the active scene). When CREATE is called, the old scene's
\`end_time\` is automatically set when you do not manually MODIFY it, and a NEXT_SCENE relationship links them.
`.trim(),
    inputSchema,
    execute: wrapSafe(async (args: z.infer<typeof inputSchema>) => {
      const db = Database.getExisting();

      if (args.action === "CREATE") {
        if (
          args.start_day == null ||
          args.start_hour == null ||
          args.location_name == null ||
          !args.characters?.length
        ) {
          return "ERROR: CREATE requires \`start_day\`, \`start_hour\`, \`location_name\`, \`characters\` (non-empty array) and \`reason\`.";
        }
        if (!args.characters.includes("Player")) {
          return "ERROR: characters must include 'Player'.";
        }

        const startTime = toInternalTime(args.start_day, args.start_hour);

        const { scene, timeMismatchWarning } = await db.scene.create({
          start_time: startTime,
          location_name: args.location_name,
          characters: args.characters,
          reason: args.reason,
        });

        events.emitSceneUpdate({
          scene_id: scene.name,
          start_time: scene.start_time,
          end_time: scene.end_time,
          location_name: scene.location_name!,
          characters: scene.characters,
          reason: args.reason ?? null,
        });

        const msg = `Scene (unique name: "${scene.name}") created: ${describeTime(scene.start_time)} at "${scene.location_name}" with [${scene.characters.join(", ")}].`;
        return timeMismatchWarning ? `${msg}\n${timeMismatchWarning}` : msg;
      }

      // MODIFY
      const active = await db.scene.getActive();
      if (!active) return "ERROR: No active scene to modify. Create a scene first.";

      if (args.add_characters?.length) {
        await db.scene.modify({ add_characters: args.add_characters });
      }
      if (args.end_day != null && args.end_hour != null) {
        const endTime = toInternalTime(args.end_day, args.end_hour);
        const placeholder = await db.scene.modify({
          end_time: endTime,
          reason: args.reason ?? undefined,
        });
        events.emitSceneUpdate({
          scene_id: active.name,
          start_time: active.start_time,
          end_time: endTime,
          location_name: active.location_name!,
          characters: active.characters,
          reason: args.reason ?? null,
        });
        return `Scene (unique name: "${active.name}") closed at ${describeTime(endTime)}. A placeholder scene (unique name: "${placeholder.name}") is ready for the next CREATE.${
          args.reason ? ` Reason: "${args.reason}"` : ""
        }`;
      }

      const updated = await db.scene.getActive();
      return `Scene (unique name: "${active.name}") modified. Current characters: [${updated?.characters.join(", ") ?? ""}].`;
    }, TOOL_NAMES.MANAGE_SCENE),
  });
}
