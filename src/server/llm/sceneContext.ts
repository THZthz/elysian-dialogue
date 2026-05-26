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
import { SchemaRegistry } from "@/server/db/schema";

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

  function render(nodes: PlotNode[], indent: number): string {
    let result = "";
    for (const node of nodes) {
      const prefix = "  ".repeat(indent);
      result += `${prefix}- **${node.name}** [${node.status}]`;
      if (node.brief) result += ` ${node.brief}`;
      result += "\n";
      if (node.triggerCondition) {
        result += `${prefix}  ▸ ${node.triggerCondition}\n`;
      }
      if (node.children.length > 0) {
        result += render(node.children, indent + 1);
      }
    }
    return result;
  }

  return render(roots, 0);
}

// ── SCENE_CONTEXT ──

export async function buildSceneContext(): Promise<string> {
  const db = Database.getExisting();

  const activeScene = await db.scene.getActive().catch((err) => {
    console.error(
      "[sceneContext] getActive failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  });

  const parts: string[] = [];
  parts.push("## SCENE CONTEXT (pre-loaded)");

  // Game time
  if (activeScene) {
    parts.push(`\n### Time\n${describeTime({ day: Math.floor(activeScene.start_time / 48), hour: (activeScene.start_time % 48) / 2 })}`);
  }

  try {
    // Query 1: Player + location
    const playerResult = await db.graph.query(
      `MATCH (player:Character {name: "Player"}) OPTIONAL MATCH (player)-[loc_rel:LOCATED_AT]->(loc:Location) WHERE loc_rel.valid_at IS NULL RETURN player, loc`,
    );

    const playerRow = playerResult.rows[0];
    const player = playerRow?.player as Record<string, unknown> | null;
    const loc = playerRow?.loc as Record<string, unknown> | null;

    if (!player) {
      parts.push("(No scene data available — player entity not found.)");
      return parts.join("\n");
    }

    const locName = loc?.name as string | undefined;

    // Query 2: Inventory
    const invResult = await db.graph.query(
      `MATCH (player:Character {name: "Player"})-[c:CARRIES]->(inv:Object) WHERE c.valid_at IS NULL RETURN inv`,
    );
    const inventory = invResult.rows.map((r) => (r.inv || r) as Record<string, unknown>);

    // Query 3: NPCs at location
    let npcs: Record<string, unknown>[] = [];
    if (locName) {
      const npcResult = await db.graph.query(
        `MATCH (npc:Character)-[r:LOCATED_AT]->(loc:Location {name: $locName}) WHERE npc.name <> "Player" AND r.valid_at IS NULL RETURN npc`,
        { locName },
      );
      npcs = npcResult.rows.map((r) => (r.npc || r) as Record<string, unknown>);
    }

    // Query 4: Objects at location
    let objects: Record<string, unknown>[] = [];
    if (locName) {
      const objResult = await db.graph.query(
        `MATCH (obj:Object)-[r:LOCATED_AT]->(loc:Location {name: $locName}) WHERE r.valid_at IS NULL RETURN obj`,
        { locName },
      );
      objects = objResult.rows.map((r) => (r.obj || r) as Record<string, unknown>);
    }

    // Query 5: Dispositions
    const dispResult = await db.graph.query(
      `MATCH (d:Disposition {target_name: "Player"}) RETURN d.source_name AS npcName, d.sentiment AS sentiment, d.summary AS summary ORDER BY d._updated_at DESC`,
    );
    const dispositionRows = dispResult.rows as unknown as DispositionRow[];

    const compactLines: string[] = [];

    // Location
    if (loc) {
      const locRef: EntityRef = {
        name: (loc.name as string) ?? "Unknown",
        description: (loc.description as string) || null,
        brief: (loc.brief as string) || null,
      };
      compactLines.push(`\n###Location\n${formatEntityCompact(locRef)}`);
    }

    // Inventory — names only
    if (inventory.length > 0) {
      compactLines.push(`\n### Carrying\n${inventory.map((i) => i.name).join(", ")}`);
    }

    // NPCs
    if (npcs.length > 0) {
      compactLines.push("\n### Nearby NPCs");
      for (const npc of npcs) {
        const ref: EntityRef = {
          name: (npc.name as string) ?? "",
          description: (npc.description as string) || null,
          brief: (npc.brief as string) || null,
        };
        compactLines.push(formatEntityCompact(ref));
      }
    }

    // Objects
    if (objects.length > 0) {
      compactLines.push("\n### Nearby Objects");
      for (const obj of objects) {
        const ref: EntityRef = {
          name: (obj.name as string) ?? "",
          description: (obj.description as string) || null,
          brief: (obj.brief as string) || null,
        };
        compactLines.push(formatEntityCompact(ref));
      }
    }

    // Dispositions
    if (dispositionRows.length > 0) {
      compactLines.push("\n### NPC Dispositions toward Player");
      for (const d of dispositionRows) {
        compactLines.push(formatDisposition(d));
      }
    }

    parts.push(compactLines.join("\n"));
    parts.push("");
  } catch (err) {
    console.error(
      "[sceneContext] scene query failed:",
      err instanceof Error ? err.message : String(err),
    );
    if (parts.length <= 2) {
      parts.push("(No scene data available — scene query failed.)");
    }
  }

  return parts.join("\n");
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
    "Each plot shows its triggerCondition (when present) as a sub-line with '▸', inheriting the same tree indentation",
    "",
    "```",
    tree,
    "```",
  ];
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

export async function buildRelationshipDump(): Promise<string> {
  const db = Database.getExisting();
  const schema = SchemaRegistry.getInstance();
  const internalNames = new Set(schema.getInternalTypeNames());
  for (const name of [
    "HAS_DISPOSITION",
    "BRANCHES_TO",
    "ABOUT_ENTITY",
    "ABOUT_SCENE",
    "ABOUT_PLOT",
  ]) {
    internalNames.add(name);
  }

  const results: RelRow[] = [];
  for (const relDef of schema.getAllRelTypes()) {
    if (internalNames.has(relDef.name)) continue;
    try {
      const isTemporal = schema.isTemporalRelType(relDef);
      const whereClause = isTemporal ? " WHERE r.valid_at IS NULL" : "";
      const r = await db.graph.query(
        `MATCH (a)-[r:\`${relDef.name}\`]->(b)${whereClause}
         RETURN label(a) AS sourceLabel, COALESCE(a.name, a._uid) AS sourceName,
                type(r) AS type, properties(r) AS props,
                label(b) AS targetLabel, COALESCE(b.name, b._uid) AS targetName
         LIMIT 200`,
      );
      for (const row of r.rows) {
        if (
          !internalNames.has(row.sourceLabel as string) &&
          !internalNames.has(row.targetLabel as string)
        ) {
          results.push(row as unknown as RelRow);
        }
      }
    } catch {
      /* table may not exist yet */
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
      for (const r of group) {
        const tgt = r.targetName;
        if (!seen.has(tgt)) {
          seen.add(tgt);
          const occupants = group
            .filter((o) => o.targetName === tgt)
            .map((o) => o.sourceName)
            .join(", ");
          const desc = group.find((o) => o.props.description)?.props.description;
          const descSuffix = desc ? ` — "${desc}"` : "";
          lines.push(`- **${tgt}**: ${occupants}${descSuffix}`);
        }
      }
    } else {
      for (const r of group) {
        const desc = r.props?.description ? ` — "${r.props.description}"` : "";
        lines.push(`- ${r.sourceName} → ${r.targetName}${desc}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}
