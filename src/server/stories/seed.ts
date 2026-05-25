import { v4 as uuidv4 } from "uuid";
import { getActiveSeedStory } from "@/server/stories";
import { Database } from "@/server/db";
import { SEGMENT_LABELS } from "@/shared/constants";

function parseType(typeStr: string): { type: string; subtype: string | null } {
  if (typeStr.includes(":")) {
    const parts = typeStr.toUpperCase().split(":", 2);
    return { type: parts[0], subtype: parts[1] || null };
  }
  return { type: typeStr.toUpperCase(), subtype: null };
}

type EntityLabel = "Character" | "Object" | "Location";

function hourToLabel(hour: number): string {
  const idx = Math.floor(hour / 2);
  return SEGMENT_LABELS[Math.min(idx, SEGMENT_LABELS.length - 1)];
}

function pascalCase(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

export async function seedDatabase(): Promise<void> {
  const story = getActiveSeedStory();
  const db = Database.getExisting();

  // Skip if database already has data (prevents duplicate injection on restart)
  const existing = await db.graph.query(
    "MATCH (e) WHERE label(e) IN ('Character', 'Object', 'Location') RETURN count(e) AS count",
  );
  if ((existing.rows[0]?.count as number) > 0) {
    console.log(`[seedDatabase] database already has ${existing.rows[0].count} entities, skipping`);
    return;
  }

  // Set initial time
  const initialLabel = hourToLabel(story.initialSegment);
  await db.time.setInitialTime(story.initialDay, story.initialSegment, initialLabel);

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
        properties: [],
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

    // Preserve player entity convention: uid = "#player#"
    if (entity.id === "#player#") {
      await db.graph.query(`MATCH (e:\`${label}\` {name: $name}) SET e.uid = $id`, {
        name: entity.name,
        id: "#player#",
      });
    }
  }

  // Create relationships
  for (const rel of story.relationships) {
    const srcLabel = nameToLabel.get(rel.sourceName) ?? "Character";
    const tgtLabel = nameToLabel.get(rel.targetName) ?? "Location";
    await db.graph.mergeRelationship(
      srcLabel,
      "name",
      rel.sourceName,
      tgtLabel,
      "name",
      rel.targetName,
      rel.type,
      rel.description ? { description: rel.description } : undefined,
    );
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

    // Merge Disposition node (composite key: source_name, target_name)
    await db.graph.query(
      `MERGE (d:Disposition {source_name: $src, target_name: $tgt})
       ON CREATE SET d.uid = $uid, d.sentiment = $sentiment, d.summary = $summary, d._created_at = $now, d._updated_at = $now
       ON MATCH SET d.sentiment = $sentiment, d.summary = $summary, d._updated_at = $now`,
      {
        src: srcName,
        tgt: tgtName,
        uid: uuidv4(),
        sentiment: disp.sentiment,
        summary: disp.summary,
        now,
      },
    );

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
