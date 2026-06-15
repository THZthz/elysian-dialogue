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
import { SchemaRegistry } from "@/server/db/schema";
import { wrapSafe } from "@/server/llm/tools/shared";
import { TOOL_NAMES } from "@/shared/constants";
import type { NodeTypeDef, RelTypeDef } from "@/server/db/schema";

function stripHidden(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith("_")) {
      out[k] = v;
    }
  }
  return out;
}

function getVectorSearchable(type: "relationship" | "label"): {
  canonical: Set<string>;
  labelToCanonical: Map<string, string>;
} {
  const schema = SchemaRegistry.getInstance();
  const all: RelTypeDef[] | NodeTypeDef[] =
    type === "relationship"
      ? schema.getVectorSearchableRelTypes()
      : schema.getVectorSearchableNodeTypes();

  // Filter out subtype labels: labels whose property definitions (names + tags)
  // are identical to another label's — they share the same vector index.
  const seen = new Map<string, string>(); // property-fingerprint → first label name
  const labelToCanonical = new Map<string, string>();
  const canonical = new Set<string>();
  for (const def of all) {
    const fingerprint = def.properties
      .map((p) => `${p.name}:${[...p.tags].sort().join(",")}`)
      .sort()
      .join("|");
    const existing = seen.get(fingerprint);
    if (existing === undefined) {
      seen.set(fingerprint, def.name);
      canonical.add(def.name);
      labelToCanonical.set(def.name, def.name);
    } else {
      labelToCanonical.set(def.name, existing);
    }
  }

  // Character, Object, Location share the same property fingerprint but
  // must be independently searchable (each has its own vector store entry).
  for (const name of ["Character", "Object", "Location"]) {
    if (labelToCanonical.has(name) && labelToCanonical.get(name) !== name) {
      canonical.delete(name);
      canonical.add(name);
      labelToCanonical.set(name, name);
    }
  }

  return { canonical, labelToCanonical };
}

const inputSchema = z.object({
  query: z
    .string()
    .describe(
      "Natural language search query, usually a few keywords. Keep short and focus on the same topic.",
    ),
  target: z
    .array(z.enum(["NODE", "RELATIONSHIP"]))
    .default(["NODE", "RELATIONSHIP"])
    .describe("Search nodes, relationships, or both. Defaults to both."),
  domains: z
    .array(z.string())
    .optional()
    .describe(
      "Node labels or relationship types to search (e.g. ['Character', 'Location', 'Message', 'CHARACTER_AT']). Omit to search all searchable types.",
    ),
  limit: z.number().default(3).describe("Max results per domain."),
});

export const searchWorld: Tool<typeof inputSchema> = {
  name: TOOL_NAMES.SEARCH_WORLD,
  description: `Semantic vector search with reranking. Prefer \`${TOOL_NAMES.QUERY_WORLD}\` for structured queries. Use \`target\` to restrict to NODE or RELATIONSHIP. Pass \`domains\` to scope by type (e.g. ["Character", "Location"]). Omit to search all. Set \`limit\` to 1 for exact lookups.`,
  schema: inputSchema,
  execute: wrapSafe(async (args: z.infer<typeof inputSchema>) => {
    const target = args.target ?? ["NODE", "RELATIONSHIP"];
    const searchNodes = target.includes("NODE");
    const searchRels = target.includes("RELATIONSHIP");

    const nodeSearchable = searchNodes
      ? getVectorSearchable("label")
      : { canonical: new Set<string>(), labelToCanonical: new Map<string, string>() };
    const relSearchable = searchRels
      ? getVectorSearchable("relationship")
      : { canonical: new Set<string>(), labelToCanonical: new Map<string, string>() };

    // Resolve domains: filter user-provided values to what's searchable.
    // If none provided, use all canonical (non-subtype) node labels and relationship types.
    // Character, Object, Location are independent searchable domains.
    const nodeDomains: string[] = [];
    const relDomains: string[] = [];

    if (args.domains && args.domains.length > 0) {
      for (const d of args.domains) {
        const canonicalNode = searchNodes ? nodeSearchable.labelToCanonical.get(d) : undefined;
        const isRel = searchRels ? relSearchable.canonical.has(d) : false;
        if (!canonicalNode && !isRel) {
          const available = [...nodeSearchable.canonical, ...relSearchable.canonical].join(", ");
          return `ERROR: "${d}" is not a searchable node label or relationship type. Available: ${available}`;
        }
        if (canonicalNode && searchNodes) nodeDomains.push(canonicalNode);
        if (isRel && searchRels) relDomains.push(d);
      }
    } else {
      // Search all labels and relationships.
      if (searchNodes) nodeDomains.push(...nodeSearchable.canonical);
      if (searchRels) relDomains.push(...relSearchable.canonical);
    }

    const db = Database.getExisting();
    const result: Record<string, Record<string, unknown>[]> = {};
    const tasks: Promise<void>[] = [];

    for (const label of nodeDomains) {
      tasks.push(
        db.search
          .search({ domain: label, kind: "node", query: args.query, limit: args.limit })
          .then((rows) => {
            result[label] = rows.map((r) => stripHidden(r as Record<string, unknown>));
          }),
      );
    }

    for (const type of relDomains) {
      tasks.push(
        db.search
          .search({ domain: type, kind: "relationship", query: args.query, limit: args.limit })
          .then((rows) => {
            result[type] = rows.map((r) => stripHidden(r as Record<string, unknown>));
          }),
      );
    }

    await Promise.all(tasks);

    return JSON.stringify(result, null, 2);
  }, TOOL_NAMES.SEARCH_WORLD),
};
