
import * as fs from "fs";
import * as path from "path";

export interface CheckpointEntry {
  turn: number;
  graphFile: string;
  vectorFile: string;
  createdAt: string;
}

export class CheckpointManager {
  private readonly graphPath: string;
  private readonly vectorPath: string;
  private readonly dir: string;

  constructor(graphPath: string, vectorPath: string, checkpointDir: string) {
    this.graphPath = graphPath;
    this.vectorPath = vectorPath;
    this.dir = checkpointDir;
  }

  async save(turnNumber: number): Promise<void> {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });

    const turnDir = path.join(this.dir, `turn_${String(turnNumber).padStart(4, "0")}`);
    fs.mkdirSync(turnDir, { recursive: true });

    const graphDest = path.join(turnDir, "graph.lbug");
    const vectorDest = path.join(turnDir, "vectors.db");

    // Copy .lbug + .lbug.wal together for a consistent WAL-based snapshot
    const walPath = this.graphPath + ".wal";
    fs.copyFileSync(this.graphPath, graphDest);
    if (fs.existsSync(walPath)) {
      fs.copyFileSync(walPath, graphDest + ".wal");
    }
    fs.copyFileSync(this.vectorPath, vectorDest);

    const index = this.loadIndex();
    index.push({ turn: turnNumber, graphFile: graphDest, vectorFile: vectorDest, createdAt: new Date().toISOString() });
    fs.writeFileSync(path.join(this.dir, "index.json"), JSON.stringify(index, null, 2));
  }

  async restore(turnNumber: number): Promise<void> {
    const sentinelPath = path.join(this.dir, ".restore_in_progress");
    if (fs.existsSync(sentinelPath)) {
      throw new Error("Restore already in progress — sentinel file exists from a prior crashed restore");
    }

    const index = this.loadIndex();
    const entry = index.find((e) => e.turn === turnNumber);
    if (!entry) throw new Error(`Checkpoint for turn ${turnNumber} not found`);

    fs.writeFileSync(sentinelPath, "");

    if (!fs.existsSync(entry.graphFile)) throw new Error(`Checkpoint graph file missing: ${entry.graphFile}`);
    if (!fs.existsSync(entry.vectorFile)) throw new Error(`Checkpoint vector file missing: ${entry.vectorFile}`);

    fs.copyFileSync(entry.graphFile, this.graphPath);
    // Also restore .wal file if present in checkpoint
    const checkpointWal = entry.graphFile + ".wal";
    const currentWal = this.graphPath + ".wal";
    if (fs.existsSync(checkpointWal)) {
      fs.copyFileSync(checkpointWal, currentWal);
    } else if (fs.existsSync(currentWal)) {
      fs.unlinkSync(currentWal); // Remove stale WAL from different version
    }
    fs.copyFileSync(entry.vectorFile, this.vectorPath);

    // Validate restored file before removing sentinel
    try {
      const lbug = await import("@ladybugdb/core");
      const testDb = new lbug.Database(this.graphPath, true); // read_only
      const testConn = new lbug.Connection(testDb);
      try {
        await testConn.query("MATCH (n) RETURN count(n) AS cnt LIMIT 1");
      } finally {
        await testConn.close();
        await testDb.close();
      }
    } catch (err) {
      // Validation failed — keep sentinel to block further restores
      throw new Error(`Restored checkpoint file is corrupt: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Delete later checkpoints
    const later = index.filter((e) => e.turn > turnNumber);
    for (const e of later) {
      const d = path.join(this.dir, `turn_${String(e.turn).padStart(4, "0")}`);
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true });
    }
    const remaining = index.filter((e) => e.turn <= turnNumber);
    fs.writeFileSync(path.join(this.dir, "index.json"), JSON.stringify(remaining, null, 2));

    fs.unlinkSync(sentinelPath);
  }

  async list(): Promise<CheckpointEntry[]> {
    return this.loadIndex();
  }

  private loadIndex(): CheckpointEntry[] {
    const indexPath = path.join(this.dir, "index.json");
    if (!fs.existsSync(indexPath)) return [];
    try {
      return JSON.parse(fs.readFileSync(indexPath, "utf-8")) as CheckpointEntry[];
    } catch {
      return [];
    }
  }
}
