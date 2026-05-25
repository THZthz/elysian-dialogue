import { tool } from "ai";
import { z } from "zod";
import { TOOL_NAMES } from "@/shared/constants";
import { wrapSafe } from "@/server/shared/toolUtils";
import {
  buildSceneContext,
  buildCharactersBrief,
  buildLocationsBrief,
  buildObjectsBrief,
  buildPlotsBrief,
} from "@/server/assistant/sceneContext";

const GM_CONTEXT_TYPES = [
  "SCENE_CONTEXT",
  "CHARACTERS_BRIEF",
  "LOCATIONS_BRIEF",
  "OBJECTS_BRIEF",
  "PLOTS_BRIEF",
] as const;

type GmContextType = (typeof GM_CONTEXT_TYPES)[number];

const builders: Record<GmContextType, () => Promise<string>> = {
  SCENE_CONTEXT: buildSceneContext,
  CHARACTERS_BRIEF: buildCharactersBrief,
  LOCATIONS_BRIEF: buildLocationsBrief,
  OBJECTS_BRIEF: buildObjectsBrief,
  PLOTS_BRIEF: buildPlotsBrief,
};

export const getContext = tool({
  title: TOOL_NAMES.GET_CONTEXT,
  description: `
## Brief
Get a snapshot of the current scene and world state. Nothing is auto-loaded — you choose what you need.

## Types
- SCENE_CONTEXT — Time, your location, who is nearby, what you're carrying, recent events.
- CHARACTERS_BRIEF — All characters with their current location.
- LOCATIONS_BRIEF — All locations with brief descriptions.
- OBJECTS_BRIEF — All objects with their carrier or location.
- PLOTS_BRIEF — All plots with status, brief, and flags.

Ask for additional detail on people, places, items, or story arcs when needed. For schema information or relationship details, ask your assistant.
`.trim(),
  inputSchema: z.object({
    types: z
      .array(z.enum(GM_CONTEXT_TYPES))
      .default(["SCENE_CONTEXT"])
      .describe("Which context sections to return. Default: SCENE_CONTEXT only."),
  }),
  execute: wrapSafe(async (args: { types: GmContextType[] }) => {
    const sections = args.types.length > 0 ? args.types : ["SCENE_CONTEXT"];

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
