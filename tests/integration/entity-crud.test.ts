import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDb, teardownTestDb, getTestDb } from "../helpers";

describe("Entity CRUD", () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("creates a Character with vectors", async () => {
    const db = getTestDb();
    const entity = await db.entities.create("Character", {
      name: "Alice",
      brief: "A test character",
      description: "Alice is used for testing",
    });
    expect(entity.name).toBe("Alice");
    expect(entity.uid).toBeTruthy();
    expect(entity.isNew).toBe(true);

    const found = await db.entities.getByName("Character", "Alice");
    expect(found).not.toBeNull();
    expect(found!.brief).toBe("A test character");

    // Verify vector was stored
    const vectors = db.vectors.getAllByFilter("Character", "node");
    expect(vectors.length).toBeGreaterThanOrEqual(1);
    expect(vectors.some((v) => v.pointId === "Character:Alice")).toBe(true);
  });

  it("updates an entity and re-syncs vectors", async () => {
    const db = getTestDb();
    await db.entities.create("Character", { name: "Bob", brief: "Original" });
    await db.entities.update(
      "Character",
      { name: "Bob" },
      { brief: "Updated brief", description: "New desc" },
    );
    const entity = await db.entities.getByName("Character", "Bob");
    expect(entity?.brief).toBe("Updated brief");
    expect(entity?.description).toBe("New desc");
  });

  it("deletes an entity and removes vectors (vectors first, then graph)", async () => {
    const db = getTestDb();
    await db.entities.create("Character", { name: "Charlie" });
    const deleted = await db.entities.delete("Character", { name: "Charlie" });
    expect(deleted).toBe(1);
    const found = await db.entities.getByName("Character", "Charlie");
    expect(found).toBeNull();
    const vectors = db.vectors.getAllByFilter("Character", "node");
    expect(vectors.some((v) => v.pointId === "Character:Charlie")).toBe(false);
  });

  it("getById finds entity across all entity types", async () => {
    const db = getTestDb();
    const obj = await db.entities.create("Object", { name: "Sword" });
    const found = await db.entities.getById(obj.uid);
    expect(found).not.toBeNull();
    expect(found!.name).toBe("Sword");
  });

  it("creates entities of all three types", async () => {
    const db = getTestDb();
    const char = await db.entities.create("Character", { name: "NPC1" });
    const obj = await db.entities.create("Object", { name: "Item1" });
    const loc = await db.entities.create("Location", { name: "Room1" });
    expect(char.label).toBe("Character");
    expect(obj.label).toBe("Object");
    expect(loc.label).toBe("Location");
  });

  it("stores metadata with aliases", async () => {
    const db = getTestDb();
    const entity = await db.entities.create("Character", {
      name: "Duke",
      metadata: { aliases: ["The Duke", "His Grace"], stats: { MIGHT: 5 } },
    });
    const found = await db.entities.getByName("Character", "Duke");
    expect(found!.aliases).toEqual(["The Duke", "His Grace"]);
    expect(found!.metadata.stats).toEqual({ MIGHT: 5 });
  });
});
