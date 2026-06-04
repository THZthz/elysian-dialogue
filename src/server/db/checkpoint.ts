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
  messageFile: string;
  createdAt: string;
}

async function reopenWithRetry(reopenCallback: () => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await reopenCallback();
      return;
    } catch (err) {
      if (attempt === 9) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Copy a file by reading into memory then writing — avoids Windows EBUSY on
 *  copyFile() which can fail even when open(O_RDONLY) succeeds. */
async function copyViaBuffer(src: string, dest: string): Promise<void> {
  const buf = await fsp.readFile(src);
  await fsp.writeFile(dest, buf);
}

export class CheckpointManager {
  private readonly graphPath: string;
  private readonly vectorPath: string;
  private readonly messageLogPath: string;
  private readonly dir: string;

  constructor(
    graphPath: string,
    vectorPath: string,
    checkpointDir: string,
    messageLogPath: string,
  ) {
    this.graphPath = graphPath;
    this.vectorPath = vectorPath;
    this.messageLogPath = messageLogPath;
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
    const messageDest = path.join(turnDir, path.basename(this.messageLogPath));

    // closeCallback calls Database.closeSync() — LadybugDB lock is released
    // before this Promise resolves, but Windows OS handles may linger.
    await closeCallback();
    await new Promise((r) => setTimeout(r, 250));

    let copyError: unknown = null;
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await copyViaBuffer(this.graphPath, graphDest);
          break;
        } catch (err) {
          if (attempt === 9) copyError = err;
          else await new Promise((r) => setTimeout(r, 500));
        }
      }

      if (!copyError) {
        // Copy WAL if present (may contain unflushed data on Windows)
        const walPath = this.graphPath + ".wal";
        if (fs.existsSync(walPath)) {
          await fsp.copyFile(walPath, graphDest + ".wal");
        }
        await fsp.copyFile(this.vectorPath, vectorDest);
        if (fs.existsSync(this.messageLogPath)) {
          await fsp.copyFile(this.messageLogPath, messageDest);
        }
      }
    } finally {
      // Always reopen — if this fails the server is dead regardless
      await reopenWithRetry(reopenCallback);
    }

    if (copyError) throw copyError;

    const index = this.loadIndex();
    index.push({
      turn: turnNumber,
      graphFile: graphDest,
      vectorFile: vectorDest,
      messageFile: messageDest,
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

    if (fs.existsSync(entry.messageFile)) {
      fs.copyFileSync(entry.messageFile, this.messageLogPath);
    }

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
