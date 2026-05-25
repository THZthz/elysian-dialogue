import { Database } from "@/server/db";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let testDir: string;
let db: Database;

export async function setupTestDb(): Promise<Database> {
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

export async function exec(query: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]> {
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
