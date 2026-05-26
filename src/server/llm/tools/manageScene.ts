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

const inputSchema = z.object({
  action: z.enum(SCENE_ACTIONS).describe("CREATE a new scene or MODIFY the active one."),
  start_time: z.number().nullable().optional().describe("Day * 48 + half-hour. Required for CREATE."),
  location_name: z.string().nullable().optional().describe("Location.name. Required for CREATE."),
  characters: z.array(z.string()).nullable().optional().describe("Character names. Required for CREATE. Must include player."),
  reason: z.string().nullable().optional().describe("Why scene changed. Stored on NEXT_SCENE."),
  add_characters: z.array(z.string()).nullable().optional().describe("MODIFY: merge into characters array."),
  end_time: z.number().nullable().optional().describe("MODIFY: close the active scene at this time."),
});

export function createManageSceneTool(events: EventEmitter) {
  return tool({
    title: TOOL_NAMES.MANAGE_SCENE,
    description: `
## Brief
Manage scene transitions. CREATE starts a new scene, MODIFY adjusts or closes the active scene.

## CREATE
Start a new scene. Closes the active scene (if any) and creates a new one.
- \`start_time\`: Day * 48 + half-hour (DOUBLE).
- \`location_name\`: Must match an existing Location.name.
- \`characters\`: Array of character names. Must include the player's name.
- \`reason\`: Why the scene is changing (e.g. "Player traveled to the forest").

## MODIFY
Adjust the active scene.
- \`add_characters\`: Append characters to the current scene's character list.
- \`end_time\`: Close the active scene at a specific time. Creates a placeholder for the next scene.

## Others
At most one Scene has \`end_time = NULL\` (the active scene). When CREATE is called, the old scene's
end_time is set and a NEXT_SCENE relationship links them.
`.trim(),
    inputSchema,
    execute: wrapSafe(async (args: z.infer<typeof inputSchema>) => {
      const db = Database.getExisting();

      if (args.action === "CREATE") {
        if (args.start_time == null || args.location_name == null || !args.characters?.length) {
          return "ERROR: CREATE requires start_time, location_name, and characters (non-empty array).";
        }
        if (!args.characters.includes("Player")) {
          return "ERROR: characters must include 'Player'.";
        }

        const scene = await db.scene.create({
          start_time: args.start_time,
          location_name: args.location_name,
          characters: args.characters,
          reason: args.reason ?? "",
        });

        events.emitSceneUpdate({
          scene_id: scene._uid,
          start_time: scene.start_time,
          end_time: scene.end_time,
          location_name: scene.location_name!,
          characters: scene.characters,
          reason: args.reason ?? null,
        });

        return `Scene created: ${describeTime(scene.start_time)} at "${scene.location_name}" with [${scene.characters.join(", ")}].`;
      }

      // MODIFY
      const active = await db.scene.getActive();
      if (!active) return "ERROR: No active scene to modify. Create a scene first.";

      if (args.add_characters?.length) {
        await db.scene.modify({ add_characters: args.add_characters });
      }
      if (args.end_time != null) {
        const placeholder = await db.scene.modify({ end_time: args.end_time, reason: args.reason ?? undefined });
        events.emitSceneUpdate({
          scene_id: active._uid,
          start_time: active.start_time,
          end_time: args.end_time,
          location_name: active.location_name!,
          characters: active.characters,
          reason: args.reason ?? null,
        });
        return `Scene closed at ${describeTime(args.end_time)}. A placeholder scene is ready for the next CREATE.${
          args.reason ? ` Reason: "${args.reason}"` : ""
        }`;
      }

      const updated = await db.scene.getActive();
      return `Scene modified. Current characters: [${updated?.characters.join(", ") ?? ""}].`;
    }, TOOL_NAMES.MANAGE_SCENE),
  });
}
