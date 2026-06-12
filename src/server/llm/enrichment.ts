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

import { Database } from "@/server/db";
import { logger } from "@/server/logger";
import { getSchemaRegistry } from "@/server/db/schema";
import { TOOL_NAMES } from "@/shared/constants";

// ── Types ──

type Enricher = (args: string, result: string) => Promise<string>;

// ── Timeout wrapper ──

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Enrichment query timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

// ── Helpers ──

function buildWhereClause(match: Record<string, string>): {
  where: string;
  params: Record<string, unknown>;
} {
  const params: Record<string, unknown> = {};
  const parts = Object.entries(match).map(([key, value], i) => {
    const pName = `mk${i}`;
    params[pName] = value;
    return `n.\`${key}\` = $${pName}`;
  });
  return { where: parts.join(" AND "), params };
}

interface EnrichmentRow {
  dir: string;
  relType: string;
  otherLabel: string;
  otherName: string;
  otherBrief: string | null;
}

interface EntityBatchEntry {
  label: string;
  key: string;
  value: string;
}

async function querySingleEntity(
  db: Database,
  label: string,
  match: Record<string, string>,
): Promise<EnrichmentRow[]> {
  const { where, params } = buildWhereClause(match);
  const isCharacter = label === "Character";
  const registry = getSchemaRegistry();
  const allTypes = registry.getAllRelTypes();
  const temporalTypes = new Set(
    allTypes.filter((t) => registry.isTemporalRelType(t)).map((t) => t.name),
  );

  // Build per-type UNION branches to avoid using type(r), which is unavailable
  // in the current LadybugDB version.
  const branches: string[] = [];

  for (const t of allTypes) {
    const safeName = t.name.replace(/'/g, "''");
    const validAtFilter = temporalTypes.has(t.name) ? " AND r.valid_at IS NULL" : "";

    // Outgoing: entity's label matches sourceLabel
    if (t.sourceLabel === label) {
      branches.push(
        `MATCH (n:\`${label}\`) WHERE ${where}
         MATCH (n)-[r:\`${t.name}\`]->(m) WHERE 1=1${validAtFilter}
         RETURN 'out' AS dir, '${safeName}' AS relType, label(m) AS otherLabel,
                COALESCE(m.name, CAST(m._uid, 'STRING')) AS otherName, m.brief AS otherBrief`,
      );
    }

    // Incoming: entity's label matches targetLabel
    if (t.targetLabel === label) {
      branches.push(
        `MATCH (n:\`${label}\`) WHERE ${where}
         MATCH (m)-[r:\`${t.name}\`]->(n) WHERE 1=1${validAtFilter}
         RETURN 'in' AS dir, '${safeName}' AS relType, label(m) AS otherLabel,
                COALESCE(m.name, CAST(m._uid, 'STRING')) AS otherName, m.brief AS otherBrief`,
      );
    }
  }

  if (isCharacter) {
    branches.push(
      `MATCH (n:\`${label}\`) WHERE ${where}
       MATCH (n)-[:HAS_DISPOSITION]->(d:Disposition)
       RETURN 'disp' AS dir, d.sentiment AS relType, 'Character' AS otherLabel,
              d.target_name AS otherName, d.summary AS otherBrief`,
    );
  }

  if (branches.length === 0) return [];

  const query = branches.join("\nUNION\n");
  const result = await withTimeout(db.graph.query(query, params), 2000);
  return result.rows as unknown as EnrichmentRow[];
}

function formatEntityContext(rows: EnrichmentRow[], entityName: string): string {
  if (rows.length === 0) return "";

  const outRels = rows.filter((r) => r.dir === "out");
  const inRels = rows.filter((r) => r.dir === "in");
  const disps = rows.filter((r) => r.dir === "disp");

  // Count-based summarization: expand ≤3 per type, summarize >3
  function summarize(rels: EnrichmentRow[]): string {
    const byType = new Map<string, EnrichmentRow[]>();
    for (const r of rels) {
      const group = byType.get(r.relType) || [];
      group.push(r);
      byType.set(r.relType, group);
    }

    const clauses: string[] = [];
    for (const [type, group] of byType) {
      if (group.length <= 3) {
        for (const r of group) {
          clauses.push(`${type} ${r.otherName}`);
        }
      } else {
        const shown = group
          .slice(0, 3)
          .map((r) => r.otherName)
          .join(", ");
        clauses.push(`${type} ${shown}, ${type}(${group.length - 3} more)`);
      }
    }
    return clauses.join(", ");
  }

  const parts: string[] = [];

  if (outRels.length > 0) {
    parts.push(`${entityName} is ${summarize(outRels)}.`);
  }

  if (inRels.length > 0) {
    const byType = new Map<string, EnrichmentRow[]>();
    for (const r of inRels) {
      const list = byType.get(r.relType) || [];
      list.push(r);
      byType.set(r.relType, list);
    }
    const inClauses: string[] = [];
    for (const [type, group] of byType) {
      if (group.length <= 3) {
        for (const r of group) {
          inClauses.push(`${r.otherName} is ${type} ${entityName}`);
        }
      } else {
        const shown = group
          .slice(0, 3)
          .map((r) => r.otherName)
          .join(", ");
        inClauses.push(`${shown} and ${group.length - 3} others are ${type} ${entityName}`);
      }
    }
    if (inClauses.length > 0) {
      parts.push(`${inClauses.join(", ")} (incoming).`);
    }
  }

  let output = "";
  if (parts.length > 0) {
    output = `\n[Context] ${parts.join(" ")}`;
  }

  if (disps.length > 0) {
    for (const d of disps) {
      const detail = d.otherBrief ? ` — "${d.otherBrief}"` : "";
      output += `\n[Disposition] ${d.relType} toward ${d.otherName}${detail}.`;
    }
  }

  return output;
}

async function queryEntityRelationships(
  db: Database,
  name: string,
  label: string,
): Promise<Array<{ relType: string; targetName: string }>> {
  const registry = getSchemaRegistry();
  const allTypes = registry.getAllRelTypes();
  const temporalTypes = new Set(
    allTypes.filter((t) => registry.isTemporalRelType(t)).map((t) => t.name),
  );

  const escapedLabel = label.replace(/`/g, "``");
  const branches: string[] = [];
  for (const t of allTypes) {
    const safeName = t.name.replace(/'/g, "''");
    const validAtFilter = temporalTypes.has(t.name) ? " AND r.valid_at IS NULL" : "";
    if (t.sourceLabel === label) {
      branches.push(
        `MATCH (n:\`${escapedLabel}\`) WHERE n.name = $val MATCH (n)-[r:\`${t.name}\`]->(m) WHERE 1=1${validAtFilter} RETURN '${safeName}' AS relType, COALESCE(m.name, CAST(m._uid, 'STRING')) AS targetName`,
      );
    }
    if (t.targetLabel === label) {
      branches.push(
        `MATCH (n:\`${escapedLabel}\`) WHERE n.name = $val MATCH (m)-[r:\`${t.name}\`]->(n) WHERE 1=1${validAtFilter} RETURN '${safeName}' AS relType, COALESCE(m.name, CAST(m._uid, 'STRING')) AS targetName`,
      );
    }
  }

  if (branches.length === 0) return [];
  const result = await withTimeout(
    db.graph.query(branches.join("\nUNION ALL\n"), { val: name }),
    2000,
  );
  return result.rows as Array<{ relType: string; targetName: string }>;
}

async function enrichEntityBatch(db: Database, entities: EntityBatchEntry[]): Promise<string> {
  if (entities.length === 0) return "";

  const rows: { label: string; name: string; brief: string | null; relCounts: string }[] = [];

  for (const ent of entities) {
    try {
      // Phase 1: get label and brief (no type(r))
      const metaResult = await withTimeout(
        db.graph.query(
          `MATCH (n) WHERE n.name = $val RETURN label(n) AS _label, n.brief AS brief`,
          { val: ent.value },
        ),
        2000,
      );
      const metaRow = metaResult.rows[0] as { _label?: string; brief?: string | null } | undefined;
      if (!metaRow) continue;
      const label = metaRow._label || "";
      if (!label) continue;

      // Phase 2: query relationships per type to avoid type(r)
      let rels: Array<{ relType: string; targetName: string }> = [];
      try {
        rels = await queryEntityRelationships(db, ent.value, label);
      } catch {
        // Relationships are best-effort
      }

      // Count relationships by type
      const byType = new Map<string, number>();
      for (const r of rels) {
        if (!r.relType) continue;
        byType.set(r.relType, (byType.get(r.relType) || 0) + 1);
      }
      const relCounts = [...byType.entries()].map(([t, c]) => `${t}(${c})`).join(", ");

      rows.push({
        label,
        name: ent.value,
        brief: metaRow.brief ?? null,
        relCounts,
      });
    } catch {
      // Silently skip entities that can't be queried (wrong label, deleted, etc.)
    }
  }

  if (rows.length === 0) return "";

  const lines = rows.map(
    (r) => `${r.label} "${r.name}" — "${r.brief || ""}" — ${r.relCounts || "(none)"}`,
  );
  return `\n[Entity Index]\n${lines.join("\n")}`;
}

// ── Enrichers ──

async function manageNodeEnricher(args: string, result: string): Promise<string> {
  let parsed: { nodeLabel?: string; match?: Record<string, string>; action?: string };
  try {
    parsed = JSON.parse(args);
  } catch {
    return "";
  }

  if (parsed.action === "DELETE") return "";
  if (result.startsWith("ERROR:")) return "";

  const label = parsed.nodeLabel;
  const match = parsed.match;
  if (!label || !match || Object.keys(match).length === 0) return "";

  try {
    const db = Database.getExisting();
    const rows = await querySingleEntity(db, label, match);
    const entityName = match.name || Object.values(match)[0];
    return formatEntityContext(rows, entityName);
  } catch (err) {
    logger.warn(
      "[enrichment] manageNode enrichment failed:",
      err instanceof Error ? err.message : String(err),
    );
    return "";
  }
}

async function manageRelationshipEnricher(args: string, result: string): Promise<string> {
  if (result.startsWith("ERROR:")) return "";

  let parsed: {
    relationshipType?: string;
    sourceLabel?: string;
    sourceMatch?: Record<string, string>;
    targetLabel?: string;
    targetMatch?: Record<string, string>;
  };
  try {
    parsed = JSON.parse(args);
  } catch {
    return "";
  }

  const { sourceLabel, sourceMatch, targetLabel, targetMatch, relationshipType } = parsed;
  if (!sourceLabel || !sourceMatch || !targetLabel || !targetMatch || !relationshipType) return "";
  if (Object.keys(sourceMatch).length === 0 || Object.keys(targetMatch).length === 0) return "";

  try {
    const db = Database.getExisting();

    const srcName = Object.values(sourceMatch)[0];
    const tgtName = Object.values(targetMatch)[0];

    const [srcRows, tgtRows] = await Promise.all([
      querySingleEntity(db, sourceLabel, sourceMatch).catch(() => [] as EnrichmentRow[]),
      querySingleEntity(db, targetLabel, targetMatch).catch(() => [] as EnrichmentRow[]),
    ]);

    const partList: string[] = [];
    partList.push(`\n[Context] ${srcName} now ${relationshipType} ${tgtName}.`);

    // Source context: filter out the relationship just created
    const srcOthers = srcRows.filter(
      (r) => !(r.relType === relationshipType && r.otherName === tgtName),
    );
    const srcCtx = formatEntityContext(srcOthers, srcName);
    if (srcCtx.trim()) partList.push(srcCtx.trim());

    // Target context
    const tgtCtx = formatEntityContext(tgtRows, tgtName);
    if (tgtCtx.trim()) partList.push(tgtCtx.trim());

    return partList.join("\n");
  } catch (err) {
    logger.warn(
      "[enrichment] manageRelationship enrichment failed:",
      err instanceof Error ? err.message : String(err),
    );
    return "";
  }
}

async function queryWorldEnricher(args: string, result: string): Promise<string> {
  let parsed: { action?: string };
  try {
    parsed = JSON.parse(args);
  } catch {
    return "";
  }

  if (parsed.action === "WRITE") return "";
  if (result.length > 2000) return "";

  let parsedResult: { rows: Record<string, unknown>[] };
  try {
    parsedResult = JSON.parse(result);
  } catch {
    return "";
  }

  const rows = parsedResult.rows;
  if (!rows || rows.length === 0) return "";

  // Best-effort entity detection
  const entities: EntityBatchEntry[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      // Heuristic 1: value is an object with a 'name' property (e.g., RETURN c)
      if (value && typeof value === "object" && !Array.isArray(value) && "name" in value) {
        const obj = value as Record<string, unknown>;
        const name = String(obj.name || "");
        if (name && !seen.has(name)) {
          seen.add(name);
          // Use the return key as best-guess label; enrichEntityBatch handles bad labels silently
          entities.push({ label: key, key: "name", value: name });
        }
      }
    }
  }

  if (entities.length === 0) return "";

  try {
    const db = Database.getExisting();
    return await enrichEntityBatch(db, entities.slice(0, 10));
  } catch (err) {
    logger.warn(
      "[enrichment] queryWorld enrichment failed:",
      err instanceof Error ? err.message : String(err),
    );
    return "";
  }
}

async function searchWorldEnricher(_args: string, result: string): Promise<string> {
  if (result.startsWith("ERROR:")) return "";

  let parsedResult: Record<string, Record<string, unknown>[]>;
  try {
    parsedResult = JSON.parse(result);
  } catch {
    return "";
  }

  const entities: EntityBatchEntry[] = [];
  const seen = new Set<string>();

  for (const [domain, rows] of Object.entries(parsedResult)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const name = row.name as string | undefined;
      if (name && !seen.has(name)) {
        seen.add(name);
        entities.push({ label: domain, key: "name", value: name });
      }
    }
  }

  if (entities.length === 0) return "";

  try {
    const db = Database.getExisting();
    return await enrichEntityBatch(db, entities.slice(0, 10));
  } catch (err) {
    logger.warn(
      "[enrichment] searchWorld enrichment failed:",
      err instanceof Error ? err.message : String(err),
    );
    return "";
  }
}

// ── Registry ──

const ENRICHERS: Record<string, Enricher> = {
  [TOOL_NAMES.MANAGE_NODE]: manageNodeEnricher,
  [TOOL_NAMES.MANAGE_RELATIONSHIP]: manageRelationshipEnricher,
  [TOOL_NAMES.QUERY_WORLD]: queryWorldEnricher,
  [TOOL_NAMES.SEARCH_WORLD]: searchWorldEnricher,
};

// ── Dispatch ──

export async function enrichResult(
  toolName: string,
  args: string,
  rawResult: string,
): Promise<string> {
  const enricher = ENRICHERS[toolName];
  if (!enricher) return rawResult;

  try {
    const enrichment = await enricher(args, rawResult);
    if (!enrichment) return rawResult;
    return rawResult + enrichment;
  } catch (err) {
    logger.warn(
      `[enrichment] enrichResult failed for ${toolName}:`,
      err instanceof Error ? err.message : String(err),
    );
    return rawResult;
  }
}
