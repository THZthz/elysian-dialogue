import * as fs from "fs";
import * as path from "path";
import { getMemoryClient } from "@/server/memory/client";
import { getQdrantClient } from "@/server/memory/qdrant";
import { RelationshipManager } from "@/server/relationshipManager";
import { NodeManager } from "@/server/nodeManager";

const CHECKPOINT_DIR = "data/checkpoints";
const SENTINEL_FILE = "data/.restore_in_progress";
const INDEX_FILE = "data/index.json";

interface CheckpointEntry {
  turnNumber: number;
  timestamp: string;
  neo4jFile: string;
  qdrantFile: string;
  nodeCount: number;
  relCount: number;
}

interface JsonlNode {
  type: "node";
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

interface JsonlRelationship {
  type: "relationship";
  id: string;
  label: string;
  start: { id: string; labels?: string[] };
  end: { id: string; labels?: string[] };
  properties: Record<string, unknown>;
}

type JsonlItem = JsonlNode | JsonlRelationship;

function checkpointDir(): string {
  return path.resolve(CHECKPOINT_DIR);
}

function sentinelPath(): string {
  return path.join(checkpointDir(), SENTINEL_FILE);
}

function indexPath(): string {
  return path.join(checkpointDir(), INDEX_FILE);
}

function loadIndex(): CheckpointEntry[] {
  try {
    return JSON.parse(fs.readFileSync(indexPath(), "utf-8")) as CheckpointEntry[];
  } catch {
    return [];
  }
}

function saveIndex(entries: CheckpointEntry[]): void {
  fs.writeFileSync(indexPath(), JSON.stringify(entries, null, 2), "utf-8");
}

function padTurn(n: number): string {
  return String(n).padStart(4, "0");
}

function parseJsonl(content: string): JsonlItem[] {
  const items: JsonlItem[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    items.push(JSON.parse(trimmed) as JsonlItem);
  }
  return items;
}

function collectExportLines(rows: Record<string, unknown>[]): {
  lines: string[];
  nodeCount: number;
  relCount: number;
} {
  let nodeCount = 0;
  let relCount = 0;
  const lines: string[] = [];

  for (const row of rows) {
    const raw = row.data;
    if (!raw) continue;
    if (typeof raw === "string") {
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (obj.type === "node") nodeCount++;
        else if (obj.type === "relationship") relCount++;
        lines.push(trimmed);
      }
    } else {
      const obj = raw as Record<string, unknown>;
      if (obj.type === "node") nodeCount++;
      else if (obj.type === "relationship") relCount++;
      lines.push(JSON.stringify(raw));
    }
  }

  return { lines, nodeCount, relCount };
}

export async function saveCheckpoint(turnNumber: number): Promise<void> {
  const dir = checkpointDir();
  fs.mkdirSync(dir, { recursive: true });

  const client = getMemoryClient();
  const qdrant = getQdrantClient();

  const rows = await client.neo4j.executeWrite(
    `CALL apoc.export.json.all(null, {stream: true, useTypes: true})
     YIELD data
     RETURN data`,
  );

  const { lines, nodeCount, relCount } = collectExportLines(rows);

  const neo4jFile = `turn_${padTurn(turnNumber)}_neo4j.jsonl`;
  fs.writeFileSync(path.join(dir, neo4jFile), lines.join("\n") + "\n", "utf-8");

  const snapshotInfo = await qdrant.createSnapshot();
  const snapshotData = await qdrant.downloadSnapshot(snapshotInfo.name);

  const qdrantFile = `turn_${padTurn(turnNumber)}_qdrant.snapshot`;
  fs.writeFileSync(path.join(dir, qdrantFile), Buffer.from(snapshotData));

  qdrant.deleteSnapshot(snapshotInfo.name).catch(() => {});

  const index = loadIndex();
  index.push({
    turnNumber,
    timestamp: new Date().toISOString(),
    neo4jFile,
    qdrantFile,
    nodeCount,
    relCount,
  });
  saveIndex(index);

  console.log(
    `[checkpoint] turn ${turnNumber} saved: ${nodeCount} nodes, ${relCount} relationships`,
  );
}

export async function restoreCheckpoint(
  turnNumber: number,
): Promise<{ restoredTo: number; deletedCheckpoints: number[] }> {
  const dir = checkpointDir();

  const sentinel = sentinelPath();
  if (fs.existsSync(sentinel)) {
    throw new Error(
      "A previous restore crashed. Delete data/checkpoints/.restore_in_progress and try again.",
    );
  }

  const index = loadIndex();
  const entry = index.find((e) => e.turnNumber === turnNumber);
  if (!entry) {
    throw new Error(`Checkpoint for turn ${turnNumber} not found`);
  }

  fs.writeFileSync(sentinel, new Date().toISOString(), "utf-8");

  try {
    const client = getMemoryClient();

    // 1. Parse checkpoint JSONL
    const neo4jSrc = path.join(dir, entry.neo4jFile);
    const content = fs.readFileSync(neo4jSrc, "utf-8");
    const items = parseJsonl(content);

    const nodes = items.filter((it): it is JsonlNode => it.type === "node");
    const relationships = items.filter((it): it is JsonlRelationship => it.type === "relationship");

    // 2. Wipe Neo4j
    await client.neo4j.executeWrite("MATCH (n) DETACH DELETE n");
    console.log("[checkpoint] Neo4j wiped for restore");

    // 3. Group nodes by label combination for batch creation
    const RESTORE_ID = "_chorus_restore_id";
    const labelGroups = new Map<string, Array<{ oldId: string; props: Record<string, unknown> }>>();
    for (const node of nodes) {
      const labelKey = [...node.labels].sort().join(",");
      const group = labelGroups.get(labelKey) || [];
      group.push({ oldId: node.id, props: node.properties });
      labelGroups.set(labelKey, group);
    }

    // 4. Create nodes in batches, tracking old APOC id → Neo4j elementId
    const idMap = new Map<string, string>();
    for (const [labelKey, batch] of labelGroups) {
      const labels = labelKey.split(",");
      const labelStr = labels.map((l) => `:\`${l}\``).join("");

      const batchParams = batch.map((b) => ({
        props: { ...b.props, [RESTORE_ID]: b.oldId },
      }));

      const rows = await client.neo4j.executeWrite(
        `UNWIND $batch AS item
         CREATE (n${labelStr})
         SET n = item.props
         RETURN n.${RESTORE_ID} AS oldId, elementId(n) AS elemId`,
        { batch: batchParams },
      );

      for (const row of rows) {
        idMap.set(row.oldId as string, row.elemId as string);
      }
    }
    console.log(`[checkpoint] ${nodes.length} nodes created`);

    // 5. Create relationships in batches
    let relCreated = 0;
    for (const rel of relationships) {
      const startElemId = idMap.get(rel.start.id);
      const endElemId = idMap.get(rel.end.id);
      if (!startElemId || !endElemId) {
        console.warn(`[checkpoint] skipping relationship ${rel.id}: missing endpoint(s)`);
        continue;
      }

      // Remove system properties that would conflict
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rel.properties)) {
        if (!k.startsWith("_")) props[k] = v;
      }

      await client.neo4j.executeWrite(
        `MATCH (a) WHERE elementId(a) = $startElemId
         MATCH (b) WHERE elementId(b) = $endElemId
         CREATE (a)-[r:\`${rel.label}\`]->(b)
         SET r = $props`,
        { startElemId, endElemId, props },
      );
      relCreated++;
    }
    console.log(`[checkpoint] ${relCreated} relationships created`);

    // 6. Remove temporary restore IDs from nodes
    await client.neo4j.executeWrite(
      `MATCH (n) WHERE n.${RESTORE_ID} IS NOT NULL
       REMOVE n.${RESTORE_ID}`,
    );

    // 7. Restore Qdrant from snapshot
    const qdrant = getQdrantClient();
    const qdrantSrc = path.join(dir, entry.qdrantFile);
    await qdrant.uploadSnapshot(qdrantSrc);
    console.log("[checkpoint] Qdrant snapshot restored");

    // 8. Reload GM_DEFINED types from restored Neo4j into in-memory registries
    const nodeManager = NodeManager.getCachedInstance();
    await nodeManager.reloadGmDefined(client.neo4j);
    const relManager = RelationshipManager.getCachedInstance();
    await relManager.reloadGmDefined(client.neo4j);

    // 9. Prune future checkpoints
    const deletedCheckpoints: number[] = [];
    const remaining = index.filter((e) => {
      if (e.turnNumber > turnNumber) {
        deletedCheckpoints.push(e.turnNumber);
        try {
          fs.unlinkSync(path.join(dir, e.neo4jFile));
        } catch {
          /* best effort */
        }
        try {
          fs.unlinkSync(path.join(dir, e.qdrantFile));
        } catch {
          /* best effort */
        }
        return false;
      }
      return true;
    });
    saveIndex(remaining);

    fs.unlinkSync(sentinel);

    return { restoredTo: turnNumber, deletedCheckpoints };
  } catch (err) {
    console.error("[checkpoint] restore failed:", err);
    throw err;
  }
}

export async function listCheckpoints(): Promise<CheckpointEntry[]> {
  return loadIndex();
}
