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
import type { EventEmitter } from "@/server/llm/events";
import { wrapSafe } from "@/server/llm/tools/shared";
import { TOOL_NAMES } from "@/shared/constants";
import { describeInternalTime } from "@/server/db/utils";

const SCENE_ACTIONS = ["CREATE", "MODIFY", "READ", "FIX"] as const;

function toInternalTime(day: number, hour: number): number {
  return day * 48 + hour * 2;
}

const inputSchema = z.object({
  action: z.enum(SCENE_ACTIONS).describe("CREATE a new scene, MODIFY or READ the active one."),
  scene_name: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Unique scene name (e.g. 'inn_arrival'). Required for CREATE. Optional for MODIFY/READ — defaults to active scene if omitted.",
    ),
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

export function createManageSceneTool(events: EventEmitter): Tool<typeof inputSchema> {
  return {
    name: TOOL_NAMES.MANAGE_SCENE,
    description: `
Manage scene transitions.

## CREATE
Start a new scene. Validates that all specified characters have active CHARACTER_AT pointing to the given location. If discrepancies are found (characters not at location, extra characters at location not in list), the scene is NOT created — parameters are held pending and discrepancies reported. Call FIX to apply automatic CHARACTER_AT fixes and continue.

## FIX
Confirm a pending CREATE. Applies automatic CHARACTER_AT fixes and creates the scene. No parameters. Call after reviewing CREATE discrepancy report.

## MODIFY
Adjust or close a scene. Defaults to the active scene if \`scene_name\` omitted. Use \`add_characters\` to append, \`end_day\` + \`end_hour\` to close (creates placeholder for next scene).

## READ
Return active scene info (name, time, location, characters, log entries). Defaults to active scene.

At most one scene has \`end_time = NULL\` (active). When CREATE is called, the old scene's \`end_time\` is auto-set (unless manually MODIFY'd), linked via NEXT_SCENE.
`.trim(),
    schema: inputSchema,
    execute: (() => {
      interface PendingCreate {
        scene_name: string;
        start_day: number;
        start_hour: number;
        location_name: string;
        characters: string[];
        reason: string | null | undefined;
      }
      let pending: PendingCreate | null = null;

      return wrapSafe(async (args: z.infer<typeof inputSchema>) => {
        const db = Database.getExisting();

        if (args.action === "FIX") {
          if (!pending) return "ERROR: No pending CREATE to fix. Call CREATE first.";

          const p = pending;
          pending = null;

          const startTime = toInternalTime(p.start_day, p.start_hour);
          const { fixed, extraAtLocation } = await db.scene.syncCharacterLocations(
            p.location_name,
            p.characters,
            startTime,
          );

          const { scene, timeMismatchWarning } = await db.scene.create({
            scene_name: p.scene_name,
            start_time: startTime,
            location_name: p.location_name,
            characters: p.characters,
            reason: p.reason ?? "",
          });

          events.emitSceneUpdate({
            scene_id: scene.name,
            start_time: scene.start_time,
            end_time: scene.end_time,
            location_name: scene.location_name!,
            characters: scene.characters,
            reason: p.reason ?? null,
          });

          const parts: string[] = [];
          if (fixed.length > 0) {
            parts.push(`CHARACTER_AT fixed: ${fixed.join(", ")} now at "${p.location_name}".`);
          }
          if (extraAtLocation.length > 0) {
            parts.push(
              `Characters at "${p.location_name}" but not in scene: ${extraAtLocation.join(", ")}.`,
            );
          }
          let msg = `Scene (unique name: "${scene.name}") created: ${describeInternalTime(scene.start_time)} at "${scene.location_name}" with [${scene.characters.join(", ")}].`;
          if (parts.length > 0) msg += `\n${parts.join("\n")}`;
          if (timeMismatchWarning) msg += `\n${timeMismatchWarning}`;
          return msg;
        }

        if (args.action === "READ") {
          const scene = args.scene_name
            ? await db.scene.getByName(args.scene_name)
            : await db.scene.getActive();
          if (!scene) {
            return args.scene_name
              ? `ERROR: Scene "${args.scene_name}" not found.`
              : "No active scene. Create a scene first with CREATE.";
          }

          const fallbackNote = !args.scene_name ? " (defaulted to active scene)" : "";
          return [
            `Scene: "${scene.name}"${fallbackNote}`,
            `Time: ${describeInternalTime(scene.start_time)}${scene.end_time !== null ? ` → ${describeInternalTime(scene.end_time)}` : " (ongoing)"}`,
            `Location: ${scene.location_name ?? "(none)"}`,
            `Characters: [${scene.characters.join(", ")}]`,
            `Log entries: ${scene.log.length}`,
          ].join("\n");
        }

        if (args.action === "CREATE") {
          if (
            args.scene_name == null ||
            args.start_day == null ||
            args.start_hour == null ||
            args.location_name == null ||
            !args.characters?.length
          ) {
            return `ERROR: CREATE requires \`scene_name\`, \`start_day\`, \`start_hour\`, \`location_name\`, \`characters\` (non-empty array) and \`reason\`.`;
          }
          if (!args.characters.includes("Player")) {
            return "ERROR: characters must include 'Player'.";
          }

          const { missingFromLocation, extraAtLocation } = await db.scene.checkCharacterLocations(
            args.location_name,
            args.characters,
          );

          if (missingFromLocation.length > 0 || extraAtLocation.length > 0) {
            const hadPending = pending !== null;
            pending = {
              scene_name: args.scene_name,
              start_day: args.start_day,
              start_hour: args.start_hour,
              location_name: args.location_name,
              characters: args.characters,
              reason: args.reason,
            };

            const lines: string[] = ["CREATE pending — discrepancies found:"];
            if (missingFromLocation.length > 0) {
              lines.push(
                `  Not at "${args.location_name}": ${missingFromLocation.join(", ")} (will be moved automatically).`,
              );
            }
            if (extraAtLocation.length > 0) {
              lines.push(
                `  At "${args.location_name}" but not in scene: ${extraAtLocation.join(", ")} (will NOT be added to scene).`,
              );
            }
            if (hadPending) {
              lines.push("  (Previous pending CREATE was discarded.)");
            }
            lines.push("Call FIX to apply the fixes and create the scene.");
            return lines.join("\n");
          }

          // No discrepancies — create directly
          const hadPending = pending !== null;
          pending = null;

          const startTime = toInternalTime(args.start_day, args.start_hour);

          const { scene, timeMismatchWarning } = await db.scene.create({
            scene_name: args.scene_name,
            start_time: startTime,
            location_name: args.location_name,
            characters: args.characters,
            reason: args.reason ?? "",
          });

          events.emitSceneUpdate({
            scene_id: scene.name,
            start_time: scene.start_time,
            end_time: scene.end_time,
            location_name: scene.location_name!,
            characters: scene.characters,
            reason: args.reason ?? null,
          });

          let msg = `Scene (unique name: "${scene.name}") created: ${describeInternalTime(scene.start_time)} at "${scene.location_name}" with [${scene.characters.join(", ")}].`;
          if (hadPending) msg += "\n(Previous pending CREATE was discarded.)";
          if (timeMismatchWarning) msg += `\n${timeMismatchWarning}`;
          return msg;
        }

        // MODIFY
        const active = args.scene_name ? null : await db.scene.getActive();
        if (!args.scene_name && !active)
          return "ERROR: No active scene to modify. Create a scene first with CREATE.";

        if (args.add_characters?.length) {
          await db.scene.modify({
            scene_name: args.scene_name ?? undefined,
            add_characters: args.add_characters,
          });
        }
        if (args.end_day != null && args.end_hour != null) {
          const endTime = toInternalTime(args.end_day, args.end_hour);
          const placeholder = await db.scene.modify({
            scene_name: args.scene_name ?? undefined,
            end_time: endTime,
            reason: args.reason ?? undefined,
          });

          const sceneName = args.scene_name ?? active!.name;
          const targetScene = args.scene_name ? await db.scene.getByName(args.scene_name) : active;
          events.emitSceneUpdate({
            scene_id: sceneName,
            start_time: targetScene!.start_time,
            end_time: endTime,
            location_name: targetScene!.location_name!,
            characters: targetScene!.characters,
            reason: args.reason ?? null,
          });

          const fallbackNote = !args.scene_name ? " (defaulted to active scene)" : "";
          return `Scene (unique name: "${sceneName}")${fallbackNote} closed at ${describeInternalTime(endTime)}. A placeholder scene (unique name: "${placeholder!.name}") is ready for the next CREATE.${
            args.reason ? ` Reason: "${args.reason}"` : ""
          }`;
        }

        const fallbackNote = !args.scene_name ? " (defaulted to active scene)" : "";
        const updated = args.scene_name
          ? await db.scene.getByName(args.scene_name)
          : await db.scene.getActive();
        return `Scene (unique name: "${args.scene_name ?? active!.name}")${fallbackNote} modified. Current characters: [${updated?.characters.join(", ") ?? ""}].`;
      }, TOOL_NAMES.MANAGE_SCENE);
    })(),
  };
}
