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

  // Build UNION query: outgoing + incoming + (optional) dispositions
  const outBranch = `MATCH (n:\`${label}\`) WHERE ${where}
     MATCH (n)-[r]->(m) WHERE r.valid_at IS NULL
     RETURN 'out' AS dir, type(r) AS relType, label(m) AS otherLabel,
            COALESCE(m.name, CAST(m._uid, 'STRING')) AS otherName, m.brief AS otherBrief`;
  const inBranch = `MATCH (n:\`${label}\`) WHERE ${where}
     MATCH (m)-[r]->(n) WHERE r.valid_at IS NULL
     RETURN 'in' AS dir, type(r) AS relType, label(m) AS otherLabel,
            COALESCE(m.name, CAST(m._uid, 'STRING')) AS otherName, m.brief AS otherBrief`;

  let query = `${outBranch}\nUNION\n${inBranch}`;

  if (isCharacter) {
    const dispBranch = `MATCH (n:\`${label}\`) WHERE ${where}
       MATCH (n)-[:HAS_DISPOSITION]->(d:Disposition)
       RETURN 'disp' AS dir, d.sentiment AS relType, 'Character' AS otherLabel,
              d.target_name AS otherName, d.summary AS otherBrief`;
    query = `${query}\nUNION\n${dispBranch}`;
  }

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

async function enrichEntityBatch(db: Database, entities: EntityBatchEntry[]): Promise<string> {
  if (entities.length === 0) return "";

  const rows: { label: string; name: string; brief: string | null; relCounts: string }[] = [];

  for (const ent of entities) {
    try {
      const result = await withTimeout(
        db.graph.query(
          `MATCH (n) WHERE n.name = $val
           OPTIONAL MATCH (n)-[r]->(m) WHERE r.valid_at IS NULL
           RETURN label(n) AS _label, n.brief AS brief,
                  collect(DISTINCT {relType: type(r), targetName: COALESCE(m.name, CAST(m._uid, 'STRING'))}) AS rels`,
          { val: ent.value },
        ),
        2000,
      );

      const row = result.rows[0] as
        | {
            _label: string;
            brief: string | null;
            rels: Array<{ relType: string; targetName: string }>;
          }
        | undefined;
      if (!row) continue;

      // Count relationships by type
      const byType = new Map<string, number>();
      for (const r of row.rels) {
        if (!r.relType) continue;
        byType.set(r.relType, (byType.get(r.relType) || 0) + 1);
      }
      const relCounts = [...byType.entries()].map(([t, c]) => `${t}(${c})`).join(", ");

      rows.push({
        label: row._label,
        name: ent.value,
        brief: row.brief,
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

async function editNodeEnricher(args: string, result: string): Promise<string> {
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
    console.warn(
      "[enrichment] editNode enrichment failed:",
      err instanceof Error ? err.message : String(err),
    );
    return "";
  }
}

async function editRelationshipEnricher(args: string, result: string): Promise<string> {
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
    console.warn(
      "[enrichment] editRelationship enrichment failed:",
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
    console.warn(
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
    console.warn(
      "[enrichment] searchWorld enrichment failed:",
      err instanceof Error ? err.message : String(err),
    );
    return "";
  }
}

// ── Registry ──

const ENRICHERS: Record<string, Enricher> = {
  [TOOL_NAMES.EDIT_NODE]: editNodeEnricher,
  [TOOL_NAMES.EDIT_RELATIONSHIP]: editRelationshipEnricher,
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
    console.warn(
      `[enrichment] enrichResult failed for ${toolName}:`,
      err instanceof Error ? err.message : String(err),
    );
    return rawResult;
  }
}
