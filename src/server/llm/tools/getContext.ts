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
import { TOOL_NAMES } from "@/shared/constants";
import { wrapSafe } from "@/server/llm/tools/shared";
import {
  buildCharactersBrief,
  buildLocationsBrief,
  buildObjectsBrief,
  buildPlotsBrief,
  buildRelationshipDump,
  buildScenesBrief,
  buildTimeline,
  buildEntityProfile,
} from "@/server/llm/sceneContext";
import { Database } from "@/server/db";
import { SchemaRegistry } from "@/server/db/schema";

const CONTEXT_TYPES = [
  "CHARACTERS_BRIEF",
  "LOCATIONS_BRIEF",
  "OBJECTS_BRIEF",
  "PLOTS_BRIEF",
  "SCENES_BRIEF",
  "SCHEMA_DUMP",
  "RELATIONSHIP_DUMP",
  "TIMELINE",
  "ENTITY_PROFILE",
  "CYPHER_COOKBOOK",
] as const;

const CYPHER_COOKBOOK_PROMPT = `
## CYPHER COOKBOOK

### Mental Model

LadybugDB uses a **structured property graph model** — schema-first, strongly-typed Cypher. Think "PostgreSQL with graph traversal": every node label and relationship type must be registered as a table before data can be inserted.

### Tool-to-Cypher Mapping

| Tool | Maps to | Use for |
|------|---------|---------|
| \`${TOOL_NAMES.MANAGE_NODE}\` | READ / UPSERT / DELETE | Single-node READ, UPSERT, or DELETE. Handles JSON partial merge, embeddings, and schema validation automatically. |
| \`${TOOL_NAMES.MANAGE_RELATIONSHIP}\` | READ / UPSERT | Single-relationship READ or UPSERT. Auto-sets temporal props (\`created_at\`, \`valid_at\`) on create, JSON partial merge on update. |
| \`${TOOL_NAMES.MANAGE_SCHEMA}\` | CREATE NODE/REL TABLE | Register new node labels and relationship types before use. Generates the DDL. |
| \`${TOOL_NAMES.QUERY_WORLD}\` | Raw Cypher | Multi-hop traversals, aggregations, bulk operations, or anything spanning multiple nodes/rels. |
| \`${TOOL_NAMES.GET_CONTEXT}\` (SCHEMA_DUMP) | — | Discover registered types, property schemas, and tags. |
| \`${TOOL_NAMES.SEARCH_WORLD}\` | — | Hybrid vector search (dense + sparse + rerank). Not Cypher-based. |

**Prefer \`${TOOL_NAMES.MANAGE_NODE}\` and \`${TOOL_NAMES.MANAGE_RELATIONSHIP}\`** for single-entity read/mutations — they handle embedding updates, JSON partial merge, and schema validation automatically. Reach for \`${TOOL_NAMES.QUERY_WORLD}\` when you need traversals, aggregations, or multi-node operations.

### Property Conventions
- \`brief\` is for one-liners, \`description\` is for full text. Default to brief to save context — fetch description when you need detail.
- SEARCH BROADLY FIRST, then drill into specific entities.

### Label & Relationship Conventions
- Node labels are **PascalCase**: Character, Object, Location, Note, Plot, Disposition, Scene, plus any GM-defined labels.
- Relationship types are **UPPER_SNAKE**: LOCATED_AT, CARRIES, ABOUT_CHARACTER, ABOUT_OBJECT, ABOUT_LOCATION, HAS_DISPOSITION, BRANCHES_TO, etc.
- There is **no multi-label syntax** — each node has exactly one label.

### Schema
- For new types, call \`${TOOL_NAMES.MANAGE_SCHEMA}\` first — it creates the actual node/relationship tables.
- Properties tagged \`json\` receive automatic partial merge on update in both \`${TOOL_NAMES.MANAGE_NODE}\` and \`${TOOL_NAMES.MANAGE_RELATIONSHIP}\`.

### Query Rules

**Pattern Matching:**
- For shortest path: \`MATCH (a)-[r* SHORTEST 1..10]->(b)\`. For all shortest: \`ALL SHORTEST\`.
- LadybugDB uses **walk semantics** (repeated edges allowed). Use \`is_trail()\` or \`is_acyclic()\` to constrain.
- \`WHERE\` must be a separate clause — not inside node/relationship patterns. Label filters in WHERE must use \`label(n) = '...'\`, not \`n:Label\`.

**Mutations:**
- When deleting or transferring a relationship that may not exist, use OPTIONAL MATCH; otherwise the query silently fails.
- For unique relationships (e.g. LOCATED_AT), use MERGE or delete old before creating new.
- For character attitudes, use Disposition **nodes** linked via HAS_DISPOSITION, not relationship properties.
- Use MERGE for idempotent entity creation.
- \`DETACH DELETE\` removes relationships but does NOT cascade to nodes referencing the deleted entity by name string. Clean up dangling references manually.
- \`SET n.prop = NULL\` to remove a property; \`REMOVE\` is not supported.
- \`FOREACH\` is not supported — use \`UNWIND\` instead.

**Functions & Types (LadybugDB vs Neo4j):**
- \`id()\` not \`elementId()\`. \`label()\` not \`labels()\`. \`current_timestamp()\` not \`datetime()\`.
- Type check: \`typeOf(x) = INT64\` (not \`x IS :: INTEGER\`).
- Vector similarity: \`ARRAY_COSINE_SIMILARITY()\` and \`ARRAY_DISTANCE()\`.
- List functions use \`list_\` prefix: \`list_concat\`, \`list_reverse\`, \`list_slice\`.
- Cast: \`cast(value, 'TYPE')\` instead of \`toXXX()\`.
- No APOC procedures. \`SHOW XXX\` → \`CALL show_xxx() RETURN *\`.
- Subqueries: \`EXISTS { }\` and \`COUNT { }\` are supported. \`CALL <subquery>\` is not.
- Aggregate extras: \`percentileCont\`, \`percentileDisc\`, \`stDev\`, \`stDevP\` are available.

**Expressions & Common Patterns:**
- **NULL semantics:** \`null = null\` returns \`NULL\` (not \`true\`), and \`WHERE\` drops \`NULL\` rows. Always use \`IS NULL\` / \`IS NOT NULL\` to test for nulls. Any comparison with \`NULL\` yields \`NULL\` — this is a silent query killer.
- **Implicit GROUP BY:** Cypher has no \`GROUP BY\` keyword. Whatever non-aggregated columns are in \`RETURN\` or \`WITH\` become the grouping key. Adding an extra column changes the groups.
- **WITH chains results:** Use \`WITH\` to pass and reshape results between query stages — accumulate counts, filter aggregates, or isolate \`OPTIONAL MATCH\` scopes. \`WITH c, count(d) AS cnt WHERE cnt > 0 RETURN c.name, cnt\`.
- **Text matching:** \`STARTS WITH\`, \`ENDS WITH\`, \`CONTAINS\` for substring tests. \`=~\` for POSIX regex: \`WHERE n.name =~ '(?i)alice.*'\`.
- **Pattern predicates in WHERE:** \`WHERE NOT (n)-[:NEXT_MESSAGE]->(:Message)\` finds nodes missing a relationship. Powerful for tail-of-list, missing-links, and absence checks.
- **CASE:** \`CASE WHEN n.age < 18 THEN 'minor' ELSE 'adult' END\` for conditional values.
- **COALESCE:** \`COALESCE(n.name, n.uid)\` returns the first non-null value.
- **collect():** Aggregates values into a list — \`RETURN a.name, collect(b.name) AS friends\`.
- **DISTINCT:** \`RETURN DISTINCT label(n)\` or \`count(DISTINCT n)\`.
- **UNION / UNION ALL:** Combine results from multiple \`MATCH\` blocks with the same column signature.
- **Graph functions:** \`label(n)\` returns the node's label string, \`type(r)\` returns the relationship type string, \`nodes(p)\` / \`rels(p)\` extract nodes/rels from a path, \`length(p)\` returns hop count.
- **Path modifiers (on the pattern itself):** Use \`TRAIL\` for distinct edges, \`ACYCLIC\` for distinct nodes: \`(a)-[:Follows* TRAIL 1..5]->(b)\`. Default is walk (repeated edges allowed).

---

`;

type ContextType = (typeof CONTEXT_TYPES)[number];

async function buildSchemaDump(): Promise<string> {
  const db = Database.getExisting();
  const schema = SchemaRegistry.getInstance();
  const internalNames = new Set(schema.getInternalTypeNames());

  // ── Node types from SchemaRegistry (in-memory) ──
  const nodeTypes = schema
    .getAllNodeTypes()
    .filter((n) => !internalNames.has(n.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── Relationship types from SchemaRegistry (in-memory) ──
  const relTypes = schema
    .getAllRelTypes()
    .filter((r) => !r.name.startsWith("_"))
    .sort((a, b) => {
      const srcCmp = (a.sourceLabel || "").localeCompare(b.sourceLabel || "");
      if (srcCmp !== 0) return srcCmp;
      const tgtCmp = (a.targetLabel || "").localeCompare(b.targetLabel || "");
      if (tgtCmp !== 0) return tgtCmp;
      return a.name.localeCompare(b.name);
    });

  // ── Pre-fetch counts per table (no UNWIND — LadybugDB compatible) ──
  const counts: Record<string, number> = {};
  for (const nt of nodeTypes) {
    try {
      const r = await db.graph.query(`MATCH (n:\`${nt.name}\`) RETURN count(n) AS cnt`);
      counts[nt.name] = (r.rows[0]?.cnt as number) ?? 0;
    } catch {
      counts[nt.name] = 0;
    }
  }
  for (const rt of relTypes) {
    try {
      const r = await db.graph.query(`MATCH ()-[r:\`${rt.name}\`]->() RETURN count(r) AS cnt`);
      counts[rt.name] = (r.rows[0]?.cnt as number) ?? 0;
    } catch {
      counts[rt.name] = 0;
    }
  }

  const lines: string[] = [];
  lines.push(`## Schema (from registry by \`${TOOL_NAMES.MANAGE_SCHEMA}\`)`);
  lines.push("");
  lines.push(
    "A list of nodes/relationships, with their counts in database, list of properties. Tags of the property is displayed before its name.",
  );
  lines.push("");

  // ── Node types ──
  lines.push("### Node Types");
  lines.push("");
  for (let idx = 0; idx < nodeTypes.length; idx++) {
    const node = nodeTypes[idx];
    const count = counts[node.name];
    const qty = count !== undefined ? `(×${count})` : "(×0)";
    const category = node.category as string;
    lines.push(`${idx + 1}. **${node.name}** ${qty} ${category}: ${node.description}`);
    if (node.properties.length > 0) {
      const visible = node.properties.filter((p) => !p.name.startsWith("_"));
      for (const prop of visible) {
        const tagStr = prop.tags.length > 0 ? ` (${prop.tags.join(", ")})` : "";
        lines.push(`  -${tagStr} \`${prop.name}\`: ${prop.description}`);
      }
    }
    lines.push("");
  }

  // ── Relationship types ──
  lines.push("### Relationship Types");
  lines.push("");
  for (let idx = 0; idx < relTypes.length; idx++) {
    const rel = relTypes[idx];
    const count = counts[rel.name];
    const qty = count !== undefined ? ` (×${count})` : "";
    const src = rel.sourceLabel || "?";
    const tgt = rel.targetLabel || "?";
    const category = rel.category as string;
    lines.push(`${idx + 1}. **${rel.name}**${qty} (${src}→${tgt}) ${category}: ${rel.description}`);
    if (rel.properties.length > 0) {
      const visible = rel.properties.filter((p) => !p.name.startsWith("_"));
      for (const prop of visible) {
        const tagStr = prop.tags.length > 0 ? ` (${prop.tags.join(", ")})` : "";
        lines.push(`  -${tagStr} \`${prop.name}\`: ${prop.description}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

const inputSchema = z.object({
  types: z.array(z.enum(CONTEXT_TYPES)).describe("Which context sections to return."),
  relationshipHistory: z
    .boolean()
    .optional()
    .describe(
      "For RELATIONSHIP_DUMP: when true, shows all relationships including expired with time ranges.",
    ),
  entityName: z
    .string()
    .optional()
    .describe("For ENTITY_PROFILE: the name of the entity to profile."),
  entityLabel: z
    .string()
    .optional()
    .describe(
      "For ENTITY_PROFILE: the label of the entity to profile (e.g. 'Character', 'Object').",
    ),
});

export const getContext: Tool<typeof inputSchema> = {
  name: TOOL_NAMES.GET_CONTEXT,
  description: `
## Brief
Pull pre-built context from the world. Nothing is auto-loaded — you choose what you need.

## Types
- **SCHEMA_DUMP** — Rather important. All registered node types (with full property schemas: names, counts, tags, descriptions) and relationship types (with endpoint constraints and property schemas) in the database. Managed by \`${TOOL_NAMES.MANAGE_SCHEMA}\`.
- CHARACTERS_BRIEF — All characters with location.
- LOCATIONS_BRIEF — All locations with brief descriptions.
- OBJECTS_BRIEF — All objects with carrier or location.
- PLOTS_BRIEF — All plots with status, brief, and flags.
- SCENES_BRIEF — All scenes ordered by time, with location, characters, and transition reason.
- RELATIONSHIP_DUMP — All active relationships grouped by type. LOCATED_AT/LOCATED_IN are grouped by location showing occupants and access details.
- TIMELINE — Chronological log of all temporal relationship changes (created/expired), most recent first.
- ENTITY_PROFILE — Everything about one node: properties, location, carried items, dispositions, notes, scene appearances, and relationship history. Requires entityName + entityLabel.
- CYPHER_COOKBOOK - The graph database is LadybugDB, its Cypher syntax is slightly different from most used database Neo4j.
`.trim(),
  schema: inputSchema,
  execute: wrapSafe(
    async (args: {
      types: ContextType[];
      relationshipHistory?: boolean;
      entityName?: string;
      entityLabel?: string;
    }) => {
      if (args.types.includes("ENTITY_PROFILE")) {
        if (!args.entityName || !args.entityLabel) {
          return "ERROR: entityName and entityLabel are required when ENTITY_PROFILE is requested.";
        }
      }
      const sections: ContextType[] = args.types.length > 0 ? args.types : [];

      const builders: Record<ContextType, () => Promise<string>> = {
        CHARACTERS_BRIEF: buildCharactersBrief,
        LOCATIONS_BRIEF: buildLocationsBrief,
        OBJECTS_BRIEF: buildObjectsBrief,
        PLOTS_BRIEF: buildPlotsBrief,
        SCENES_BRIEF: buildScenesBrief,
        SCHEMA_DUMP: buildSchemaDump,
        RELATIONSHIP_DUMP: () => buildRelationshipDump(!!(args as any).relationshipHistory),
        TIMELINE: buildTimeline,
        ENTITY_PROFILE: () => {
          const extra = args as any;
          return buildEntityProfile(extra.entityName, extra.entityLabel);
        },
        CYPHER_COOKBOOK: async () => {
          return CYPHER_COOKBOOK_PROMPT;
        },
      };

      const tasks: Promise<void>[] = [];
      const results: string[] = [];
      for (let i = 0; i < sections.length; i++) {
        const type = sections[i];
        tasks.push(
          builders[type]()
            .then((section) => {
              results[i] = section;
            })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              results[i] = `## ${type}\n\nError: ${msg}\n`;
            }),
        );
      }

      await Promise.all(tasks);

      return results.join("\n");
    },
    TOOL_NAMES.GET_CONTEXT,
  ),
};
