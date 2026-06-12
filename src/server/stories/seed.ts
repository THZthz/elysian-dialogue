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

import { v4 as uuidv4 } from "uuid";
import { getActiveSeedStory } from "@/server/stories";
import { Database } from "@/server/db";

type EntityLabel = "Character" | "Object" | "Location";

function pascalCase(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

export async function seedDatabase(): Promise<void> {
  const story = getActiveSeedStory();
  const db = Database.getExisting();

  // Skip if database already has data (prevents duplicate injection on restart)
  const existing = await db.graph.query(
    "MATCH (e) WHERE label(e) = 'Character' OR label(e) = 'Object' OR label(e) = 'Location' RETURN count(e) AS count",
  );
  if ((existing.rows[0]?.count as number) > 0) {
    console.log(`[seedDatabase] database already has ${existing.rows[0].count} entities, skipping`);
    return;
  }

  // Create initial Scene
  await db.scene.create({
    scene_name: story.initialScene.scene_name,
    start_time: story.initialScene.start_time,
    location_name: story.initialScene.location_name,
    characters: story.initialScene.characters,
    reason: "Opening scene",
  });
  console.log(
    `[seedDatabase] initial scene created at time ${story.initialScene.start_time} in "${story.initialScene.location_name}"`,
  );

  console.log(`[seedDatabase] seeding ${story.entities.length} entities from "${story.id}"`);

  // Register relationship types from seed story before creating instances
  if (story.relationshipTypes) {
    const schema = db.schema;
    for (const rt of story.relationshipTypes) {
      schema.registerRel({
        name: rt.name,
        description: rt.description,
        category: "GM_DEFINED",
        sourceLabel: rt.sourceLabel,
        targetLabel: rt.targetLabel,
        properties: [
          { name: "brief", description: "Connection detail.", tags: ["string", "embedded"] },
        ],
      });
    }
    console.log(
      `[seedDatabase] registered ${story.relationshipTypes.length} relationship types from "${story.id}"`,
    );
    // Execute DDL and persist for seed story's custom relationship types
    for (const rt of story.relationshipTypes) {
      const ddl = schema.generateRelDDL(rt.name, rt.sourceLabel, rt.targetLabel);
      if (ddl) {
        try {
          await db.graph.query(ddl);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = (err as { code?: string }).code;
          if (
            code === "CATALOG_ALREADY_EXISTS" ||
            msg.toLowerCase().includes("already exists") ||
            msg.toLowerCase().includes("duplicate table")
          ) {
            continue;
          }
          throw err;
        }
      }
      await schema.persistRelType(db.graph, rt.name, rt.sourceLabel, rt.targetLabel);
    }
  }

  // Create entities using domain models
  const nameToLabel = new Map<string, string>();
  for (const entity of story.entities) {
    const label = pascalCase(entity.type) as EntityLabel;
    nameToLabel.set(entity.name, label);

    const cleanMetadata = entity.metadata ? { ...entity.metadata } : {};
    await db.entities.create(label, {
      name: entity.name,
      brief: entity.brief ?? "",
      description: entity.description ?? "",
      metadata: Object.keys(cleanMetadata).length > 0 ? cleanMetadata : undefined,
    });

    // Preserve player entity convention: _uid = "00000000-0000-0000-0000-000000000000"
    if (entity.id === "00000000-0000-0000-0000-000000000000") {
      await db.graph.query(`MATCH (e:\`${label}\` {name: $name}) SET e._uid = $id`, {
        name: entity.name,
        id: "00000000-0000-0000-0000-000000000000",
      });
    }
  }

  // Create relationships
  for (const rel of story.relationships) {
    const srcLabel = nameToLabel.get(rel.sourceName) ?? "Character";
    const tgtLabel = nameToLabel.get(rel.targetName) ?? "Location";
    console.log(
      `[seed] REL: (${rel.sourceName} [${srcLabel}])-[${rel.type}]->(${rel.targetName} [${tgtLabel}])`,
    );
    await db.graph.mergeRelationship(
      srcLabel,
      "name",
      rel.sourceName,
      tgtLabel,
      "name",
      rel.targetName,
      rel.type,
      rel.description ? { brief: rel.description } : undefined,
    );
  }

  // Set temporal properties on seeded relationships for historical query support.
  // mergeRelationship only sets _created_at (internal timestamp). Temporal
  // relationships need created_at set for historical queries, valid_at
  // explicitly set to NULL for current-state queries, and _updated_at set
  // for consistency with runtime-created relationships.
  const initialTime = story.initialScene.start_time;
  const now = new Date().toISOString();
  const temporalRelTypes = [
    "CHARACTER_AT",
    "OBJECT_AT",
    "CARRIED_BY",
    "LOCATED_IN",
    "HAS_DISPOSITION",
  ];
  for (const relType of temporalRelTypes) {
    try {
      await db.graph.query(
        `MATCH ()-[r:\`${relType}\`]->() SET r.created_at = $t, r.valid_at = NULL, r._updated_at = $now`,
        { t: initialTime, now },
      );
    } catch {
      // table may not exist if no relationships of this type were seeded
    }
  }

  // Seed initial NPC dispositions from story configuration
  let dispositionCount = 0;
  for (const disp of story.dispositions || []) {
    const now = new Date().toISOString();
    const srcName = disp.sourceName;
    const tgtName = disp.targetName;

    // Check if NPC exists in the graph
    const npcCheck = await db.graph.query(
      "MATCH (npc:Character {name: $name}) RETURN npc LIMIT 1",
      { name: srcName },
    );
    if (npcCheck.rows.length === 0) {
      console.warn(`[seed] disposition skipped: NPC entity "${srcName}" not found`);
      dispositionCount++;
      continue;
    }

    // Merge Disposition node
    const dispCheck = await db.graph.query(
      "MATCH (d:Disposition {source_name: $src, target_name: $tgt}) RETURN d LIMIT 1",
      { src: srcName, tgt: tgtName },
    );

    if (dispCheck.rows.length > 0) {
      await db.graph.query(
        "MATCH (d:Disposition {source_name: $src, target_name: $tgt}) SET d.sentiment = $sentiment, d.summary = $summary, d._updated_at = $now",
        { src: srcName, tgt: tgtName, sentiment: disp.sentiment, summary: disp.summary, now },
      );
    } else {
      const _uid = uuidv4();
      await db.graph.query(
        `CREATE (d:Disposition {_uid: $_uid, source_name: $src, target_name: $tgt, sentiment: $sentiment, summary: $summary, _created_at: $now, _updated_at: $now})`,
        { _uid, src: srcName, tgt: tgtName, sentiment: disp.sentiment, summary: disp.summary, now },
      );
    }

    // Link NPC to Disposition
    await db.graph.query(
      `MATCH (npc:Character {name: $npcName})
       MATCH (d:Disposition {source_name: $src, target_name: $tgt})
       MERGE (npc)-[r:HAS_DISPOSITION]->(d)
       ON CREATE SET r._created_at = $now`,
      { npcName: srcName, src: srcName, tgt: tgtName, now },
    );

    dispositionCount++;
  }

  // Seed plots from story
  for (const plot of story.plots || []) {
    await db.plots.create(
      plot.name,
      plot.description,
      plot.brief ?? "",
      plot.status,
      plot.triggerCondition ?? "",
    );
  }

  // Seed plot branches
  for (const plot of story.plots || []) {
    if (plot.branchesTo) {
      for (const childName of plot.branchesTo) {
        await db.plots.branch(plot.name, childName);
      }
    }
  }

  // Seed notes
  let noteCount = 0;
  for (const note of story.notes || []) {
    await db.notes.create(note.name, note.content);
    if (note.aboutEntities) {
      for (const entityName of note.aboutEntities) {
        await db.notes.linkToEntity(note.name, entityName);
      }
    }
    if (note.aboutPlots) {
      for (const plotName of note.aboutPlots) {
        await db.notes.linkToPlot(note.name, plotName);
      }
    }
    noteCount++;
  }

  console.log(
    `[seedDatabase] done — ${story.entities.length} entities, ${story.relationships.length} relationships, ${dispositionCount} dispositions, ${noteCount} notes`,
  );
}
