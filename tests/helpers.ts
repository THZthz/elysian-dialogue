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
import { setEmbedder } from "@/server/search/embedder";
import type { Embedder } from "@/server/search/embedder";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

class StubEmbedder implements Embedder {
  readonly dimensions = 4;
  async embed(_text: string): Promise<number[]> {
    return [0.1, 0.2, 0.3, 0.4];
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
  }
}

let testDir: string;
let db: Database;

export async function setupTestDb(): Promise<Database> {
  // Inject stub embedder to avoid llama-server dependency
  setEmbedder(new StubEmbedder());

  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-test-"));
  const graphPath = path.join(testDir, "test.lbug");
  const vectorPath = path.join(testDir, "test_vectors.db");
  const checkpointDir = path.join(testDir, "checkpoints");

  db = await Database.getInstance({ graphPath, vectorPath, checkpointDir });
  return db;
}

export function getTestDb(): Database {
  if (!db) throw new Error("Call setupTestDb() first");
  return db;
}

export async function teardownTestDb(): Promise<void> {
  await Database.closeInstance();
  if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
}

export async function resetDb(): Promise<void> {
  await Database.getExisting().reset();
}

export async function exec(
  query: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const result = await Database.getExisting().graph.query(query, params);
  return result.rows;
}

export function parseToolOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}
