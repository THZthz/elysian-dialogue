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

// ── Time formatting helpers ──

function formatHour(hour: number): string {
  const h = Math.floor(hour);
  const m = hour % 1 === 0.5 ? 30 : 0;
  const period = h < 12 ? "AM" : "PM";
  const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const mm = m === 0 ? "00" : "30";
  return `${displayH}:${mm} ${period}`;
}

function describeTime(time: { day: number; hour: number }): string {
  return `Day ${time.day}, ${formatHour(time.hour)}`;
}

// NB: .nullable() on optional fields prevents Zod rejection when the LLM
// outputs "field": null for fields it intends to omit.
const inputSchema = z.object({
  hours: z
    .number()
    .min(0)
    .max(48)
    .multipleOf(0.5)
    .nullable()
    .optional()
    .describe("Number of half-hours to advance (0–48, 30 minutes)."),
  days: z
    .number()
    .int()
    .min(0)
    .nullable()
    .optional()
    .describe("Number of full days to advance (0+)."),
  reason: z.string().nullable().optional().describe("Brief narrative reason for the time advance."),
});

export function createAdvanceTimeTool(events: EventEmitter) {
  return tool({
    title: TOOL_NAMES.ADVANCE_TIME,
    description: `
## Brief
Advance the in-game clock. Do not just narrate that time have passed without calling
\`${TOOL_NAMES.ADVANCE_TIME}\`. Use hours for sub-day advances, or days (0+) for multi-day travel.
Total advancement = days * 24 + hours. Always include a brief \`reason\` so your future self knows
why time moved.

## Inner details
When ${TOOL_NAMES.ADVANCE_TIME} is called, a new TimePoint will be created first, then TimeAnchor
will point to the new TimePoint: (TimeAnchor)-[:CURRENT_TIMEPOINT]->(TimePoint), finally the new
TimePoint will link to the old via NEXT_TIMEPOINT with the \`reason\` stored on the relationship.
`.trim(),
    inputSchema,
    execute: wrapSafe(async (args: z.infer<typeof inputSchema>) => {
      const db = Database.getExisting();
      const totalHalfHours = (args.days ?? 0) * 48 + (args.hours ?? 0) * 2;

      const current = await db.time.getCurrentTimePoint();
      if (!current) return "ERROR: TimePoint not initialized. The world has not been seeded yet.";

      const oldTime = { day: current.day, hour: current.hour };
      if (totalHalfHours === 0) {
        return `Time unchanged. It is still ${describeTime(current)}.`;
      }

      const newTime = await db.time.advanceGameTime(totalHalfHours, args.reason ?? undefined);
      const totalHours = totalHalfHours / 2;
      // TODO: We may need to display time changes in console client.
      events.emitTimeUpdate(newTime.day, newTime.hour, totalHours);

      const parts: string[] = [];
      if (args.days && args.days > 0) parts.push(`${args.days} day(s)`);
      if (args.hours && args.hours > 0) {
        const h = args.hours;
        parts.push(Number.isInteger(h) ? `${h} hour(s)` : `${h} hours`);
      }
      return `${args.reason && args.reason.length > 0 ? "Time change reason successfully recorded. " : ""}Time advanced by ${parts.join(", ")}. It is now \`${describeTime(newTime)}\` (was \`${describeTime(oldTime)}\`).`;
    }, TOOL_NAMES.ADVANCE_TIME),
  });
}
