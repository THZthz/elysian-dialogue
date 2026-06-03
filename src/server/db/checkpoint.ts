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

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { Connection, Database } from "@ladybugdb/core";

export interface CheckpointEntry {
  turn: number;
  graphFile: string;
  vectorFile: string;
  createdAt: string;
}

async function reopenWithRetry(
  reopenCallback: () => Promise<void>,
  copyError: unknown,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await reopenCallback();
      return;
    } catch (err) {
      if (attempt === 9) throw copyError ?? err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
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

  async save(
    turnNumber: number,
    closeCallback: () => Promise<void>,
    reopenCallback: () => Promise<void>,
  ): Promise<void> {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });

    const turnDir = path.join(this.dir, `turn_${String(turnNumber).padStart(4, "0")}`);
    fs.mkdirSync(turnDir, { recursive: true });

    const graphDest = path.join(turnDir, "graph.lbug");
    const vectorDest = path.join(turnDir, "vectors.db");

    // closeCallback uses Database.closeSync() under the hood, so the
    // LadybugDB file lock is released before this Promise resolves.
    await closeCallback();

    // On Windows the OS file handle may outlive LadybugDB's close().
    // Poll until the file becomes readable, then copy with retry.
    let copyError: unknown = null;
    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          // Test readability first — a successful open-for-read means the
          // OS handle has been released and we can proceed.
          const handle = await fsp.open(this.graphPath, fs.constants.O_RDONLY);
          await handle.close();
          await fsp.copyFile(this.graphPath, graphDest);
          break;
        } catch (err) {
          if (attempt === 29) {
            copyError = err;
          } else {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
      }
      if (!copyError) {
        await fsp.copyFile(this.vectorPath, vectorDest);
      }
    } finally {
      await reopenWithRetry(reopenCallback, copyError);
    }
    if (copyError) throw copyError;

    const index = this.loadIndex();
    index.push({
      turn: turnNumber,
      graphFile: graphDest,
      vectorFile: vectorDest,
      createdAt: new Date().toISOString(),
    });
    fs.writeFileSync(path.join(this.dir, "index.json"), JSON.stringify(index, null, 2));
  }

  async restore(turnNumber: number): Promise<void> {
    const sentinelPath = path.join(this.dir, ".restore_in_progress");
    if (fs.existsSync(sentinelPath)) {
      throw new Error(
        "Restore already in progress — sentinel file exists from a prior crashed restore",
      );
    }

    const index = this.loadIndex();
    const entry = index.find((e) => e.turn === turnNumber);
    if (!entry) throw new Error(`Checkpoint for turn ${turnNumber} not found`);

    fs.writeFileSync(sentinelPath, "");

    if (!fs.existsSync(entry.graphFile))
      throw new Error(`Checkpoint graph file missing: ${entry.graphFile}`);
    if (!fs.existsSync(entry.vectorFile))
      throw new Error(`Checkpoint vector file missing: ${entry.vectorFile}`);

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
      const testDb = new Database(this.graphPath);
      const testConn = new Connection(testDb);
      try {
        await testConn.query("MATCH (n) RETURN count(n) AS cnt LIMIT 1");
      } finally {
        await testConn.close();
        await testDb.close();
      }
    } catch (err) {
      // Validation failed — keep sentinel to block further restores
      throw new Error(`Restored checkpoint file is corrupt`, {
        cause: err,
      });
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
