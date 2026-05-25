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
import * as fs from "fs";
import * as path from "path";
import { MemoryClient } from "@/server/memory/client";
import { clearNeo4jDatabase } from "@/server/memory/reset";
import { saveCheckpoint, restoreCheckpoint, listCheckpoints } from "@/server/checkpointManager";
import { getNodeManager } from "@/server/nodeManager";
import { RelationshipManager } from "@/server/relationshipManager";
import { manageSchema } from "@/server/assistant/tools/manageSchema";
import { editNode } from "@/server/assistant/tools/editNode";
import { editNote } from "@/server/tools/editNote";
import { editPlot } from "@/server/gm/tools/editPlot";
import { queryWorld } from "@/server/assistant/tools/queryWorld";
import { createAdvanceTimeTool } from "@/server/gm/tools/advanceTime";
import { exec, parseToolOutput, createMockEventEmitter, resetDb } from "../helpers";

const CHECKPOINT_DIR = path.resolve("data/checkpoints");
const SENTINEL_FILE = path.join(CHECKPOINT_DIR, ".restore_in_progress");

const TEST_CHAR_1_NAME = "checkpoint_test_guard_captain";
const TEST_CHAR_2_NAME = "checkpoint_test_thief";
const TEST_NOTE_NAME = "checkpoint_test_suspicious_activity";
const TEST_PLOT_NAME = "checkpoint_test_gate_infiltration";
const TEST_REL_TYPE = "GUARDS_CHECKPOINT_TEST";

describe("checkpointManager", () => {
  let advanceTimeTool: ReturnType<typeof createAdvanceTimeTool>;
  let initialDay: number;
  let initialHour: number;

  beforeAll(async () => {
    await MemoryClient.getInstance();
    await resetDb();

    // Clean leftover checkpoint directory from previous runs
    if (fs.existsSync(CHECKPOINT_DIR)) {
      fs.rmSync(CHECKPOINT_DIR, { recursive: true, force: true });
    }

    advanceTimeTool = createAdvanceTimeTool(createMockEventEmitter());

    // Capture seed initial TimePoint as reference
    const timeQr = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (a:TimeAnchor {_id: 'anchor'})-[:CURRENT_TIMEPOINT]->(tp:TimePoint) RETURN tp.hour AS hour, tp.day AS day`,
    });
    const timeData = parseToolOutput(timeQr);
    initialDay = (timeData.rows?.[0]?.day as number) ?? 1;
    initialHour = (timeData.rows?.[0]?.hour as number) ?? 8;
  });

  beforeEach(async () => {
    try {
      fs.unlinkSync(SENTINEL_FILE);
    } catch {
      /* ok */
    }
  });

  afterAll(async () => {
    if (fs.existsSync(CHECKPOINT_DIR)) {
      fs.rmSync(CHECKPOINT_DIR, { recursive: true, force: true });
    }
    await clearNeo4jDatabase();
  });

  // ── Turn 1: Schema + Entities ──

  async function turn1() {
    // Register a custom relationship type
    const msResult = await exec(manageSchema, {
      target: "RELATIONSHIP",
      action: "REGISTER",
      name: TEST_REL_TYPE,
      description: "A guard is posted at a location.",
      sourceLabel: "Character",
      targetLabel: "Location",
    });
    expect(msResult).toContain("Registered");

    // Create a Character
    const createChar = await exec(editNode, {
      nodeLabel: "Character",
      action: "CREATE",
      properties: {
        name: TEST_CHAR_1_NAME,
        description: "A stern guard captain in weathered plate armor.",
        brief: "Guard Captain at the North Gate",
      },
    });
    expect(createChar).toContain("created");

    // Create a Note about suspicious activity
    const createNote = await exec(editNote, {
      noteName: TEST_NOTE_NAME,
      action: "CREATE",
      content: "Guard rotations have been irregular. Someone may be bribing the watch.",
      aboutEntities: [TEST_CHAR_1_NAME],
    });
    expect(createNote).toContain("created");

    // Verify with queryWorld
    const qr = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (c:Character {name: '${TEST_CHAR_1_NAME}'}) RETURN c.name, c.description, c.brief`,
    });
    const data = parseToolOutput(qr);
    expect(data.rowCount).toBe(1);
  }

  // ── Turn 2: Update + Plot + Time ──

  async function turn2() {
    // Update the Character
    const updateChar = await exec(editNode, {
      nodeLabel: "Character",
      action: "UPDATE",
      match: { name: TEST_CHAR_1_NAME },
      properties: {
        description:
          "A grizzled guard captain in weathered plate armor, nursing an old war wound. He scans every passerby with suspicion.",
      },
    });
    expect(updateChar).toContain("updated");

    // Create a Plot
    const createPlot = await exec(editPlot, {
      plotName: TEST_PLOT_NAME,
      action: "CREATE",
      description: "Infiltrate the North Gate by exploiting the irregular guard rotations.",
      brief: "Gate infiltration plot",
      status: "PENDING",
      triggerCondition: "success == true && total >= 14",
    });
    expect(createPlot).toContain("created");

    // Advance time
    const atResult = await exec(advanceTimeTool, {
      hours: 2,
      reason: "The afternoon passes as the player observes the gate.",
    });
    expect(atResult).toContain("advanced");
  }

  // ── Turn 3: Another entity + delete note + activate plot ──

  async function turn3() {
    // Create a second Character
    const createChar2 = await exec(editNode, {
      nodeLabel: "Character",
      action: "CREATE",
      properties: {
        name: TEST_CHAR_2_NAME,
        description: "A nimble thief in dark leathers, known for picking pockets in the market.",
        brief: "Thief lurking near the gate",
      },
    });
    expect(createChar2).toContain("created");

    // Delete the Note
    const deleteNote = await exec(editNote, {
      noteName: TEST_NOTE_NAME,
      action: "DELETE",
    });
    expect(deleteNote).toContain("deleted");

    // Activate the Plot
    const updatePlot = await exec(editPlot, {
      plotName: TEST_PLOT_NAME,
      action: "UPDATE",
      status: "ACTIVE",
      setFlag: {
        flagId: "recon_complete",
        description: "Player has observed guard patterns for a full afternoon.",
      },
    });
    expect(updatePlot).toContain("updated");

    // Verify final state
    const qr = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (c:Character {name: '${TEST_CHAR_2_NAME}'}) RETURN c.name`,
    });
    const data = parseToolOutput(qr);
    expect(data.rowCount).toBe(1);
  }

  // ── Tests ──

  it("saves 3 checkpoints spanning manageSchema, editNode, editNote, editPlot, advanceTime, and queryWorld", async () => {
    await turn1();
    await saveCheckpoint(1);

    await turn2();
    await saveCheckpoint(2);

    await turn3();
    await saveCheckpoint(3);

    const checkpoints = await listCheckpoints();
    expect(checkpoints).toHaveLength(3);
    expect(checkpoints.map((c) => c.turnNumber)).toEqual([1, 2, 3]);

    // Each checkpoint should have meaningful node/rel counts
    for (const c of checkpoints) {
      expect(c.nodeCount).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(CHECKPOINT_DIR, c.neo4jFile))).toBe(true);
      expect(fs.existsSync(path.join(CHECKPOINT_DIR, c.qdrantFile))).toBe(true);
    }

    // Verify turn 3 state is intact
    const qr = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (n) RETURN count(n) AS c`,
    });
    const data = parseToolOutput(qr);
    const totalNodesTurn3 = data.rows?.[0]?.c as number;

    // Confirm all 3-turn data exists
    const char1Check = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (c:Character {name: '${TEST_CHAR_1_NAME}'}) RETURN c.description AS desc`,
    });
    expect(parseToolOutput(char1Check).rowCount).toBe(1);

    const char2Check = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (c:Character {name: '${TEST_CHAR_2_NAME}'}) RETURN c.name`,
    });
    expect(parseToolOutput(char2Check).rowCount).toBe(1);

    // Note should be deleted by turn 3
    const noteCheck = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (n:Note {name: '${TEST_NOTE_NAME}'}) RETURN n.name`,
    });
    expect(parseToolOutput(noteCheck).rowCount).toBe(0);

    // Plot should be ACTIVE
    const plotCheck = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (p:Plot {name: '${TEST_PLOT_NAME}'}) RETURN p.status AS status`,
    });
    const plotData = parseToolOutput(plotCheck);
    expect(plotData.rows?.[0]?.status).toBe("ACTIVE");
  });

  it("restores to turn 2 — prunes turn 3, turn-3 entities gone, note exists again, plot is PENDING", async () => {
    const result = await restoreCheckpoint(2);
    expect(result.restoredTo).toBe(2);
    expect(result.deletedCheckpoints).toEqual([3]);

    // Turn 3 data should be gone
    const char2Check = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (c:Character {name: '${TEST_CHAR_2_NAME}'}) RETURN c.name`,
    });
    expect(parseToolOutput(char2Check).rowCount).toBe(0);

    // Turn 1 + 2 data should still exist
    const char1Check = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (c:Character {name: '${TEST_CHAR_1_NAME}'}) RETURN c.description AS desc`,
    });
    const char1Data = parseToolOutput(char1Check);
    expect(char1Data.rowCount).toBe(1);
    // Should have the updated description from turn 2
    expect(char1Data.rows?.[0]?.desc).toContain("grizzled");

    // Note should exist (was deleted in turn 3, turn 2 still has it)
    const noteCheck = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (n:Note {name: '${TEST_NOTE_NAME}'}) RETURN n.content AS content`,
    });
    const noteData = parseToolOutput(noteCheck);
    expect(noteData.rowCount).toBe(1);
    expect(noteData.rows?.[0]?.content).toContain("bribing the watch");

    // Plot should be PENDING (activated in turn 3)
    const plotCheck = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (p:Plot {name: '${TEST_PLOT_NAME}'}) RETURN p.status AS status`,
    });
    const plotData = parseToolOutput(plotCheck);
    expect(plotData.rows?.[0]?.status).toBe("PENDING");

    // TimePoint should be at initial + 2 hours (turn 2 advanced by 2)
    const timeCheck = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (a:TimeAnchor {_id: 'anchor'})-[:CURRENT_TIMEPOINT]->(tp:TimePoint) RETURN tp.hour AS hour, tp.day AS day`,
    });
    const timeData = parseToolOutput(timeCheck);
    expect(timeData.rows?.[0]?.hour).toBe(initialHour + 2);
    expect(timeData.rows?.[0]?.day).toBe(initialDay);

    // Only 2 checkpoints remain
    const checkpoints = await listCheckpoints();
    expect(checkpoints).toHaveLength(2);
    expect(
      fs
        .readdirSync(CHECKPOINT_DIR)
        .filter((f) => f.startsWith("turn_"))
        .every((f) => !f.includes("0003")),
    ).toBe(true);
  });

  it("restores to turn 1 — GM_DEFINED schema, entity, and note exist; no plot, no time advances", async () => {
    const result = await restoreCheckpoint(1);
    expect(result.restoredTo).toBe(1);
    expect(result.deletedCheckpoints).toEqual([2]);

    // Turn 2 data gone
    const plotCheck = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (p:Plot {name: '${TEST_PLOT_NAME}'}) RETURN p.name`,
    });
    expect(parseToolOutput(plotCheck).rowCount).toBe(0);

    // Turn 1 character exists with original description
    const char1Check = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (c:Character {name: '${TEST_CHAR_1_NAME}'}) RETURN c.description AS desc`,
    });
    const char1Data = parseToolOutput(char1Check);
    expect(char1Data.rowCount).toBe(1);
    expect(char1Data.rows?.[0]?.desc).toContain("stern guard captain");

    // Note exists
    const noteCheck = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (n:Note {name: '${TEST_NOTE_NAME}'}) RETURN n.name`,
    });
    expect(parseToolOutput(noteCheck).rowCount).toBe(1);

    // Time should be at seed initial — turn 1 has no advanceTime call
    const timeCheck = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (a:TimeAnchor {_id: 'anchor'})-[:CURRENT_TIMEPOINT]->(tp:TimePoint) RETURN tp.hour AS hour, tp.day AS day`,
    });
    const timeData = parseToolOutput(timeCheck);
    expect(timeData.rows?.[0]?.hour).toBe(initialHour);
    expect(timeData.rows?.[0]?.day).toBe(initialDay);

    // GM_DEFINED relationship type should be reloaded in registry
    const relManager = RelationshipManager.getCachedInstance();
    expect(relManager.get(TEST_REL_TYPE, "Character", "Location")).toBeDefined();

    // Only 1 checkpoint remains
    const checkpoints = await listCheckpoints();
    expect(checkpoints).toHaveLength(1);
  });

  // ── Edge cases ──

  it("refuses restore when sentinel file exists from prior crash", async () => {
    fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });
    fs.writeFileSync(SENTINEL_FILE, "simulated crash");

    await expect(restoreCheckpoint(1)).rejects.toThrow("previous restore crashed");

    fs.unlinkSync(SENTINEL_FILE);
  });

  it("refuses restore for non-existent turn number", async () => {
    await expect(restoreCheckpoint(999)).rejects.toThrow("not found");
  });

  it("can restore idempotently to the same checkpoint", async () => {
    const result = await restoreCheckpoint(1);
    expect(result.restoredTo).toBe(1);
    expect(result.deletedCheckpoints).toEqual([]);

    // Data still intact after double-restore
    const qr = await exec(queryWorld, {
      action: "READ",
      query: `MATCH (c:Character {name: '${TEST_CHAR_1_NAME}'}) RETURN c.name`,
    });
    expect(parseToolOutput(qr).rowCount).toBe(1);
  });
});
