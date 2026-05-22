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
import { getMemoryClient, MemoryClient } from "@/server/memory/client";
import { stripHiddenProperties } from "@/server/memory/neo4j";
import { wrapSafe } from "@/server/llm/tools/shared";
import { TOOL_NAMES } from "@/shared/constants";
import { NodeDef, getNodeManager } from "@/server/nodeManager";
import { RelationshipDef, RelationshipManager } from "@/server/relationshipManager";

function getVectorSearchable(type: "relationship" | "label"): {
  canonical: Set<string>;
  labelToCanonical: Map<string, string>;
} {
  const all: RelationshipDef[] | NodeDef[] = (
    type === "relationship"
      ? RelationshipManager.getCachedInstance()
      : getNodeManager()
  )
    .getAll()
    .filter((def) =>
      def.properties.some(
        (p) => p.tags.includes("embedded_name") || p.tags.includes("embedded_content"),
      ),
    );

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
  // must be independently searchable (each has its own Qdrant node_type).
  for (const name of ["Character", "Object", "Location"]) {
    if (labelToCanonical.has(name) && labelToCanonical.get(name) !== name) {
      canonical.delete(name);
      canonical.add(name);
      labelToCanonical.set(name, name);
    }
  }

  return { canonical, labelToCanonical };
}

export const searchWorld = tool({
  title: TOOL_NAMES.SEARCH_WORLD,
  description: `
## Brief
Search the archive by semantic MEANING (vector similarity search with reranking).

Use 'target' to restrict to only nodes or only relationships. Pass one or more domains (node labels
or relationship types) via 'domains' to scope the search (e.g. ["Character", "Location", "Message"], ["LOCATED_AT"]).
Omit to search all searchable types.

Search your notes at the start of every turn with domains: ["Note"].

## Forbidden
Do not combine multiple search attempts into a single call.
Do not forget to use parameter \`limit\` wisely, if the search should be exact, set it to 1.
`.trim(),
  inputSchema: z.object({
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
        "Node labels or relationship types to search (e.g. ['Character', 'Location', 'Message', 'ALLIED_WITH']). Omit to search all searchable types.",
      ),
    limit: z.number().default(3).describe("Max results per domain."),
  }),
  execute: wrapSafe(async (args) => {
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

    const client = getMemoryClient();
    const result: Record<string, Record<string, unknown>[]> = {};

    const tasks: Promise<void>[] = [];

    for (const label of nodeDomains) {
      tasks.push(
        client.search.searchByLabel(label, args.query, { limit: args.limit }).then((rows) => {
          result[label] = stripHiddenProperties(rows) as Record<string, unknown>[];
        }),
      );
    }

    for (const type of relDomains) {
      tasks.push(
        client.search
          .searchByRelationshipType(type, args.query, { limit: args.limit })
          .then((rows) => {
            result[type] = stripHiddenProperties(rows) as Record<string, unknown>[];
          }),
      );
    }

    await Promise.all(tasks);

    return JSON.stringify(result, null, 2);
  }, TOOL_NAMES.SEARCH_WORLD),
});
