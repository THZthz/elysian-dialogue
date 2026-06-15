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

const AUTO_LIMIT = 50;

function stripHiddenProperties(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (!k.startsWith("_")) out[k] = v;
    }
    return out;
  });
}

function extractLabels(query: string): string[] {
  const labels = new Set<string>();
  const re = /:`?([A-Za-z_][A-Za-z0-9_]*)`?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    labels.add(m[1]);
  }
  return [...labels];
}

const inputSchema = z.object({
  action: z
    .enum(["READ", "WRITE"])
    .default("READ")
    .describe("READ to query the world, WRITE to modify it."),
  query: z
    .string()
    .describe(
      "A Cypher query. READ: MATCH...RETURN. WRITE: CREATE, MERGE, SET, DELETE. Must include MATCH with WHERE for deletions.",
    ),
});

export const queryWorld: Tool<typeof inputSchema> = {
  name: TOOL_NAMES.QUERY_WORLD,
  description: `
## Brief
READ or WRITE the world archive using Cypher.

READ — MATCH...RETURN. Use READ for: entities at other locations, message history, scene history, or entity details not shown in the scene context. Auto-limited to 50 rows.

WRITE — CREATE, MERGE, SET, DELETE. The archive IS the world — if you don't WRITE it, it didn't happen. Every world mutation you narrate MUST be persisted. Use MERGE for upserts, SET for property updates, DETACH DELETE for removal. Must include WHERE when deleting. Register new types via manageSchema before creating nodes/relationships with new types in your Cypher.

Internal properties prefixed with "_" are hidden from READ results.

## Forbidden
- Do not call this tool multiple times when the queries are similar in structure, combine queries.
`.trim(),
  schema: inputSchema,
  execute: wrapSafe(async (args: z.infer<typeof inputSchema>) => {
    const db = Database.getExisting();

    if (args.action === "WRITE") {
      // Validate labels exist in schema before executing
      const labels = extractLabels(args.query);
      const allNodeTypes = db.schema.getAllNodeTypes();
      const knownLabels = new Set(allNodeTypes.map((n) => n.name));
      const unknownLabels = labels.filter((l) => !knownLabels.has(l));
      if (unknownLabels.length > 0) {
        return (
          `SCHEMA ERROR: Unknown label(s): ${unknownLabels.join(", ")}. ` +
          `Register new types via manageSchema before creating nodes or relationships with those labels.`
        );
      }

      try {
        const result = await db.graph.query(args.query);
        return `Success. ${result.rows.length} row(s) affected.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `QUERY ERROR:\n${msg}.\nAdjust your query and retry.`;
      }
    }

    // READ
    let query = args.query.trim();
    if (!/\bLIMIT\b/i.test(query)) {
      query = `${query} LIMIT ${AUTO_LIMIT}`;
    }

    try {
      const result = await db.graph.query(query);
      const safeRows = stripHiddenProperties(result.rows);
      return JSON.stringify({ rowCount: safeRows.length, rows: safeRows }, null, 2);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `QUERY ERROR:\n${msg}.\nAdjust your query and retry.`;
    }
  }, TOOL_NAMES.QUERY_WORLD),
};
