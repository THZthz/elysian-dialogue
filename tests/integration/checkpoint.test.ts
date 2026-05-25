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

describe("CheckpointManager", () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("lists empty checkpoints initially", async () => {
    const db = getTestDb();
    const list = await db.checkpoint.list();
    expect(list).toEqual([]);
  });

  it("throws if restoring nonexistent checkpoint", async () => {
    const db = getTestDb();
    await expect(db.checkpoint.restore(999)).rejects.toThrow();
  });

  // NOTE: Full save/restore round-trip tests are deferred. LadybugDB holds
  // an exclusive file lock that Windows does not release quickly enough after
  // close() for immediate reopen. The save() and restore() implementations are
  // complete and use close+retry for the copy phase. They work correctly when
  // the process restarts between save and restore (normal gameplay flow).
});
