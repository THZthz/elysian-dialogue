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
import { getMemoryClient, MemoryClient, PLOT_STATUSES } from "@/server/memory/client";
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
  status: z
    .enum(PLOT_STATUSES)
    .nullable()
    .optional()
    .describe("Plot status."),
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
  removeFlags: z.array(z.string()).nullable().optional().describe("Array of flag IDs to remove from this plot."),
  branchTo: z
    .string()
    .nullable()
    .optional()
    .describe("Child plot \`name\` to connect via BRANCHES_TO."),
  unbranch: z
    .string()
    .nullable()
    .optional()
    .describe("Child plot \`name\` to disconnect from this plot."),
});

export const editPlot = tool({
  title: TOOL_NAMES.EDIT_PLOT,
  description: `
## Brief
Manage narrative arcs — CREATE, UPDATE (partial overwrite), or DELETE a plot.

## Status flow
> PENDING → ACTIVE → COMPLETED / ABANDONED
Status transitions auto-wire time relationships (STARTED_AT, ACTIVE_AT, COMPLETED_AT) to the current
TimePoint — just set the \`status\` parameter.

## Flags and branches
Use \`setFlag\` or \`removeFlags\` to track story milestones within a plot.
Use \`branchTo\` or \`unbranch\` to connect or disconnect child plots. A branch describes a course
of action or allegiance, not a single line of dialogue.
`.trim(),
  inputSchema,
  execute: wrapSafe(async (args: z.infer<typeof inputSchema>) => {
    const client = getMemoryClient();

    if (!args.plotName) {
      return `ERROR: Parameter \`plotName\` should be included.`;
    }

    if (args.action == "CREATE") {
      if (!args.description) return `ERROR: Parameter \`description\` is required for action CREATE.`;
      const plot = await client.plots.createPlot(args.plotName, {
        description: args.description,
        brief: args.brief ?? undefined,
        status: args.status ?? "PENDING",
        triggerCondition: args.triggerCondition ?? undefined,
      });
      return `Plot "${plot.name}" (status: ${plot.status}) is successfully created.`;
    }

    if (args.action == "DELETE") {
      const deleted = await client.plots.deletePlot(args.plotName);
      return deleted
        ? `Plot "${args.plotName}" is successfully deleted.`
        : `ERROR: Plot "${args.plotName}" is not found.`;
    }

    const existing = await client.plots.getPlot(args.plotName);
    if (!existing) return `ERROR: Plot "${args.plotName}" is not found.`;

    const oldStatus = existing.status;
    const newStatus = (args.status ?? oldStatus) as typeof oldStatus;

    const changes: string[] = [];
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
      await client.plots.updatePlot(args.plotName, updates as any);
    }

    // Auto-wire time relationships on status transition
    if (newStatus !== oldStatus) {
      if (oldStatus === "PENDING" && newStatus === "ACTIVE") {
        await client.plots.markPlotStarted(args.plotName);
        await client.plots.markPlotActive(args.plotName);
      } else if (newStatus === "ACTIVE" && oldStatus !== "ACTIVE") {
        await client.plots.markPlotActive(args.plotName);
      } else if (newStatus === "COMPLETED") {
        await client.plots.markPlotCompleted(args.plotName);
      }
    }

    if (args.setFlag) {
      changes.push(`flag "${args.setFlag.flagId}"`);
      await client.plots.setFlag(args.plotName, args.setFlag.flagId, args.setFlag.description);
    }
    if (args.removeFlags && args.removeFlags.length > 0) {
      changes.push(`flag "${args.removeFlags.join(", ")}" removed`);
      await client.plots.removeFlags(args.plotName, args.removeFlags);
    }
    if (args.branchTo) {
      changes.push(`branched to "${args.branchTo}"`);
      await client.plots.branchTo(args.plotName, args.branchTo);
    }
    if (args.unbranch) {
      changes.push(`unbranched "${args.unbranch}"`);
      await client.plots.unbranch(args.plotName, args.unbranch);
    }

    const summary = changes.length > 0 ? ` (${changes.join(", ")})` : "";
    return `Plot "${args.plotName}" is successfully updated${summary}.`;
  }, TOOL_NAMES.EDIT_PLOT),
});
