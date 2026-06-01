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
import { SchemaRegistry, RelTypeDef } from "@/server/db/schema";

// ── Time helpers ──

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

function formatTime(t: number): string {
  const day = Math.floor(t / 48);
  const halfHours = t % 48;
  const hour = halfHours / 2;
  return `Day ${day}, ${formatHour(hour)}`;
}

// ── Types ──

interface EntityRef {
  name: string;
  description: string | null;
  brief: string | null;
}

interface DispositionRow {
  npcName: string;
  sentiment: string;
  summary: string;
}

interface PlotNode {
  name: string;
  description: string;
  brief: string | null;
  status: string;
  triggerCondition: string | null;
  children: PlotNode[];
}

// ── Formatters ──

function formatDisposition(d: DispositionRow): string {
  return `- **${d.npcName}**: ${d.sentiment} — "${d.summary}"`;
}

function formatEntityCompact(entity: EntityRef): string {
  const brief = entity.brief || (entity.description || "").slice(0, 120);
  return `- **${entity.name}**: ${brief}`;
}

function buildPlotTreeFromNodes(plots: PlotNode[]): string {
  const childNames = new Set<string>();
  for (const plot of plots) {
    for (const child of plot.children) {
      childNames.add(child.name);
    }
  }
  const roots = plots.filter((p) => !childNames.has(p.name));

  function render(nodes: PlotNode[], isLastAncestors: boolean[]): string {
    let result = "";
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const last = i === nodes.length - 1;

      const indent = isLastAncestors.map((l) => (l ? "    " : "│   ")).join("");
      const soleRoot = isLastAncestors.length === 0 && nodes.length === 1;
      const branch = soleRoot ? "" : last ? "└── " : "├── ";

      result += `${indent}${branch}**${node.name}** [${node.status}]`;
      if (node.brief) result += ` — ${node.brief}`;
      result += "\n";

      const continuation = indent + (soleRoot ? "" : last ? "    " : "│   ");

      if (node.triggerCondition) {
        result += `${continuation}▸ ${node.triggerCondition}\n`;
      }
      if (node.children.length > 0) {
        result += render(node.children, [...isLastAncestors, last]);
      }
    }
    return result;
  }

  return render(roots, []);
}

// ── CHARACTERS_BRIEF ──

interface CharacterRow {
  name: string;
  brief: string | null;
  description: string | null;
  location: string | null;
  disposition: string | null;
}

export async function buildCharactersBrief(): Promise<string> {
  const db = Database.getExisting();
  const result = await db.graph.query(
    `MATCH (c:Character)
OPTIONAL MATCH (c)-[loc_rel:LOCATED_AT]->(loc:Location)
WHERE loc_rel.valid_at IS NULL
OPTIONAL MATCH (c)-[:HAS_DISPOSITION]->(d:Disposition {target_name: "Player"})
RETURN c.name AS name, c.brief AS brief, c.description AS description,
       loc.name AS location, d.sentiment AS disposition
ORDER BY name`,
  );
  const rows = result.rows as unknown as CharacterRow[];

  if (rows.length === 0) return "## CHARACTERS\n\n(none)\n";

  const lines: string[] = ["## CHARACTERS", ""];
  for (const c of rows) {
    const brief = c.brief || (c.description || "").slice(0, 120) || "";
    const loc = c.location ? ` (at ${c.location})` : "";
    const disp = c.disposition ? ` [${c.disposition}]` : "";
    lines.push(`- **${c.name}**${loc}: ${brief}${disp}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ── LOCATIONS_BRIEF ──

interface LocationRow {
  name: string;
  brief: string | null;
  description: string | null;
}

export async function buildLocationsBrief(): Promise<string> {
  const db = Database.getExisting();
  const result = await db.graph.query(
    `MATCH (l:Location) RETURN l.name AS name, l.brief AS brief, l.description AS description ORDER BY name`,
  );
  const rows = result.rows as unknown as LocationRow[];

  if (rows.length === 0) return "## LOCATIONS\n\n(none)\n";

  const lines: string[] = ["## LOCATIONS", ""];
  for (const l of rows) {
    const brief = l.brief || (l.description || "").slice(0, 120) || "";
    lines.push(`- **${l.name}**: ${brief}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ── OBJECTS_BRIEF ──

interface ObjectRow {
  name: string;
  brief: string | null;
  description: string | null;
  carrier: string | null;
  location: string | null;
}

export async function buildObjectsBrief(): Promise<string> {
  const db = Database.getExisting();
  const result = await db.graph.query(
    `MATCH (o:Object)
OPTIONAL MATCH (carrier:Character)-[carry_rel:CARRIES]->(o)
WHERE carry_rel.valid_at IS NULL
OPTIONAL MATCH (o)-[loc_rel:LOCATED_AT]->(loc:Location)
WHERE loc_rel.valid_at IS NULL
WITH o, carrier, loc
WHERE carrier IS NULL
RETURN o.name AS name, o.brief AS brief, o.description AS description,
       carrier.name AS carrier, loc.name AS location
ORDER BY name`,
  );
  const rows = result.rows as unknown as ObjectRow[];

  if (rows.length === 0) return "## OBJECTS\n\n(none)\n";

  const lines: string[] = ["## OBJECTS", ""];
  for (const o of rows) {
    const context = o.carrier
      ? `Carried by: ${o.carrier}`
      : o.location
        ? `Located at: ${o.location}`
        : "(location unknown)";
    lines.push(`- **${o.name}** — ${context}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ── PLOTS_BRIEF ──

export async function buildPlotsBrief(): Promise<string> {
  const db = Database.getExisting();

  // Query all plots
  const plotsResult = await db.graph.query(
    "MATCH (p:Plot) RETURN p.name AS name, p.description AS description, p.brief AS brief, p.status AS status, p.flags AS flags, p.trigger_condition AS triggerCondition ORDER BY name",
  );

  // Query branches
  const branchesResult = await db.graph.query(
    "MATCH (p:Plot)-[:BRANCHES_TO]->(child:Plot) RETURN p.name AS parent, child.name AS child",
  );

  if (plotsResult.rows.length === 0) return "## PLOTS\n\n(none)\n";

  // Build plot map
  const plotMap = new Map<string, PlotNode>();
  for (const row of plotsResult.rows) {
    plotMap.set(row.name as string, {
      name: row.name as string,
      description: (row.description as string) ?? "",
      brief: (row.brief as string) || null,
      status: (row.status as string) ?? "PENDING",
      triggerCondition: (row.triggerCondition as string) || null,
      children: [],
    });
  }

  // Wire branches
  for (const row of branchesResult.rows) {
    const parent = plotMap.get(row.parent as string);
    const child = plotMap.get(row.child as string);
    if (parent && child) {
      parent.children.push(child);
    }
  }

  const tree = buildPlotTreeFromNodes([...plotMap.values()]);

  const lines: string[] = [
    "## PLOTS",
    "",
    "ASCII tree layout. Trigger conditions (when present) shown with '▸' below their plot.",
    "",
    "```",
    tree,
    "```",
    "",
  ];
  return lines.join("\n");
}

// ── SCENES_BRIEF ──

interface SceneRow {
  name: string;
  start_time: number;
  end_time: number | null;
  location_name: string | null;
  characters: string;
  reason: string | null;
  prev_name: string | null;
}

export async function buildScenesBrief(): Promise<string> {
  const db = Database.getExisting();
  const result = await db.graph.query(
    `MATCH (s:Scene)
     OPTIONAL MATCH (prev:Scene)-[r:NEXT_SCENE]->(s)
     RETURN s.name AS name, s.start_time AS start_time, s.end_time AS end_time,
            s.location_name AS location_name, s.characters AS characters,
            r.reason AS reason, prev.name AS prev_name
     ORDER BY s.start_time`,
  );
  const rows = result.rows as unknown as SceneRow[];

  if (rows.length === 0) return "## SCENES\n\n(none)\n";

  const lines: string[] = ["## SCENES", ""];
  for (const sc of rows) {
    const day = Math.floor(sc.start_time / 48);
    const halfHours = sc.start_time % 48;
    const hour = Math.floor(halfHours / 2);
    const minute = halfHours % 2 === 0 ? "00" : "30";
    const period = hour < 12 ? "AM" : "PM";
    const displayH = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    const timeStr = `Day ${day}, ${displayH}:${minute} ${period}`;

    const active = sc.end_time === null ? " (active)" : "";
    const loc = sc.location_name ?? "(placeholder)";
    let chars: string[] = [];
    try {
      chars = JSON.parse(sc.characters);
    } catch {
      /* ignore parse errors */
    }
    const charStr = chars.length > 0 ? ` [${chars.join(", ")}]` : "";
    const reason = sc.reason ? ` ← "${sc.reason}"` : "";

    lines.push(`- **${sc.name}**${active}: ${timeStr} at **${loc}**${charStr}${reason}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ── RELATIONSHIP_DUMP ──

interface RelRow {
  sourceLabel: string;
  sourceName: string;
  type: string;
  targetLabel: string;
  targetName: string;
  props: Record<string, unknown>;
}

export async function buildRelationshipDump(history = false): Promise<string> {
  const db = Database.getExisting();
  const schema = SchemaRegistry.getInstance();
  const internalNames = new Set(schema.getInternalTypeNames());
  for (const name of [
    "HAS_DISPOSITION",
    "BRANCHES_TO",
    "ABOUT_CHARACTER",
    "ABOUT_OBJECT",
    "ABOUT_LOCATION",
    "ABOUT_SCENE",
    "ABOUT_PLOT",
  ]) {
    internalNames.add(name);
  }

  const internalLabels = new Set(schema.getInternalTypeNames());

  const seenRelTypes = new Set<string>();
  const results: RelRow[] = [];
  for (const relDef of schema.getAllRelTypes()) {
    if (internalNames.has(relDef.name)) continue;
    if (internalLabels.has(relDef.sourceLabel) || internalLabels.has(relDef.targetLabel)) continue;
    if (seenRelTypes.has(relDef.name)) continue;
    seenRelTypes.add(relDef.name);
    try {
      const isTemporal = schema.isTemporalRelType(relDef);
      const whereClause = isTemporal ? (history ? "" : " WHERE r.valid_at IS NULL") : "";
      const temporalCols = history && isTemporal
        ? ", r.created_at AS createdAt, r.valid_at AS validAt"
        : "";
      const r = await db.graph.query(
        `MATCH (a)-[r:\`${relDef.name}\`]->(b)${whereClause}
         RETURN label(a) AS sourceLabel, COALESCE(a.name, a._uid) AS sourceName,
                '${relDef.name}' AS type, r.brief AS brief${temporalCols},
                label(b) AS targetLabel, COALESCE(b.name, b._uid) AS targetName
         LIMIT 200`,
      );
      for (const row of r.rows) {
        const sLabel = row.sourceLabel as string;
        const tLabel = row.targetLabel as string;
        if (!internalNames.has(sLabel) && !internalNames.has(tLabel)) {
          const props: Record<string, unknown> = {};
          if (row.brief != null) props.description = row.brief;
          if (history && row.createdAt != null) props.createdAt = row.createdAt;
          if (history && row.validAt != null) props.validAt = row.validAt;
          results.push({
            sourceLabel: sLabel,
            sourceName: row.sourceName as string,
            type: row.type as string,
            targetLabel: tLabel,
            targetName: row.targetName as string,
            props,
          });
        }
      }
    } catch (err) {
      console.warn(`[buildRelationshipDump] query failed for ${relDef.name}:`, err instanceof Error ? err.message : String(err));
    }
  }

  if (results.length === 0) return "## RELATIONSHIPS\n\n(none)\n";

  const byType = new Map<string, RelRow[]>();
  for (const r of results) {
    const group = byType.get(r.type) || [];
    group.push(r);
    if (!byType.has(r.type)) byType.set(r.type, group);
  }

  const lines: string[] = ["## RELATIONSHIPS", ""];
  const sortedTypes = [...byType.keys()].sort();
  for (const type of sortedTypes) {
    const group = byType.get(type)!;
    lines.push(`### ${type}`);
    if (type === "LOCATED_AT" || type === "LOCATED_IN") {
      const seen = new Set<string>();
      const byLocation = new Map<string, RelRow[]>();
      for (const r of group) {
        const tgt = r.targetName;
        if (!byLocation.has(tgt)) byLocation.set(tgt, []);
        byLocation.get(tgt)!.push(r);
      }
      for (const r of group) {
        const tgt = r.targetName;
        if (!seen.has(tgt)) {
          seen.add(tgt);
          lines.push(`- **${tgt}**:`);
          for (const o of byLocation.get(tgt)!) {
            let entry = `  - ${o.sourceName}`;
            if (history && o.props.createdAt != null) {
              const validStr = o.props.validAt != null ? formatTime(o.props.validAt as number) : "now";
              entry += ` [${formatTime(o.props.createdAt as number)}→${validStr}]`;
            }
            if (o.props.description) {
              entry += ` — "${o.props.description}"`;
            }
            lines.push(entry);
          }
        }
      }
    } else {
      for (const r of group) {
        const desc = r.props?.description ? ` — "${r.props.description}"` : "";
        if (history) {
          const created = r.props.createdAt ? ` [${formatTime(r.props.createdAt as number)}` : "";
          const valid = r.props.validAt != null ? `→${formatTime(r.props.validAt as number)}] (expired)` : (r.props.createdAt ? "→now]" : "");
          const range = created || valid ? ` ${created}${valid}` : "";
          lines.push(`- ${r.sourceName} → ${r.targetName}${range}${desc}`);
        } else {
          lines.push(`- ${r.sourceName} → ${r.targetName}${desc}`);
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ── TIMELINE ──

interface TimelineEntry {
  time: number;
  text: string;
}

export async function buildTimeline(): Promise<string> {
  const db = Database.getExisting();
  const schema = SchemaRegistry.getInstance();
  const internalLabels = new Set(schema.getInternalTypeNames());
  const temporalTypeDefs: RelTypeDef[] = [];

  const seenTypes = new Set<string>();
  for (const def of schema.getAllRelTypes()) {
    if (def.name.startsWith("_")) continue;
    if (internalLabels.has(def.sourceLabel) || internalLabels.has(def.targetLabel)) continue;
    if (schema.isTemporalRelType(def) && !seenTypes.has(def.name)) {
      seenTypes.add(def.name);
      temporalTypeDefs.push(def);
    }
  }

  const entries: TimelineEntry[] = [];

  for (const def of temporalTypeDefs) {
    try {
      const r = await db.graph.query(
        `MATCH (a)-[r:\`${def.name}\`]->(b)
         RETURN COALESCE(a.name, a._uid) AS srcName,
                COALESCE(b.name, b._uid) AS tgtName,
                r.created_at AS created_at, r.valid_at AS valid_at
         ORDER BY r.created_at DESC
         LIMIT 300`,
      );
      for (const row of r.rows) {
        const src = row.srcName ?? "?";
        const tgt = row.tgtName ?? "?";
        const created = row.created_at as number;
        entries.push({
          time: created,
          text: `${src} ${def.name} → ${tgt} (created)`,
        });
        if (row.valid_at != null) {
          const expired = row.valid_at as number;
          entries.push({
            time: expired,
            text: `${src} ${def.name} → ${tgt} (expired at ${expired})`,
          });
        }
      }
    } catch {
      /* table may not exist yet */
    }
  }

  if (entries.length === 0) return "## TIMELINE\n\n(none)\n";

  // Sort by time descending, then by text for determinism
  entries.sort((a, b) => b.time - a.time || a.text.localeCompare(b.text));

  const limited = entries.slice(0, 200);
  const lines: string[] = ["## TIMELINE", ""];
  for (const e of limited) {
    lines.push(`- [${formatTime(e.time)}] ${e.text}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ── ENTITY_PROFILE ──

export async function buildEntityProfile(name: string, label: string): Promise<string> {
  const db = Database.getExisting();
  const schema = SchemaRegistry.getInstance();

  // Check entity exists
  const entityCheck = await db.graph.query(
    `MATCH (n:\`${label}\` {name: $name}) RETURN n`,
    { name },
  );
  if (entityCheck.rows.length === 0) {
    return `## ENTITY_PROFILE\n\nEntity "${name}" with label "${label}" not found.\n`;
  }

  const node = entityCheck.rows[0]?.n as Record<string, unknown>;
  const lines: string[] = [`## ENTITY_PROFILE: ${label} "${name}"`, ""];

  // 1. Properties
  lines.push("### Properties");
  const props = Object.entries(node)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => {
      const val = typeof v === "object" ? JSON.stringify(v) : String(v);
      return `- **${k}**: ${val}`;
    });
  if (props.length === 0) {
    lines.push("(none)");
  } else {
    lines.push(...props);
  }
  lines.push("");

  // 2. Current Location (for Character, Object)
  const locationLabels = new Set(["Character", "Object"]);
  if (locationLabels.has(label)) {
    lines.push("### Current Location");
    try {
      const locResult = await db.graph.query(
        `MATCH (e:\`${label}\` {name: $name})-[r:LOCATED_AT]->(loc:Location)
         WHERE r.valid_at IS NULL
         RETURN loc.name AS locName, r.brief AS brief, r.created_at AS since
         LIMIT 1`,
        { name },
      );
      if (locResult.rows.length > 0) {
        const row = locResult.rows[0];
        const since = row.since != null ? ` (since ${formatTime(row.since as number)})` : "";
        const brief = row.brief ? ` — "${row.brief}"` : "";
        lines.push(`- **${row.locName}**${since}${brief}`);
      } else {
        lines.push("(none)");
      }
    } catch {
      lines.push("(unavailable)");
    }
    lines.push("");
  }

  // 3. Carried Items (Character) or Carried By (Object)
  lines.push("### Items / Carrying");
  try {
    if (label === "Character") {
      const carried = await db.graph.query(
        `MATCH (e:\`${label}\` {name: $name})-[r:CARRIES]->(obj:Object)
         WHERE r.valid_at IS NULL
         RETURN obj.name AS objName, r.brief AS brief
         LIMIT 50`,
        { name },
      );
      if (carried.rows.length > 0) {
        for (const row of carried.rows) {
          const brief = row.brief ? ` — "${row.brief}"` : "";
          lines.push(`- **${row.objName}**${brief}`);
        }
      } else {
        lines.push("(nothing carried)");
      }
    } else if (label === "Object") {
      const carrier = await db.graph.query(
        `MATCH (c:Character)-[r:CARRIES]->(e:\`${label}\` {name: $name})
         WHERE r.valid_at IS NULL
         RETURN c.name AS charName, r.brief AS brief
         LIMIT 1`,
        { name },
      );
      if (carrier.rows.length > 0) {
        const row = carrier.rows[0];
        const brief = row.brief ? ` — "${row.brief}"` : "";
        lines.push(`- Carried by **${row.charName}**${brief}`);
      } else {
        lines.push("(not carried by anyone)");
      }
    } else {
      lines.push("(not applicable)");
    }
  } catch {
    lines.push("(unavailable)");
  }
  lines.push("");

  // 4. Dispositions (Character only)
  if (label === "Character") {
    lines.push("### Dispositions");
    try {
      const outgoing = await db.graph.query(
        `MATCH (e:\`${label}\` {name: $name})-[r:HAS_DISPOSITION]->(d:Disposition)
         WHERE r.valid_at IS NULL
         RETURN d.target_name AS target, d.sentiment AS sentiment, d.summary AS summary`,
        { name },
      );
      const incoming = await db.graph.query(
        `MATCH (c:Character)-[r:HAS_DISPOSITION]->(d:Disposition {target_name: $name})
         WHERE r.valid_at IS NULL
         RETURN c.name AS source, d.sentiment AS sentiment, d.summary AS summary`,
        { name },
      );
      if (outgoing.rows.length === 0 && incoming.rows.length === 0) {
        lines.push("(none)");
      }
      for (const row of outgoing.rows) {
        lines.push(`- → **${row.target}**: ${row.sentiment} — "${row.summary}"`);
      }
      for (const row of incoming.rows) {
        lines.push(`- **${row.source}** → you: ${row.sentiment} — "${row.summary}"`);
      }
    } catch {
      lines.push("(unavailable)");
    }
    lines.push("");
  }

  // 5. Linked Notes
  lines.push("### Linked Notes");
  try {
    const aboutRel = `ABOUT_${label.toUpperCase()}`;
    const notesResult = await db.graph.query(
      `MATCH (n:Note)-[:\`${aboutRel}\`]->(e:\`${label}\` {name: $name})
       RETURN n.name AS noteName
       LIMIT 50`,
      { name },
    );
    if (notesResult.rows.length > 0) {
      for (const row of notesResult.rows) {
        lines.push(`- **${row.noteName}**`);
      }
    } else {
      lines.push("(none)");
    }
  } catch {
    lines.push("(unavailable)");
  }
  lines.push("");

  // 6. Scene Appearances (Character only)
  if (label === "Character") {
    lines.push("### Scene Appearances");
    try {
      const scenes = await db.graph.query(
        `MATCH (s:Scene) WHERE s.characters CONTAINS $name
         RETURN s.name AS sceneName, s.start_time AS startTime, s.location_name AS locName
         ORDER BY s.start_time DESC
         LIMIT 20`,
        { name },
      );
      if (scenes.rows.length > 0) {
        for (const row of scenes.rows) {
          lines.push(`- **${row.sceneName}** (${formatTime(row.startTime as number)}) at ${row.locName || "?"}`);
        }
      } else {
        lines.push("(none)");
      }
    } catch {
      lines.push("(unavailable)");
    }
    lines.push("");
  }

  // 7. Relationship History (bidirectional — last 20)
  lines.push("### Relationship History (last 20)");
  try {
    const temporalTypes = schema
      .getAllRelTypes()
      .filter((d) => schema.isTemporalRelType(d) && !d.name.startsWith("_"));
    const typeNames = [...new Set(temporalTypes.map((d) => d.name))];

    const historyEntries: Array<{ time: number; text: string }> = [];

    for (const typeName of typeNames) {
      const r1 = await db.graph.query(
        `MATCH (a:\`${label}\` {name: $name})-[r:\`${typeName}\`]->(b)
         RETURN COALESCE(b.name, b._uid) AS other, "out" AS dir,
                r.created_at AS created_at, r.valid_at AS valid_at
         ORDER BY r.created_at DESC
         LIMIT 100`,
        { name },
      );
      for (const row of r1.rows) {
        historyEntries.push({
          time: row.created_at as number,
          text: `${typeName} → ${row.other} (created)`,
        });
        if (row.valid_at != null) {
          historyEntries.push({
            time: row.valid_at as number,
            text: `${typeName} → ${row.other} (expired)`,
          });
        }
      }

      const r2 = await db.graph.query(
        `MATCH (a)-[r:\`${typeName}\`]->(b:\`${label}\` {name: $name})
         RETURN COALESCE(a.name, a._uid) AS other, "in" AS dir,
                r.created_at AS created_at, r.valid_at AS valid_at
         ORDER BY r.created_at DESC
         LIMIT 100`,
        { name },
      );
      for (const row of r2.rows) {
        historyEntries.push({
          time: row.created_at as number,
          text: `${row.other} ${typeName} → you (created)`,
        });
        if (row.valid_at != null) {
          historyEntries.push({
            time: row.valid_at as number,
            text: `${row.other} ${typeName} → you (expired)`,
          });
        }
      }
    }

    if (historyEntries.length === 0) {
      lines.push("(none)");
    } else {
      historyEntries.sort((a, b) => b.time - a.time);
      for (const e of historyEntries.slice(0, 20)) {
        lines.push(`- [${formatTime(e.time)}] ${e.text}`);
      }
    }
  } catch {
    lines.push("(unavailable)");
  }
  lines.push("");

  return lines.join("\n");
}
