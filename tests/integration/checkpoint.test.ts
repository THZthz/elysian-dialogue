import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDb, teardownTestDb, getTestDb } from "@/tests/helpers";

describe("CheckpointManager", () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });

  it("saves and lists checkpoints", async () => {
    const db = getTestDb();
    await db.checkpoint.save(1);
    const list = await db.checkpoint.list();
    expect(list.length).toBe(1);
    expect(list[0].turn).toBe(1);
  });

  it("multiple saves accumulate in order", async () => {
    const db = getTestDb();
    await db.checkpoint.save(1);
    await db.checkpoint.save(2);
    await db.checkpoint.save(3);
    const list = await db.checkpoint.list();
    expect(list.length).toBe(3);
    expect(list.map(l => l.turn)).toEqual([1, 2, 3]);
  });

  it("restore reverts database state", async () => {
    const db = getTestDb();
    await db.entities.create("Character", { name: "KeepMe" });
    await db.checkpoint.save(1);

    await db.entities.create("Character", { name: "DeleteMe" });
    await db.checkpoint.save(2);

    // Restore turn 1
    await db.close();
    await db.checkpoint.restore(1);
    await db.init();

    const kept = await db.entities.getByName("Character", "KeepMe");
    expect(kept).not.toBeNull();

    const deleted = await db.entities.getByName("Character", "DeleteMe");
    expect(deleted).toBeNull();
  });

  it("restore deletes later checkpoints", async () => {
    const db = getTestDb();
    await db.checkpoint.save(1);
    await db.checkpoint.save(2);
    await db.checkpoint.save(3);

    await db.close();
    await db.checkpoint.restore(2);
    await db.init();

    const list = await db.checkpoint.list();
    expect(list.length).toBe(2);
    expect(list.map(l => l.turn)).toEqual([1, 2]);
  });

  it("throws if restoring nonexistent checkpoint", async () => {
    const db = getTestDb();
    await expect(db.checkpoint.restore(999)).rejects.toThrow();
  });
});
