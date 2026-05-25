import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDb, teardownTestDb, getTestDb } from "@/tests/helpers";

describe("MessageModel", () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });

  it("creates and retrieves messages", async () => {
    const db = getTestDb();
    const msg = await db.messages.addMessage("Hello world", { speaker: "Player" });
    expect(msg.id).toBeTruthy();
    expect(msg.content).toBe("Hello world");
    expect(msg.metadata.speaker).toBe("Player");

    const history = await db.messages.getConversation();
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history.some(m => m.id === msg.id)).toBe(true);
  });

  it("saves and loads game options", async () => {
    const db = getTestDb();
    await db.messages.saveCurrentOptions([{ text: "Go north", skill: "MIGHT", difficulty: 10 }]);
    const opts = await db.messages.getCurrentOptions();
    expect(opts).not.toBeNull();
    expect(Array.isArray(opts!.options)).toBe(true);
  });

  it("saves and loads GM messages with turn tracking", async () => {
    const db = getTestDb();
    await db.messages.saveGMMessages([
      { role: "assistant", content: [{ type: "text", text: "The room darkens." }] },
    ], 1);

    const loaded = await db.messages.loadGMMessages();
    expect(loaded.length).toBeGreaterThan(0);
    expect(loaded[0].role).toBe("assistant");
  });

  it("getNextTurnNumber increments correctly", async () => {
    const db = getTestDb();
    const turn1 = await db.messages.getNextTurnNumber();
    await db.messages.saveGMMessages([{ role: "assistant", content: [{ type: "text", text: "Turn 1" }] }], turn1);
    const turn2 = await db.messages.getNextTurnNumber();
    expect(turn2).toBe(turn1 + 1);
  });
});
