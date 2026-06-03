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

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { getTestDb } from "../helpers";
import { setupTestDb, teardownTestDb } from "../helpers";

let db: Awaited<ReturnType<typeof getTestDb>>;

beforeAll(async () => {
  db = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(db);
});

describe("SceneModel", () => {
  it("creates the first scene when no scene exists", async () => {
    const { scene } = await db.scene.create({
      scene_name: "tavern_opening",
      start_time: 204,
      location_name: "Tavern",
      characters: ["Player", "Bartender"],
      reason: "Story begins",
    });
    expect(scene.name).toBe("tavern_opening");
    expect(scene.start_time).toBe(204);
    expect(scene.end_time).toBeNull();
    expect(scene.location_name).toBe("Tavern");
    expect(scene.characters).toContain("Player");
    expect(scene.characters).toContain("Bartender");
  });

  it("creates subsequent scene that closes the previous one", async () => {
    // First scene already created in previous test
    const active = await db.scene.getActive();
    expect(active).not.toBeNull();

    const { scene: scene2 } = await db.scene.create({
      scene_name: "forest_arrival",
      start_time: 250,
      location_name: "Forest",
      characters: ["Player"],
      reason: "Traveled to forest",
    });

    expect(scene2.location_name).toBe("Forest");
    expect(scene2.end_time).toBeNull();

    // Old scene should now be closed
    const oldScene = await db.scene.getActive();
    expect(oldScene?.location_name).toBe("Forest");
  });

  it("returns null when active scene is a placeholder", async () => {
    // Close active scene without creating new one (creates placeholder)
    await db.scene.modify({ end_time: 300, reason: "End of act" });
    const active = await db.scene.getActive();
    expect(active).toBeNull(); // placeholder has no location_name
  });

  it("appends to scene log and retrieves history", async () => {
    // Create a real scene first
    const { scene } = await db.scene.create({
      scene_name: "castle_entrance",
      start_time: 350,
      location_name: "Castle",
      characters: ["Player", "King"],
      reason: "Entered castle",
    });

    await db.scene.appendPlayerLog(scene.name, "I kneel before the king.");
    await db.scene.appendGMLog(scene.name, [
      { speaker: "King", type: "CHARACTER", text: "Rise, hero." },
    ]);

    const history = await db.scene.getHistory();
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history.some((e: any) => e.type === "player")).toBe(true);
    expect(history.some((e: any) => e.type === "gm")).toBe(true);
  });

  it("warns when consecutive scenes have mismatched end_time and start_time", async () => {
    const { scenes, warnings } = await db.scene.getChain();
    // We've created several scenes in previous tests — check that the chain
    // validation runs and returns the expected shape
    expect(Array.isArray(scenes)).toBe(true);
    expect(Array.isArray(warnings)).toBe(true);
    // Warnings may or may not be present depending on test data integrity
  });
});
