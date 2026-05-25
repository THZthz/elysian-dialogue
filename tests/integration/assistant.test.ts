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

import { delegateToAssistant, type AssistantContext } from "@/server/assistant";
import { queryWorld } from "@/server/assistant/tools/queryWorld";
import { resetDb, exec, parseToolOutput } from "../helpers";

const emptyContext: AssistantContext = {
  recentConversation: "",
  gmToolCalls: [],
  turnNumber: 1,
};

describe("delegateToAssistant", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("returns character names from the seed database when asked", async () => {
    const result = await delegateToAssistant(
      "List all Character nodes with their names and briefs. Return as a bulleted list.",
      emptyContext,
    );
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain("ERROR:");
    // Seed has at least "Elara" — the Assistant should find it
    expect(result).toMatch(/Elara/i);
  }, 30000);

  it("returns error for nonsense requests gracefully", async () => {
    const result = await delegateToAssistant(
      "XYZPDQ invalid nonsense query that makes no sense whatsoever",
      emptyContext,
    );
    expect(typeof result).toBe("string");
  }, 30000);

  it("can find a known entity by name", async () => {
    // Verify seed data exists first
    const verify = await exec(queryWorld, {
      action: "READ",
      query: "MATCH (c:Character {name: 'Elara'}) RETURN c.name, c.brief",
    });
    const verifyData = parseToolOutput(verify);
    expect(verifyData.rowCount).toBeGreaterThanOrEqual(1);

    const result = await delegateToAssistant(
      'Find the Character named "Elara". Tell me her name, brief, and any entities she is located at.',
      emptyContext,
    );
    expect(typeof result).toBe("string");
    expect(result).toMatch(/Elara/i);
  }, 30000);

  it("provides observations about world state (enrichment)", async () => {
    const result = await delegateToAssistant(
      "List all Plot nodes and their current status.",
      emptyContext,
    );
    expect(typeof result).toBe("string");
    // Seed database may have plots; check that it returns content
    expect(result.length).toBeGreaterThan(0);
  }, 30000);

  it("handles empty context gracefully", async () => {
    const result = await delegateToAssistant("list all characters", {} as AssistantContext);
    expect(typeof result).toBe("string");
    // Should handle missing fields without crashing
  }, 30000);
});
