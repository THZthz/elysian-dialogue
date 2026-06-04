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
import { PLOT_STATUSES } from "@/server/db/models/plots";
import { wrapSafe } from "@/server/llm/tools/shared";
import { TOOL_NAMES } from "@/shared/constants";

const PLOT_ACTIONS = ["CREATE", "UPDATE", "DELETE"] as const;

// NB: .nullable() on optional fields prevents Zod rejection when the LLM
// outputs "field": null for fields it intends to omit.
const inputSchema = z.object({
  plotName: z.string().describe("Plot name (used as lookup key)."),
  action: z.enum(PLOT_ACTIONS).default("CREATE").describe("Action taken for the plot."),
  description: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Plot description. CREATE: required. UPDATE: optional (set to overwrite — should be rare). DELETE: omit.",
    ),
  brief: z.string().nullable().optional().describe("Short one-line summary of the plot."),
  status: z.enum(PLOT_STATUSES).nullable().optional().describe("Plot status."),
  triggerCondition: z
    .string()
    .nullable()
    .optional()
    .describe("One liner brief describing when will this plot get activated."),
  setFlag: z
    .object({ flagId: z.string(), description: z.string() })
    .nullable()
    .optional()
    .describe("Add or update flags on this plot."),
  removeFlags: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("Array of flag IDs to remove from this plot."),
  branchTo: z
    .string()
    .nullable()
    .optional()
    .describe(`Child plot \`name\` to connect via BRANCHES_TO.`),
  unbranch: z
    .string()
    .nullable()
    .optional()
    .describe(`Child plot \`name\` to disconnect from this plot.`),
});

export const editPlot: Tool<typeof inputSchema> = {
  name: TOOL_NAMES.EDIT_PLOT,
  description: `
## Brief
Manage narrative arcs — CREATE, UPDATE (partial overwrite), or DELETE a plot.

## Status flow
> PENDING → ACTIVE → COMPLETED / ABANDONED
Status transitions auto-wire scene relationships (STARTED_AT, COMPLETED_AT) to the active
Scene — just set the \`status\` parameter.

## Flags and branches
Use \`setFlag\` or \`removeFlags\` to track story milestones within a plot.
Use \`branchTo\` or \`unbranch\` to connect or disconnect child plots. A branch describes a course
of action or allegiance, not a single line of dialogue.
`.trim(),
  schema: inputSchema,
  execute: wrapSafe(async (args: z.infer<typeof inputSchema>) => {
    const db = Database.getExisting();

    if (!args.plotName) {
      return `ERROR: Parameter \`plotName\` should be included.`;
    }

    if (args.action == "CREATE") {
      if (!args.description)
        return `ERROR: Parameter \`description\` is required for action CREATE.`;
      await db.plots.create(
        args.plotName,
        args.description,
        args.brief ?? "",
        args.status ?? "PENDING",
        args.triggerCondition ?? undefined,
      );
      return `Plot "${args.plotName}" (status: ${args.status ?? "PENDING"}) is successfully created.`;
    }

    if (args.action == "DELETE") {
      const existing = await db.plots.getByName(args.plotName);
      if (!existing) return `ERROR: Plot "${args.plotName}" is not found.`;
      await db.plots.delete(args.plotName);
      return `Plot "${args.plotName}" is successfully deleted.`;
    }

    const existing = await db.plots.getByName(args.plotName);
    if (!existing) return `ERROR: Plot "${args.plotName}" is not found.`;

    const oldStatus = existing.status;
    const newStatus = (args.status ?? oldStatus) as typeof oldStatus;

    const changes: string[] = [];
    // != null catches both null and undefined (LLM may output null for omitted fields).
    if (args.description != null) changes.push("description");
    if (args.brief != null) changes.push("brief");
    if (args.status != null) changes.push(`status (${oldStatus} → ${newStatus})`);
    if (args.triggerCondition != null) changes.push("trigger condition");

    const updates: Record<string, unknown> = {};
    if (args.description != null) updates.description = args.description;
    if (args.brief != null) updates.brief = args.brief;
    if (args.status != null) updates.status = args.status;
    if (args.triggerCondition != null) updates.triggerCondition = args.triggerCondition;

    if (Object.keys(updates).length > 0) {
      await db.plots.update(args.plotName, updates as any);
    }

    // Auto-wire time relationships on status transition
    if (newStatus !== oldStatus) {
      if (oldStatus === "PENDING" && newStatus === "ACTIVE") {
        await db.plots.markPlotSceneRel(args.plotName, "STARTED_AT");
      } else if (newStatus === "COMPLETED") {
        await db.plots.markPlotSceneRel(args.plotName, "COMPLETED_AT");
      }
    }

    // Flag operations: setFlags replaces all flags, so batch changes.
    if (args.setFlag || (args.removeFlags && args.removeFlags.length > 0)) {
      let newFlags = [...existing.flags];
      if (args.setFlag) {
        const idx = newFlags.findIndex((f) => f.flagId === args.setFlag!.flagId);
        if (idx >= 0) {
          newFlags[idx] = { flagId: args.setFlag!.flagId, description: args.setFlag!.description };
        } else {
          newFlags.push({ flagId: args.setFlag!.flagId, description: args.setFlag!.description });
        }
        changes.push(`flag "${args.setFlag.flagId}"`);
      }
      if (args.removeFlags && args.removeFlags.length > 0) {
        newFlags = newFlags.filter((f) => !args.removeFlags!.includes(f.flagId));
        changes.push(`flags "${args.removeFlags.join(", ")}" removed`);
      }
      await db.plots.setFlags(
        args.plotName,
        newFlags.map((f) => f.flagId),
      );
    }

    if (args.branchTo) {
      changes.push(`branched to "${args.branchTo}"`);
      await db.plots.branch(args.plotName, args.branchTo);
    }
    if (args.unbranch) {
      changes.push(`unbranched "${args.unbranch}"`);
      await db.plots.unbranch(args.plotName, args.unbranch);
    }

    const summary = changes.length > 0 ? ` (${changes.join(", ")})` : "";
    return `Plot "${args.plotName}" is successfully updated${summary}.`;
  }, TOOL_NAMES.EDIT_PLOT),
};
