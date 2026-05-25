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

describe("TimeModel", () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("sets initial time and retrieves it", async () => {
    const db = getTestDb();
    await db.time.setInitialTime(1, 8, "Morning");
    const tp = await db.time.getCurrentTimePoint();
    expect(tp).not.toBeNull();
    expect(tp!.day).toBe(1);
    expect(tp!.hour).toBe(8);
    expect(tp!.label).toBe("Morning");
  });

  it("advances game time by half hours", async () => {
    const db = getTestDb();
    await db.time.setInitialTime(1, 8, "Morning");
    const newTp = await db.time.advanceGameTime(4); // +2 hours
    expect(newTp.day).toBe(1);
    expect(newTp.hour).toBe(10);
  });

  it("advances game time across day boundary", async () => {
    const db = getTestDb();
    await db.time.setInitialTime(1, 22, "Night");
    const newTp = await db.time.advanceGameTime(8); // +4 hours
    expect(newTp.day).toBe(2);
    expect(newTp.hour).toBe(2);
  });

  it("advances with reason on NEXT_TIMEPOINT", async () => {
    const db = getTestDb();
    await db.time.setInitialTime(1, 12, "Noon");
    const newTp = await db.time.advanceGameTime(2, "The party rested");
    // Query the NEXT_TIMEPOINT relationship to verify reason
    const r = await db.graph.query(
      "MATCH (:TimePoint {day: 1, hour: 12})-[rel:NEXT_TIMEPOINT]->(:TimePoint {day: $day, hour: $hour}) RETURN rel.reason AS reason",
      { day: newTp.day, hour: newTp.hour },
    );
    expect(r.rows[0]?.reason).toBe("The party rested");
  });
});
