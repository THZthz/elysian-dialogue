import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDb, teardownTestDb, getTestDb } from "../helpers";

describe("CheckpointManager", () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });

  it("lists empty checkpoints initially", async () => {
    const db = getTestDb();
    const list = await db.checkpoint.list();
    expect(list).toEqual([]);
  });

  it("throws if restoring nonexistent checkpoint", async () => {
    const db = getTestDb();
    await expect(db.checkpoint.restore(999)).rejects.toThrow();
  });
});
