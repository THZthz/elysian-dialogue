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
import { setupTestDb, teardownTestDb, getTestDb } from "../helpers";

describe("NoteModel", () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("creates and retrieves a note", async () => {
    const db = getTestDb();
    await db.notes.create("test-note", "Some content here");
    const note = await db.notes.getByName("test-note");
    expect(note).not.toBeNull();
    expect(note!.name).toBe("test-note");
    expect(note!.content).toBe("Some content here");
  });

  it("updates note content", async () => {
    const db = getTestDb();
    await db.notes.create("update-note", "Original");
    await db.notes.update("update-note", "Updated content");
    const note = await db.notes.getByName("update-note");
    expect(note!.content).toBe("Updated content");
  });

  it("deletes a note", async () => {
    const db = getTestDb();
    await db.notes.create("delete-me", "Content");
    await db.notes.delete("delete-me");
    const note = await db.notes.getByName("delete-me");
    expect(note).toBeNull();
  });

  it("links note to an entity", async () => {
    const db = getTestDb();
    await db.entities.create("Character", { name: "LinkTarget" });
    await db.notes.create("linked-note", "About LinkTarget");
    await db.notes.linkToEntity("linked-note", "LinkTarget");
    const entities = await db.notes.getLinkedEntities("linked-note");
    expect(entities).toContain("LinkTarget");
  });

  it("links note to a plot", async () => {
    const db = getTestDb();
    await db.plots.create("TestPlot", "A test plot", "brief", "PENDING");
    await db.notes.create("plot-note", "About TestPlot");
    await db.notes.linkToPlot("plot-note", "TestPlot");
    const plots = await db.notes.getLinkedPlots("plot-note");
    expect(plots).toContain("TestPlot");
  });

  it("clears all links", async () => {
    const db = getTestDb();
    await db.entities.create("Character", { name: "ClearTarget" });
    await db.notes.create("clear-note", "Content");
    await db.notes.linkToEntity("clear-note", "ClearTarget");
    await db.notes.clearLinks("clear-note");
    const entities = await db.notes.getLinkedEntities("clear-note");
    expect(entities).toEqual([]);
  });
});
