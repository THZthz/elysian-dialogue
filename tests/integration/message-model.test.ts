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

describe("MessageModel (GMTurnMessage)", () => {
  it("saves and loads GM messages", async () => {
    const messages = [
      { role: "system", content: "You are a GM." },
      { role: "user", content: "Start the game." },
      { role: "assistant", content: "The tavern is dimly lit." },
    ];

    await db.messages.saveGMMessages(messages, 1);
    const loaded = await db.messages.loadGMMessages();

    expect(loaded.length).toBe(3);
    expect(loaded[0].role).toBe("system");
  });

  it("gets next turn number", async () => {
    const turn = await db.messages.getNextTurnNumber();
    expect(turn).toBeGreaterThanOrEqual(1);
  });
});
