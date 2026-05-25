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

describe("PlotModel", () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("creates and retrieves a plot", async () => {
    const db = getTestDb();
    await db.plots.create("MainPlot", "A grand story", "brief desc", "PENDING", "trigger_here");
    const plot = await db.plots.getByName("MainPlot");
    expect(plot).not.toBeNull();
    expect(plot!.name).toBe("MainPlot");
    expect(plot!.status).toBe("PENDING");
    expect(plot!.trigger_condition).toBe("trigger_here");
  });

  it("updates plot properties", async () => {
    const db = getTestDb();
    await db.plots.create("UpdatePlot", "desc", "brief", "PENDING");
    await db.plots.update("UpdatePlot", { status: "ACTIVE", brief: "updated brief" });
    const plot = await db.plots.getByName("UpdatePlot");
    expect(plot!.status).toBe("ACTIVE");
    expect(plot!.brief).toBe("updated brief");
  });

  it("deletes a plot", async () => {
    const db = getTestDb();
    await db.plots.create("DeletePlot", "desc", "brief", "PENDING");
    await db.plots.delete("DeletePlot");
    const plot = await db.plots.getByName("DeletePlot");
    expect(plot).toBeNull();
  });

  it("sets and retrieves flags", async () => {
    const db = getTestDb();
    await db.plots.create("FlagPlot", "desc", "brief", "PENDING");
    await db.plots.setFlags("FlagPlot", ["urgent", "main-quest"]);
    const plot = await db.plots.getByName("FlagPlot");
    expect(plot!.flags.length).toBe(2);
    expect(plot!.flags.map((f) => f.flagId)).toContain("urgent");
  });

  it("branches and retrieves children", async () => {
    const db = getTestDb();
    await db.plots.create("ParentPlot", "parent desc", "brief", "ACTIVE");
    await db.plots.create("ChildPlot", "child desc", "brief", "PENDING");
    await db.plots.branch("ParentPlot", "ChildPlot");
    const parent = await db.plots.getByName("ParentPlot");
    expect(parent!.children).toContain("ChildPlot");
  });

  it("unbranches a child plot", async () => {
    const db = getTestDb();
    await db.plots.create("Parent2", "desc", "brief", "ACTIVE");
    await db.plots.create("Child2", "desc", "brief", "PENDING");
    await db.plots.branch("Parent2", "Child2");
    await db.plots.unbranch("Parent2", "Child2");
    const parent = await db.plots.getByName("Parent2");
    expect(parent!.children).not.toContain("Child2");
  });

  it("exports PLOT_STATUSES for Zod validation", async () => {
    const { PLOT_STATUSES } = await import("@/server/db/models/plots");
    expect(PLOT_STATUSES).toContain("PENDING");
    expect(PLOT_STATUSES).toContain("ACTIVE");
    expect(PLOT_STATUSES).toContain("COMPLETED");
    expect(PLOT_STATUSES).toContain("ABANDONED");
  });
});
