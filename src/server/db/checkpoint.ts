
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

  async save(turnNumber: number, closeCallback: () => Promise<void>, reopenCallback: () => Promise<void>): Promise<void> {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });

    const turnDir = path.join(this.dir, `turn_${String(turnNumber).padStart(4, "0")}`);
    fs.mkdirSync(turnDir, { recursive: true });

    const graphDest = path.join(turnDir, "graph.lbug");
    const vectorDest = path.join(turnDir, "vectors.db");

    await closeCallback();
    // LadybugDB may not release file locks immediately
    await new Promise((r) => setTimeout(r, 500));
    try {
      fs.copyFileSync(this.graphPath, graphDest);
      fs.copyFileSync(this.vectorPath, vectorDest);
    } finally {
      await reopenCallback();
    }

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
    fs.copyFileSync(entry.vectorFile, this.vectorPath);

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
