# Scene Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace TimePoint/advanceTime with Scene-based time management, add temporal relationships, and move narrative into Scene.log.

**Architecture:** Foundation-first: constants and schema changes first, then SceneModel (core data layer), then update dependent models and tools, then orchestration, then seed and API. Each task produces a compilable, testable state.

**Tech Stack:** TypeScript, LadybugDB (Cypher), Vercel AI SDK, Zod, Express

---

### Task 1: Constants and Event Types

**Files:**
- Modify: `src/shared/constants.ts`
- Modify: `src/shared/events.ts`

- [ ] **Step 1: Update shared/constants.ts — add MANAGE_SCENE, remove ADVANCE_TIME and SEGMENT_LABELS**

```typescript
// src/shared/constants.ts — replace TOOL_NAMES and remove SEGMENT_LABELS

export const TOOL_NAMES = {
  QUERY_WORLD: "queryWorld",
  GENERATE_DIALOGUE: "generateDialogueStep",
  MANAGE_SCENE: "manageScene",
  SEARCH_WORLD: "searchWorld",
  MANAGE_SCHEMA: "manageSchema",
  EDIT_NODE: "editNode",
  EDIT_RELATIONSHIP: "editRelationship",
  EDIT_NOTE: "editNote",
  EDIT_PLOT: "editPlot",
  GET_CONTEXT: "getContext",
} as const;

// Remove the entire SEGMENT_LABELS array — no longer needed
```

Edit the file: remove `ADVANCE_TIME` from TOOL_NAMES, add `MANAGE_SCENE` (before SEARCH_WORLD, matching alphabetical order), delete the `SEGMENT_LABELS` array entirely.

- [ ] **Step 2: Update shared/events.ts — replace time_update with scene_update**

```typescript
// src/shared/events.ts — replace TimeUpdateEvent with SceneUpdateEvent

// Remove: TimeUpdateEvent interface (lines 54-58)
// Add:
export interface SceneUpdateEvent {
  scene_id: string;
  start_time: number;
  end_time: number | null;
  location_name: string;
  characters: string[];
  reason: string | null;
}
```

Also update `SseEventMap` (line 75-85): replace `time_update: TimeUpdateEvent` with `scene_update: SceneUpdateEvent`.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Type errors from files still referencing `TOOL_NAMES.ADVANCE_TIME` and `SEGMENT_LABELS` — that's expected, will be fixed in later tasks. No errors in constants.ts or events.ts.

- [ ] **Step 4: Commit**

```
git add src/shared/constants.ts src/shared/events.ts
git commit -m "feat: add MANAGE_SCENE tool name, remove ADVANCE_TIME and SEGMENT_LABELS, add scene_update event"
```

---

### Task 2: Schema Registry Changes

**Files:**
- Modify: `src/server/db/schema.ts`
- Test: `tests/unit/schema.test.ts`

- [ ] **Step 1: Add Scene node definition to PREDEFINED_NODES**

In `src/server/db/schema.ts`, add before the Conversation definition:

```typescript
{
  name: "Scene",
  category: "PREDEFINED",
  description: "A narrative scene tracking time, location, characters, log, and dialogue options. Active scene has end_time IS NULL.",
  properties: [
    { name: "_uid", description: "UUID.", tags: ["string", "unique"] },
    { name: "start_time", description: "Scene start time: day * 48 + half-hour.", tags: ["number"] },
    { name: "end_time", description: "Scene end time. NULL = still active.", tags: ["number"] },
    { name: "location_name", description: "Location.name for this scene. NULL for placeholder scenes.", tags: ["string"] },
    { name: "characters", description: "JSON array of character names present in this scene.", tags: ["json"] },
    { name: "log", description: "JSON array of log entries (gm, player, roll types).", tags: ["json"] },
    { name: "options", description: "JSON: current dialogue options for the active scene.", tags: ["json"] },
    UPDATED_AT_PROP,
  ],
},
```

- [ ] **Step 2: Remove TimeAnchor, TimePoint, Message from PREDEFINED_NODES**

Delete the `TimePoint` node definition (lines 233-248), the `TimeAnchor` node definition (lines 249-254), and the `Message` node definition (lines 153-171).

- [ ] **Step 3: Add NEXT_SCENE relationship to PREDEFINED_RELS**

Add:

```typescript
{
  name: "NEXT_SCENE",
  sourceLabel: "Scene",
  targetLabel: "Scene",
  category: "PREDEFINED",
  description: "Chronological scene chain. Replaces NEXT_TIMEPOINT.",
  properties: [
    { name: "reason", description: "Why scene changed.", tags: ["string"] },
    UPDATED_AT_PROP,
  ],
},
```

- [ ] **Step 4: Add ABOUT_SCENE relationship, remove Message-related rels, add CARRIES**

Add ABOUT_SCENE:
```typescript
{
  name: "ABOUT_SCENE",
  sourceLabel: "Note",
  targetLabel: "Scene",
  category: "PREDEFINED",
  description: "Note about scene. Managed by `editNote`.",
  properties: [CREATED_AT_PROP],
},
```

Remove: `ABOUT_MESSAGE`, `HAS_MESSAGE`, `FIRST_MESSAGE`, `NEXT_MESSAGE`, `AT_TIME`, `CURRENT_TIMEPOINT`, `NEXT_TIMEPOINT` from PREDEFINED_RELS.

Add CARRIES:
```typescript
{
  name: "CARRIES",
  sourceLabel: "Character",
  targetLabel: "Object",
  category: "PREDEFINED",
  description: "Character carries object.",
  properties: [
    { name: "brief", description: "How the item is carried.", tags: ["string", "embedded_content"] },
    { name: "created_at", description: "Birth time: day * 48 + half-hour.", tags: ["number"] },
    { name: "valid_at", description: "Death time. NULL = still valid.", tags: ["number"] },
    UPDATED_AT_PROP,
  ],
},
```

- [ ] **Step 5: Add temporal props to state-changing relationship defs**

For each of LOCATED_AT (all 3 variants), LOCATED_IN, HAS_DISPOSITION, add `created_at` and `valid_at` to their properties arrays, after the existing `brief`/`CREATED_AT_PROP` entries. Example for LOCATED_AT Character→Location:

```typescript
{
  name: "LOCATED_AT",
  sourceLabel: "Character",
  targetLabel: "Location",
  category: "PREDEFINED",
  description: "Character at location.",
  properties: [
    { name: "brief", description: "Spatial position detail...", tags: ["string", "embedded_content"] },
    { name: "created_at", description: "Birth time: day * 48 + half-hour.", tags: ["number"] },
    { name: "valid_at", description: "Death time. NULL = still valid.", tags: ["number"] },
    UPDATED_AT_PROP,
  ],
},
```

Do the same for LOCATED_AT Object→Location, LOCATED_AT Object→Character, LOCATED_IN, and HAS_DISPOSITION.

- [ ] **Step 6: Update ACTIVE_AT and COMPLETED_AT targetLabel to Scene, add STARTED_AT**

Change `ACTIVE_AT` and `COMPLETED_AT` `targetLabel` from `"TimePoint"` to `"Scene"`. Add STARTED_AT:

```typescript
{
  name: "STARTED_AT",
  sourceLabel: "Plot",
  targetLabel: "Scene",
  category: "PREDEFINED",
  description: "Plot start time. Managed by `editPlot`.",
  properties: [CREATED_AT_PROP],
},
```

- [ ] **Step 7: Update getInternalTypeNames()**

Replace `"TimeAnchor"` with `"Scene"` in the array (or remove TimeAnchor). Scene should be visible in schema dumps.

- [ ] **Step 8: Update Conversation definition — remove options property**

In the Conversation node definition, remove the `options` property line:
```typescript
{ name: "options", description: "JSON: current dialogue options", tags: ["json"] },
```

- [ ] **Step 9: Run existing schema test to check for breakage**

Run: `npx vitest run tests/unit/schema.test.ts`
Expected: Many schema tests will fail because the predefined counts changed. That's expected — we'll fix tests in the final task. For now, just verify no unexpected errors (TypeScript errors from schema.ts itself would be the main concern).

- [ ] **Step 10: Commit**

```
git add src/server/db/schema.ts
git commit -m "feat: add Scene node, NEXT_SCENE, ABOUT_SCENE, CARRIES; remove TimePoint/TimeAnchor/Message; add temporal props to state-changing rels"
```

---

### Task 3: SceneModel

**Files:**
- Create: `src/server/db/models/scene.ts`
- Test: `tests/integration/scene-model.test.ts` (create this file)

- [ ] **Step 1: Create the test file with a failing test**

Create `tests/integration/scene-model.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setupTestDb, teardownTestDb } from "../helpers";

let db: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  db = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb(db);
});

describe("SceneModel", () => {
  it("creates the first scene when no active scene exists", async () => {
    const scene = await db.scene.create({
      start_time: 204,
      location_name: "Tavern",
      characters: ["Player", "Bartender"],
      reason: "Story begins",
    });

    expect(scene._uid).toBeDefined();
    expect(scene.start_time).toBe(204);
    expect(scene.end_time).toBeNull();
    expect(scene.location_name).toBe("Tavern");
    expect(scene.characters).toEqual(["Player", "Bartender"]);
    expect(scene.log).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/scene-model.test.ts --reporter=verbose`
Expected: FAIL — `db.scene` is undefined or SceneModel not found.

- [ ] **Step 3: Create SceneModel**

Create `src/server/db/models/scene.ts`:

```typescript
import { v4 as uuidv4 } from "uuid";
import type { LadybugClient } from "@/server/db/ladybug";

export interface SceneData {
  _uid: string;
  start_time: number;
  end_time: number | null;
  location_name: string | null;
  characters: string[];
  log: SceneLogEntry[];
  options: Record<string, unknown> | null;
  _updated_at: string;
}

export type SceneLogEntry =
  | { type: "gm"; content: SceneMessageContent[]; options?: Record<string, unknown> }
  | { type: "player"; content: string }
  | { type: "roll"; content: string; metadata?: Record<string, unknown> };

export interface SceneMessageContent {
  speaker: string;
  type: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface CreateSceneInput {
  start_time: number;
  location_name: string;
  characters: string[];
  reason: string;
}

export interface ModifySceneInput {
  add_characters?: string[];
  end_time?: number;
  reason?: string;
}

export class SceneModel {
  constructor(private readonly graph: LadybugClient) {}

  async getActive(): Promise<SceneData | null> {
    const result = await this.graph.query(
      "MATCH (s:Scene) WHERE s.end_time IS NULL RETURN s",
    );
    if (result.rows.length === 0) return null;
    const s = (result.rows[0].s || result.rows[0]) as Record<string, unknown>;
    if (!s.location_name) return null; // placeholder — treat as no active scene
    return this.parseScene(s);
  }

  async create(input: CreateSceneInput): Promise<SceneData> {
    const now = new Date().toISOString();
    const _uid = uuidv4();

    // Check if active scene is a placeholder
    const existingResult = await this.graph.query(
      "MATCH (s:Scene) WHERE s.end_time IS NULL RETURN s",
    );

    let oldScene: SceneData | null = null;
    let isPlaceholder = false;

    if (existingResult.rows.length > 0) {
      const s = (existingResult.rows[0].s || existingResult.rows[0]) as Record<string, unknown>;
      if (s.location_name) {
        oldScene = this.parseScene(s);
        isPlaceholder = false;
      } else {
        isPlaceholder = true;
        oldScene = { ...this.parseScene(s), location_name: null };
      }
    }

    if (oldScene && !isPlaceholder) {
      // Close the old scene
      await this.graph.query(
        "MATCH (s:Scene {_uid: $_uid}) SET s.end_time = $end_time, s._updated_at = $now",
        { _uid: oldScene._uid, end_time: input.start_time, now },
      );
    }

    if (isPlaceholder && oldScene) {
      // Populate the placeholder
      await this.graph.query(
        `MATCH (s:Scene {_uid: $_uid})
         SET s.start_time = $start_time, s.location_name = $loc, s.characters = $chars,
             s._updated_at = $now`,
        {
          _uid: oldScene._uid,
          start_time: input.start_time,
          loc: input.location_name,
          chars: JSON.stringify(input.characters),
          now,
        },
      );

      // Update the reason on the NEXT_SCENE relationship if needed
      await this.graph.query(
        `MATCH (:Scene)-[r:NEXT_SCENE]->(:Scene {_uid: $_uid})
         SET r.reason = $reason, r._updated_at = $now`,
        { _uid: oldScene._uid, reason: input.reason, now },
      );

      return this.getByUid(oldScene._uid) as Promise<SceneData>;
    }

    // Create brand new scene
    await this.graph.query(
      `CREATE (s:Scene {
         _uid: $_uid, start_time: $start_time, end_time: NULL,
         location_name: $loc, characters: $chars, log: $log,
         options: NULL, _updated_at: $now
       })`,
      {
        _uid,
        start_time: input.start_time,
        loc: input.location_name,
        chars: JSON.stringify(input.characters),
        log: JSON.stringify([]),
        now,
      },
    );

    if (oldScene) {
      // Link old to new
      await this.graph.mergeRelationship(
        "Scene", "_uid", oldScene._uid,
        "Scene", "_uid", _uid,
        "NEXT_SCENE",
        { reason: input.reason },
      );
    }

    return this.getByUid(_uid);
  }

  async modify(input: ModifySceneInput): Promise<SceneData | null> {
    const active = await this.getActiveRaw(); // raw — don't skip placeholders
    if (!active) return null;

    const now = new Date().toISOString();

    if (input.add_characters && input.add_characters.length > 0) {
      const merged = [...new Set([...active.characters, ...input.add_characters])];
      await this.graph.query(
        "MATCH (s:Scene {_uid: $_uid}) SET s.characters = $chars, s._updated_at = $now",
        { _uid: active._uid, chars: JSON.stringify(merged), now },
      );
    }

    if (input.end_time !== undefined) {
      // Close the current scene
      await this.graph.query(
        "MATCH (s:Scene {_uid: $_uid}) SET s.end_time = $end_time, s._updated_at = $now",
        { _uid: active._uid, end_time: input.end_time, now },
      );

      // Create placeholder
      const phUid = uuidv4();
      await this.graph.query(
        `CREATE (s:Scene {
           _uid: $_uid, start_time: $end_time, end_time: NULL,
           location_name: NULL, characters: $emptyArr, log: $emptyArr,
           options: NULL, _updated_at: $now
         })`,
        {
          _uid: phUid,
          end_time: input.end_time,
          emptyArr: JSON.stringify([]),
          now,
        },
      );

      await this.graph.mergeRelationship(
        "Scene", "_uid", active._uid,
        "Scene", "_uid", phUid,
        "NEXT_SCENE",
        { reason: input.reason ?? "" },
      );

      return this.getByUid(phUid);
    }

    return this.getActive();
  }

  async appendPlayerLog(sceneUid: string, userInput: string): Promise<void> {
    const entry: SceneLogEntry = { type: "player", content: userInput };
    const result = await this.graph.query(
      "MATCH (s:Scene {_uid: $_uid}) RETURN s.log AS log",
      { _uid: sceneUid },
    );
    const currentLog: SceneLogEntry[] = result.rows[0]?.log
      ? (JSON.parse(result.rows[0].log as string) as SceneLogEntry[])
      : [];
    currentLog.push(entry);
    await this.graph.query(
      "MATCH (s:Scene {_uid: $_uid}) SET s.log = $log, s._updated_at = $now",
      { _uid: sceneUid, log: JSON.stringify(currentLog), now: new Date().toISOString() },
    );
  }

  async appendGMLog(
    sceneUid: string,
    messages: SceneMessageContent[],
    options?: Record<string, unknown>,
  ): Promise<void> {
    const entry: SceneLogEntry = { type: "gm", content: messages, options };
    const result = await this.graph.query(
      "MATCH (s:Scene {_uid: $_uid}) RETURN s.log AS log",
      { _uid: sceneUid },
    );
    const currentLog: SceneLogEntry[] = result.rows[0]?.log
      ? (JSON.parse(result.rows[0].log as string) as SceneLogEntry[])
      : [];
    currentLog.push(entry);
    const now = new Date().toISOString();
    await this.graph.query(
      "MATCH (s:Scene {_uid: $_uid}) SET s.log = $log, s.options = $opts, s._updated_at = $now",
      { _uid: sceneUid, log: JSON.stringify(currentLog), opts: options ? JSON.stringify(options) : null, now },
    );
  }

  async saveOptions(sceneUid: string, options: unknown): Promise<void> {
    await this.graph.query(
      "MATCH (s:Scene {_uid: $_uid}) SET s.options = $options, s._updated_at = $now",
      { _uid: sceneUid, options: JSON.stringify(options), now: new Date().toISOString() },
    );
  }

  async getHistory(): Promise<SceneLogEntry[]> {
    const result = await this.graph.query(
      "MATCH (s:Scene) WHERE s.log IS NOT NULL RETURN s.log AS log ORDER BY s.start_time",
    );
    const allEntries: SceneLogEntry[] = [];
    for (const row of result.rows) {
      const log = row.log as string;
      if (log) {
        try {
          const entries = JSON.parse(log) as SceneLogEntry[];
          allEntries.push(...entries);
        } catch { /* skip unparseable */ }
      }
    }
    return allEntries;
  }

  async getChain(): Promise<SceneData[]> {
    const result = await this.graph.query(
      "MATCH (s:Scene) RETURN s ORDER BY s.start_time",
    );
    return result.rows.map((row) => {
      const s = (row.s || row) as Record<string, unknown>;
      return this.parseScene(s);
    });
  }

  private async getActiveRaw(): Promise<SceneData | null> {
    const result = await this.graph.query(
      "MATCH (s:Scene) WHERE s.end_time IS NULL RETURN s",
    );
    if (result.rows.length === 0) return null;
    const s = (result.rows[0].s || result.rows[0]) as Record<string, unknown>;
    return {
      _uid: s._uid as string,
      start_time: s.start_time as number,
      end_time: (s.end_time as number) ?? null,
      location_name: (s.location_name as string) ?? null,
      characters: (s.characters ? JSON.parse(s.characters as string) : []) as string[],
      log: (s.log ? JSON.parse(s.log as string) : []) as SceneLogEntry[],
      options: (s.options ? JSON.parse(s.options as string) : null) as Record<string, unknown> | null,
      _updated_at: (s._updated_at as string) ?? "",
    };
  }

  private async getByUid(_uid: string): Promise<SceneData> {
    const result = await this.graph.query(
      "MATCH (s:Scene {_uid: $_uid}) RETURN s", { _uid },
    );
    const s = (result.rows[0].s || result.rows[0]) as Record<string, unknown>;
    return this.parseScene(s);
  }

  private parseScene(s: Record<string, unknown>): SceneData {
    return {
      _uid: s._uid as string,
      start_time: s.start_time as number,
      end_time: (s.end_time as number) ?? null,
      location_name: (s.location_name as string) ?? null,
      characters: (s.characters ? JSON.parse(s.characters as string) : []) as string[],
      log: (s.log ? JSON.parse(s.log as string) : []) as SceneLogEntry[],
      options: (s.options ? JSON.parse(s.options as string) : null) as Record<string, unknown> | null,
      _updated_at: (s._updated_at as string) ?? "",
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/scene-model.test.ts --reporter=verbose`
Expected: PASS — or at least, the test compiles and runs. May fail if setupTestDb doesn't yet wire SceneModel. We'll add more tests in the final task.

- [ ] **Step 5: Commit**

```
git add src/server/db/models/scene.ts tests/integration/scene-model.test.ts
git commit -m "feat: add SceneModel with create, modify, log append, and history methods"
```

---

### Task 4: Update PlotModel.markPlotTimeRel

**Files:**
- Modify: `src/server/db/models/plots.ts:187-192`

- [ ] **Step 1: Rewrite markPlotTimeRel to use active Scene**

In `src/server/db/models/plots.ts`, replace the method body:

```typescript
async markPlotTimeRel(name: string, relType: string): Promise<void> {
  await this.graph.query(
    `MATCH (s:Scene) WHERE s.end_time IS NULL
     MATCH (p:Plot {name: $name})
     MERGE (p)-[r:\`${relType}\`]->(s)
     ON CREATE SET r._created_at = current_timestamp()`,
    { name },
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No new errors from plots.ts.

- [ ] **Step 3: Commit**

```
git add src/server/db/models/plots.ts
git commit -m "feat: update PlotModel.markPlotTimeRel to reference active Scene instead of TimePoint"
```

---

### Task 5: Update NoteModel — Remove ABOUT_MESSAGE, add ABOUT_SCENE

**Files:**
- Modify: `src/server/db/models/notes.ts`

- [ ] **Step 1: Update the Note interface**

Replace `linkedMessages: string[]` with `linkedScenes: string[]`:

```typescript
export interface Note {
  name: string;
  content: string;
  linkedEntities: string[];
  linkedScenes: string[];
  linkedPlots: string[];
}
```

- [ ] **Step 2: Remove linkToMessage, add linkToScene**

Delete `linkToMessage` method (lines 135-145). Add:

```typescript
async linkToScene(noteName: string, sceneUid: string): Promise<void> {
  await this.graph.mergeRelationship(
    "Note", "name", noteName,
    "Scene", "_uid", sceneUid,
    "ABOUT_SCENE",
  );
}
```

- [ ] **Step 3: Update clearLinks — remove ABOUT_MESSAGE, add ABOUT_SCENE**

Replace the ABOUT_MESSAGE line (line 163) with:
```typescript
await this.graph.query("MATCH (n:Note {name: $name})-[r:ABOUT_SCENE]->() DELETE r", {
  name: noteName,
});
```

- [ ] **Step 4: Remove getLinkedMessages, add getLinkedScenes**

Delete `getLinkedMessages` (lines 179-185). Add:

```typescript
async getLinkedScenes(noteName: string): Promise<string[]> {
  const r = await this.graph.query(
    "MATCH (n:Note {name: $name})-[:ABOUT_SCENE]->(s:Scene) RETURN s._uid AS uid",
    { name: noteName },
  );
  return r.rows.map((row) => row.uid as string);
}
```

- [ ] **Step 5: Update parseNote to use linkedScenes**

In `parseNote` (line 195), change `getLinkedMessages` to `getLinkedScenes`, and destructure into `linkedScenes`:

```typescript
private async parseNote(name: string, content: string): Promise<Note> {
  const [entities, scenes, plots] = await Promise.all([
    this.getLinkedEntities(name),
    this.getLinkedScenes(name),
    this.getLinkedPlots(name),
  ]);
  return { name, content, linkedEntities: entities, linkedScenes: scenes, linkedPlots: plots };
}
```

- [ ] **Step 6: Commit**

```
git add src/server/db/models/notes.ts
git commit -m "feat: replace ABOUT_MESSAGE with ABOUT_SCENE in NoteModel"
```

---

### Task 6: Strip MessageModel — Keep Only GMTurnMessage

**Files:**
- Modify: `src/server/db/models/messages.ts`

- [ ] **Step 1: Remove narrative message methods**

Delete these methods from `MessageModel`:
- `addMessage()` — entire method (lines 43-120)
- `getConversation()` — entire method (lines 122-133)
- `saveCurrentOptions()` — entire method (lines 135-140)
- `getCurrentOptions()` — entire method (lines 142-149)
- `getLastMessageId()` — private helper (lines 269-277)
- `createMessageLinks()` — private helper (lines 279-319)

Also remove the `vectors` and `embedder` constructor parameters — `MessageModel` now only needs `graph`:

```typescript
export class MessageModel {
  constructor(private readonly graph: LadybugClient) {}
  // ... keep only saveGMMessages, loadGMMessages, getNextTurnNumber, ensureConversation
}
```

Remove the `MemoryMessage` interface (line 26-30). Remove imports for `VectorStore`, `Embedder`, `getSchemaRegistry`, `nextId`.

- [ ] **Step 2: Remove linkToCurrentTime logic from addMessage callers check**

This is cleanup — the `addMessage` calls in `generateTurn()` will be replaced in Task 16.

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Errors from `generateTurn()` because it calls `db.messages.addMessage()` and `db.messages.saveCurrentOptions()`. These will be fixed in Task 16. No errors from messages.ts itself.

- [ ] **Step 4: Commit**

```
git add src/server/db/models/messages.ts
git commit -m "feat: strip MessageModel to GMTurnMessage-only; narrative and options moved to SceneModel"
```

---

### Task 7: Update Database Facade

**Files:**
- Modify: `src/server/db/index.ts`

- [ ] **Step 1: Wire SceneModel, update MessageModel constructor, remove TimeModel**

In `src/server/db/index.ts`:

1. Add import: `import { SceneModel } from "@/server/db/models/scene";`
2. Remove import: `import { TimeModel } from "@/server/db/models/time";`
3. Add property: `scene!: SceneModel;`
4. Remove property: `time!: TimeModel;`
5. In `init()`:
   - Change `this.messages = new MessageModel(this.graph, this.vectors, embedder);` to `this.messages = new MessageModel(this.graph);`
   - Add `this.scene = new SceneModel(this.graph);`
   - Remove `this.time = new TimeModel(this.graph);`

- [ ] **Step 2: Commit**

```
git add src/server/db/index.ts
git commit -m "feat: wire SceneModel into Database, remove TimeModel, update MessageModel constructor"
```

---

### Task 8: manageScene Tool

**Files:**
- Create: `src/server/llm/tools/manageScene.ts`
- Test: `tests/integration/scene-model.test.ts` (add to existing)

- [ ] **Step 1: Create the manageScene tool**

Create `src/server/llm/tools/manageScene.ts`:

```typescript
import { tool } from "ai";
import { z } from "zod";
import { Database } from "@/server/db";
import type { EventEmitter } from "@/server/llm/events";
import { wrapSafe } from "@/server/llm/tools/shared";
import { TOOL_NAMES } from "@/shared/constants";

const SCENE_ACTIONS = ["CREATE", "MODIFY"] as const;

function describeTime(time: number): string {
  const day = Math.floor(time / 48);
  const halfHours = time % 48;
  const hour = Math.floor(halfHours / 2);
  const minute = halfHours % 2 === 0 ? "00" : "30";
  const period = hour < 12 ? "AM" : "PM";
  const displayH = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `Day ${day}, ${displayH}:${minute} ${period}`;
}

const inputSchema = z.object({
  action: z.enum(SCENE_ACTIONS).describe("CREATE a new scene or MODIFY the active one."),
  start_time: z.number().nullable().optional().describe("Day * 48 + half-hour. Required for CREATE."),
  location_name: z.string().nullable().optional().describe("Location.name. Required for CREATE."),
  characters: z.array(z.string()).nullable().optional().describe("Character names. Required for CREATE. Must include player."),
  reason: z.string().nullable().optional().describe("Why scene changed. Stored on NEXT_SCENE."),
  add_characters: z.array(z.string()).nullable().optional().describe("MODIFY: merge into characters array."),
  end_time: z.number().nullable().optional().describe("MODIFY: close the active scene at this time."),
});

export function createManageSceneTool(events: EventEmitter) {
  return tool({
    title: TOOL_NAMES.MANAGE_SCENE,
    description: `
## Brief
Manage scene transitions. CREATE starts a new scene, MODIFY adjusts or closes the active scene.

## CREATE
Start a new scene. Closes the active scene (if any) and creates a new one.
- \`start_time\`: Day * 48 + half-hour (DOUBLE).
- \`location_name\`: Must match an existing Location.name.
- \`characters\`: Array of character names. Must include the player's name.
- \`reason\`: Why the scene is changing (e.g. "Player traveled to the forest").

## MODIFY
Adjust the active scene.
- \`add_characters\`: Append characters to the current scene's character list.
- \`end_time\`: Close the active scene at a specific time. Creates a placeholder for the next scene.

## Others
At most one Scene has \`end_time = NULL\` (the active scene). When CREATE is called, the old scene's
end_time is set and a NEXT_SCENE relationship links them.
`.trim(),
    inputSchema,
    execute: wrapSafe(async (args: z.infer<typeof inputSchema>) => {
      const db = Database.getExisting();

      if (args.action === "CREATE") {
        if (args.start_time == null || args.location_name == null || !args.characters?.length) {
          return "ERROR: CREATE requires start_time, location_name, and characters (non-empty array).";
        }
        if (!args.characters.includes("Player")) {
          return "ERROR: characters must include 'Player'.";
        }

        const scene = await db.scene.create({
          start_time: args.start_time,
          location_name: args.location_name,
          characters: args.characters,
          reason: args.reason ?? "",
        });

        events.emitSceneUpdate({
          scene_id: scene._uid,
          start_time: scene.start_time,
          end_time: scene.end_time,
          location_name: scene.location_name!,
          characters: scene.characters,
          reason: args.reason ?? null,
        });

        return `Scene created: ${describeTime(scene.start_time)} at "${scene.location_name}" with [${scene.characters.join(", ")}].`;
      }

      // MODIFY
      const active = await db.scene.getActive();
      if (!active) return "ERROR: No active scene to modify. Create a scene first.";

      if (args.add_characters?.length) {
        await db.scene.modify({ add_characters: args.add_characters });
      }
      if (args.end_time != null) {
        const placeholder = await db.scene.modify({ end_time: args.end_time, reason: args.reason ?? undefined });
        events.emitSceneUpdate({
          scene_id: active._uid,
          start_time: active.start_time,
          end_time: args.end_time,
          location_name: active.location_name!,
          characters: active.characters,
          reason: args.reason ?? null,
        });
        return `Scene closed at ${describeTime(args.end_time)}. A placeholder scene is ready for the next CREATE.${
          args.reason ? ` Reason: "${args.reason}"` : ""
        }`;
      }

      const updated = await db.scene.getActive();
      return `Scene modified. Current characters: [${updated?.characters.join(", ") ?? ""}].`;
    }, TOOL_NAMES.MANAGE_SCENE),
  });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Error about `events.emitSceneUpdate` — that method doesn't exist yet (will be added in Task 14). For now, just verify no other errors.

- [ ] **Step 3: Commit**

```
git add src/server/llm/tools/manageScene.ts
git commit -m "feat: add manageScene tool with CREATE and MODIFY actions"
```

---

### Task 9: Update editRelationship — Remove DELETE, Add Temporal Props

**Files:**
- Modify: `src/server/llm/tools/editRelationship.ts`

- [ ] **Step 1: Remove the DELETE branch from the Zod schema and execute**

In the inputSchema, change `REL_ACTIONS` from `["CREATE", "UPDATE", "DELETE"]` to `["CREATE", "UPDATE"]`.

Delete the entire DELETE branch in `execute` (lines 441-468 — the block starting with `// ── DELETE ──` through the end of delete return).

- [ ] **Step 2: Add TODO for auto-expiry**

At the top of the CREATE branch (after props validation), add:

```typescript
// TODO: auto-expire old relationship of same type+source when a new one is created
// (e.g., moving character to new location should expire old LOCATED_AT)
```

- [ ] **Step 3: Update description to remove DELETE references**

In the tool description, remove the DELETE section. Add a line about temporal properties:

```
## Others
All state-changing relationships (LOCATED_AT, LOCATED_IN, CARRIES, HAS_DISPOSITION) are
temporal — created_at and valid_at are managed automatically. Use UPDATE to set valid_at
to end a relationship instead of deleting.
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```
git add src/server/llm/tools/editRelationship.ts
git commit -m "feat: remove DELETE from editRelationship; add TODO for auto-expiry of temporal relationships"
```

---

### Task 10: Update editNote — aboutMessages → aboutScenes

**Files:**
- Modify: `src/server/llm/tools/editNote.ts`

- [ ] **Step 1: Update inputSchema and execute**

In the inputSchema (line 45+), replace `aboutMessages` with `aboutScenes`:

```typescript
aboutScenes: z
  .array(z.string())
  .nullable()
  .optional()
  .describe(
    "Scene _uid values to link this note to. Replaces existing ABOUT_SCENE links — pass [] to clear all.",
  ),
```

- [ ] **Step 2: Update CREATE and UPDATE branches**

In the CREATE branch, replace the `aboutMessages` loop with:
```typescript
if (args.aboutScenes) {
  for (const uid of args.aboutScenes) await db.notes.linkToScene(args.noteName, uid);
}
```

In the UPDATE branch, replace `aboutMessages` references with `aboutScenes`:
- Variable name: `aboutMessages` → `aboutScenes` everywhere
- The link rebuilding loop: `for (const uid of scenes) await db.notes.linkToScene(args.noteName, uid);`
- The linkedScenes field: `args.aboutScenes ?? existing.linkedScenes`

- [ ] **Step 3: Update the tool description**

Replace `aboutMessages` references in the description:
- `messages via \`aboutMessages\` (ABOUT_MESSAGE)` → `scenes via \`aboutScenes\` (ABOUT_SCENE)`
- Remove the ABOUT_MESSAGE line

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```
git add src/server/llm/tools/editNote.ts
git commit -m "feat: replace aboutMessages with aboutScenes in editNote tool"
```

---

### Task 11: Update editPlot — Scene Refs (Auto-wire)

**Files:**
- Modify: `src/server/llm/tools/editPlot.ts`

- [ ] **Step 1: Update tool description**

Replace the status flow description (line 76-78):
```
## Status flow
> PENDING → ACTIVE → COMPLETED / ABANDONED
Status transitions auto-wire time relationships (STARTED_AT, ACTIVE_AT, COMPLETED_AT) to the active
Scene — just set the \`status\` parameter.
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No new errors (the actual Cypher changes are in PlotModel, already done in Task 4).

- [ ] **Step 3: Commit**

```
git add src/server/llm/tools/editPlot.ts
git commit -m "feat: update editPlot description to reference Scene instead of TimePoint"
```

---

### Task 12: Update sceneContext.ts — Scene-Based Queries

**Files:**
- Modify: `src/server/llm/sceneContext.ts`

- [ ] **Step 1: Update buildSceneContext to use active Scene**

Replace the `buildSceneContext` function. The key changes:
1. Remove `db.time.getCurrentTimePoint()` — replace with `db.scene.getActive()`
2. Remove the `TimeAnchor`-based time lookup
3. Add `valid_at IS NULL` filter to LOCATED_AT/CARRIES queries

```typescript
export async function buildSceneContext(): Promise<string> {
  const db = Database.getExisting();

  const activeScene = await db.scene.getActive().catch((err) => {
    console.error("[sceneContext] getActive failed:", err instanceof Error ? err.message : String(err));
    return null;
  });

  const parts: string[] = [];
  parts.push("## SCENE CONTEXT (pre-loaded)");

  if (activeScene) {
    parts.push(`\n### Time\n${describeTime({ day: Math.floor(activeScene.start_time / 48), hour: (activeScene.start_time % 48) / 2 })}`);
    parts.push(`### Location\n${activeScene.location_name}`);
    parts.push(`### Characters Present\n${activeScene.characters.join(", ")}`);
  }

  try {
    const playerResult = await db.graph.query(
      `MATCH (player:Character {name: "Player"})
       OPTIONAL MATCH (player)-[loc_rel:LOCATED_AT]->(loc:Location)
       WHERE loc_rel.valid_at IS NULL
       RETURN player, loc`,
    );

    // ... rest of the queries similarly add valid_at IS NULL ...

    // Inventory query — use CARRIES instead of LOCATED_AT(Object→Character)
    const invResult = await db.graph.query(
      `MATCH (player:Character {name: "Player"})-[c:CARRIES]->(inv:Object)
       WHERE c.valid_at IS NULL
       RETURN inv`,
    );

    // NPCs at location
    const locName = activeScene?.location_name;
    if (locName) {
      const npcResult = await db.graph.query(
        `MATCH (npc:Character)-[r:LOCATED_AT]->(loc:Location {name: $locName})
         WHERE npc.name <> "Player" AND r.valid_at IS NULL
         RETURN npc`,
        { locName },
      );
      // ... process npcs ...

      const objResult = await db.graph.query(
        `MATCH (obj:Object)-[r:LOCATED_AT]->(loc:Location {name: $locName})
         WHERE r.valid_at IS NULL
         RETURN obj`,
        { locName },
      );
      // ... process objects ...
    }
  } catch (err) {
    // error handling unchanged
  }

  return parts.join("\n");
}
```

The full function is long — apply the pattern: 
- Replace every LOCATED_AT query to add `WHERE r.valid_at IS NULL` on the relationship variable
- Replace `(player)-[:CARRIES]->(inv:Object)` with `(player)-[c:CARRIES]->(inv:Object) WHERE c.valid_at IS NULL`
- In `buildRelationshipDump`, add `valid_at IS NULL` to the default query filter

- [ ] **Step 2: Update buildRelationshipDump default filter**

In `buildRelationshipDump`, change the query pattern to include `valid_at IS NULL` by default:

```typescript
// Existing loop over relDefs — in the Cypher query, add:
const r = await db.graph.query(
  `MATCH (a)-[r:\`${relDef.name}\`]->(b)
   WHERE r.valid_at IS NULL
   RETURN label(a) AS sourceLabel, COALESCE(a.name, a._uid) AS sourceName,
          type(r) AS type, properties(r) AS props,
          label(b) AS targetLabel, COALESCE(b.name, b._uid) AS targetName
   LIMIT 200`,
);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```
git add src/server/llm/sceneContext.ts
git commit -m "feat: update sceneContext to use active Scene, add valid_at IS NULL filters, use CARRIES for inventory"
```

---

### Task 13: Update getContext Tool

**Files:**
- Modify: `src/server/llm/tools/getContext.ts`

- [ ] **Step 1: Update SCHEMA_DUMP to reflect new types**

In `buildSchemaDump`, the internal names filter already handles this via `getInternalTypeNames()`. No code changes needed beyond the schema registry changes from Task 2.

- [ ] **Step 2: Update tool description**

Replace the SCENE_CONTEXT description line:
```
- SCENE_CONTEXT — Current scene time, location, characters, nearby NPCs/objects, inventory and NPC dispositions related to player.
```

- [ ] **Step 3: Commit**

```
git add src/server/llm/tools/getContext.ts
git commit -m "feat: update getContext SCENE_CONTEXT description for Scene-based model"
```

---

### Task 14: Update Events — emitTimeUpdate → emitSceneUpdate

**Files:**
- Modify: `src/server/llm/events.ts`

- [ ] **Step 1: Replace emitTimeUpdate with emitSceneUpdate**

Remove `emitTimeUpdate` method (lines 80-82). Add:

```typescript
emitSceneUpdate(data: {
  scene_id: string;
  start_time: number;
  end_time: number | null;
  location_name: string;
  characters: string[];
  reason: string | null;
}) {
  this.send("scene_update", data);
}
```

- [ ] **Step 2: Commit**

```
git add src/server/llm/events.ts
git commit -m "feat: replace emitTimeUpdate with emitSceneUpdate in TurnEventEmitter"
```

---

### Task 15: Update System Prompt

**Files:**
- Modify: `src/server/llm/prompt.ts`

- [ ] **Step 1: Rewrite the WORKFLOW section**

Replace the SENSE→DRAFT→SPEAK→PERSIST workflow (lines 24-68) with:

```typescript
const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `
You are the Game Master, proficient in telling coherent story and writing Cypher queries. Your task is to use given tools to narrate story and maintain world states. The database IS the world — if you don't persist it, it didn't happen. **You are talking with your assistant**. You speak to the player through \`${TOOL_NAMES.GENERATE_DIALOGUE}\`. Your story must use Latin-script only (no emoji, CJK, Cyrillic, or Arabic characters).

## WORKFLOW

### 1. SCENE START

Begin each scene by exploring the world state. Query the database to understand where the player is, who is nearby, what plots are active, and what notes you've left for yourself. Search notes to recall what you are tracking. Review plots to clarify the story arcs.

Tools to use:
- \`${TOOL_NAMES.GET_CONTEXT}\`
- \`${TOOL_NAMES.SEARCH_WORLD}\` (esp. :Note or :Plot)
- \`${TOOL_NAMES.QUERY_WORLD}\` (READ, free-form Cypher query)

### 2. IN-SCENE NARRATION

Your story should be scene-based like drama. Narrate the player forward with \`${TOOL_NAMES.GENERATE_DIALOGUE}\`. React to player actions by editing dispositions, plot flags, and world state. Write down notes for unresolved threads.

Note is best when it records an unresolved thread, or it serves as a reminder for your future self. Plots should be written IN ADVANCE. A great moment to write more plots is when the player activates a plot by satisfying its trigger condition.

Tools to use:
- \`${TOOL_NAMES.GENERATE_DIALOGUE}\`
- \`${TOOL_NAMES.EDIT_NOTE}\`
- \`${TOOL_NAMES.EDIT_PLOT}\`

### 3. SCENE END

When the scene concludes (location change, significant time passing, narrative break), call \`${TOOL_NAMES.MANAGE_SCENE}\` to transition. Then persist world changes: movement, items, dispositions, plot flags, etc. Use UPDATE on relationships to set \`valid_at\` when relationships end. Relationships are never deleted — their history is preserved via \`valid_at\`.

A Scene tracks time, location, and characters. The active scene is identified by \`end_time IS NULL\`. Scenes are linked in chronological order via NEXT_SCENE.

Tools to use:
- \`${TOOL_NAMES.MANAGE_SCENE}\`
- \`${TOOL_NAMES.EDIT_NODE}\`
- \`${TOOL_NAMES.EDIT_RELATIONSHIP}\`
- \`${TOOL_NAMES.EDIT_PLOT}\`
- \`${TOOL_NAMES.EDIT_NOTE}\`
- \`${TOOL_NAMES.MANAGE_SCHEMA}\` (if new types needed)
- \`${TOOL_NAMES.QUERY_WORLD}\` (WRITE)

When world state is maintained and there is nothing left to do, reply with a brief text summary (no tool call) to end your turn and wait for the player.

---

## CYPHER COOKBOOK

// ... keep everything from CYPHER COOKBOOK unchanged ...

---

## NARRATION TONE

{{tone_description}}

---

[OOC: This is adult roleplay. Characters act on desire, power, and instinct. Surprise player.]
`.trim();
```

Apply the edit: keep the CYPHER COOKBOOK section unchanged, keep NARRATION TONE unchanged, keep the OOC line — only the WORKFLOW section changes.

- [ ] **Step 2: Commit**

```
git add src/server/llm/prompt.ts
git commit -m "feat: rewrite system prompt workflow to Scene-based SCENE START / NARRATION / SCENE END phases"
```

---

### Task 16: Update LLM Orchestration (generateTurn)

**Files:**
- Modify: `src/server/llm/index.ts`

- [ ] **Step 1: Update imports**

Replace:
```typescript
import { createAdvanceTimeTool } from "@/server/llm/tools/advanceTime";
```
With:
```typescript
import { createManageSceneTool } from "@/server/llm/tools/manageScene";
```

- [ ] **Step 2: Replace player input persistence**

Change the `db.messages.addMessage(userInput)` call (line 81) to use Scene.log:

```typescript
// Persist player input to the active scene's log
try {
  const activeScene = await db.scene.getActive();
  if (activeScene) {
    await db.scene.appendPlayerLog(activeScene._uid, userInput);
  }
} catch (err) {
  console.error("[generateTurn] failed to log player input to scene:", err);
}
```

- [ ] **Step 3: Replace roll result persistence**

Change the roll result `db.messages.addMessage(...)` call (lines 139-149) to use Scene.log:

```typescript
try {
  const activeScene = await db.scene.getActive();
  if (activeScene) {
    await db.scene.appendRollLog(activeScene._uid, rollText, {
      speaker: check.skill,
      type: "ROLL",
      rollResult: { ... },
    });
  }
} catch (err) {
  console.error("[generateTurn] failed to log roll to scene:", err);
}
```

Note: this requires adding an `appendRollLog` method to SceneModel. Add it:

```typescript
// In SceneModel:
async appendRollLog(sceneUid: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
  const entry: SceneLogEntry = { type: "roll", content, metadata };
  const result = await this.graph.query(
    "MATCH (s:Scene {_uid: $_uid}) RETURN s.log AS log", { _uid: sceneUid },
  );
  const currentLog: SceneLogEntry[] = result.rows[0]?.log
    ? (JSON.parse(result.rows[0].log as string) as SceneLogEntry[])
    : [];
  currentLog.push(entry);
  await this.graph.query(
    "MATCH (s:Scene {_uid: $_uid}) SET s.log = $log, s._updated_at = $now",
    { _uid: sceneUid, log: JSON.stringify(currentLog), now: new Date().toISOString() },
  );
}
```

- [ ] **Step 4: Replace GM output persistence**

After `generateDialogueStep` validates (after the stream loop), append GM output to Scene.log:

```typescript
// After the stream loop, when finalMessages has content:
if (dialogueWasValid && finalMessages.length > 0) {
  try {
    const activeScene = await db.scene.getActive();
    if (activeScene) {
      await db.scene.appendGMLog(activeScene._uid, finalMessages as any, finalOptions as any);
    }
  } catch (err) {
    console.error("[generateTurn] failed to log GM output to scene:", err);
  }
}
```

- [ ] **Step 5: Replace saveCurrentOptions call**

Change `db.messages.saveCurrentOptions(finalOptions)` (line 549) to:

```typescript
if (finalOptions.length > 0) {
  try {
    const activeScene = await db.scene.getActive();
    if (activeScene) {
      await db.scene.saveOptions(activeScene._uid, finalOptions);
    }
  } catch (err) {
    console.error("[generateTurn] failed to persist options:", err);
  }
}
```

- [ ] **Step 6: Replace tool registration**

Change `allTools` to include manageScene instead of advanceTime:

```typescript
const manageSceneTool = createManageSceneTool(events);

const allTools = {
  queryWorld,
  searchWorld,
  manageSchema,
  editNode,
  editRelationship,
  editNote,
  editPlot,
  getContext,
  generateDialogueStep: dialogueStepTool.tool,
  manageScene: manageSceneTool,
};
```

- [ ] **Step 7: Update prepareStep nudge messages**

Replace any reference to `advanceTime` or `TOOL_NAMES.ADVANCE_TIME` with the scene equivalents. Update the PERSIST nudge to mention scene management:

```typescript
// In the "persist world state" nudge (around line 279):
const msg =
  `You've spoken to the player via ${TOOL_NAMES.GENERATE_DIALOGUE}. ` +
  "Now persist any world state changes (movement — UPDATE relationships with valid_at, items, dispositions, plot flags). " +
  "If the scene should end, call " + TOOL_NAMES.MANAGE_SCENE + ". " +
  "When done, reply with a brief text (no tool call) to end your turn.";
```

- [ ] **Step 8: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: Errors related to the removed `advanceTime.ts` import — that file still exists but won't be imported anymore. May also have errors from missing `appendRollLog` on SceneModel if not yet added.

- [ ] **Step 9: Commit**

```
git add src/server/llm/index.ts src/server/db/models/scene.ts
git commit -m "feat: wire manageScene into generateTurn, persist player/GM/roll to Scene.log, replace advanceTime"
```

---

### Task 17: Update API Routes

**Files:**
- Modify: `src/server/api.ts`

- [ ] **Step 1: Update /api/history to read from Scene.log**

Replace the `/api/history` handler (lines 76-99):

```typescript
apiRouter.get("/history", async (_req, res) => {
  try {
    const db = Database.getExisting();
    const logEntries = await db.scene.getHistory();
    const history: Message[] = [];
    for (let i = 0; i < logEntries.length; i++) {
      const entry = logEntries[i];
      if (entry.type === "gm") {
        for (const c of entry.content) {
          history.push({
            id: `msg_${i}`,
            speaker: c.speaker,
            type: (c.type as Message["type"]) || "SYSTEM",
            text: c.text,
            metadata: c.metadata as Message["metadata"],
          });
        }
      } else if (entry.type === "player") {
        history.push({
          id: `msg_${i}`,
          speaker: "YOU",
          type: "YOU",
          text: entry.content,
        });
      } else if (entry.type === "roll") {
        history.push({
          id: `msg_${i}`,
          speaker: entry.metadata?.speaker as string || "SYSTEM",
          type: "ROLL",
          text: entry.content,
          rollResult: entry.metadata?.rollResult as Message["rollResult"],
        });
      }
    }
    res.json(history);
  } catch (error: unknown) {
    console.error("History fetch error:", error);
    res.json([]);
  }
});
```

- [ ] **Step 2: Update /api/game/current to read from Scene**

Replace the handler (lines 103-113):

```typescript
apiRouter.get("/game/current", async (_req, res) => {
  try {
    const db = Database.getExisting();
    const active = await db.scene.getActive();
    if (active && active.options) {
      res.json({ id: active._uid, options: active.options });
    } else {
      res.json(null);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Session state fetch error:", message);
    res.json(null);
  }
});
```

- [ ] **Step 3: Update debug tool registry**

In the `debugToolRegistry`, add the new tool (only needed for instantiation):

```typescript
// No change needed — manageScene is created with events, so it can't be in the static registry.
// The debug registry only has stateless tools. manageScene is skipped.
```

- [ ] **Step 4: Commit**

```
git add src/server/api.ts
git commit -m "feat: rebuild /api/history from Scene.log, read /api/game/current from Scene.options"
```

---

### Task 18: Update Seed System

**Files:**
- Modify: `src/server/stories/types.ts`
- Modify: `src/server/stories/seed.ts`
- Modify: `src/server/stories/glass-cage.toml`

- [ ] **Step 1: Update types.ts — add initialScene, remove old fields**

```typescript
// Add to SeedStory interface:
export interface SeedScene {
  start_time: number;
  location_name: string;
  characters: string[];
}

// In SeedStory interface, remove: initialDay, initialSegment, initialLocationId
// Add: initialScene: SeedScene;
```

- [ ] **Step 2: Update seed.ts — seed Scene instead of TimeAnchor/TimePoint**

Replace the `setInitialTime` call (line 57-58) with:

```typescript
// Create initial Scene
await db.scene.create({
  start_time: story.initialScene.start_time,
  location_name: story.initialScene.location_name,
  characters: story.initialScene.characters,
  reason: "Opening scene",
});
console.log(`[seedDatabase] initial scene created at time ${story.initialScene.start_time} in "${story.initialScene.location_name}"`);
```

Remove the `import { SEGMENT_LABELS }` line. Remove the `hourToLabel` function.

- [ ] **Step 3: Update glass-cage.toml**

Replace:
```toml
initialDay = 4
initialSegment = 6
initialLocationId = "player_compartment"
```
With:
```toml
[initialScene]
start_time = 204
location_name = "Observation Car"
characters = ["Player"]
```

- [ ] **Step 4: Commit**

```
git add src/server/stories/types.ts src/server/stories/seed.ts src/server/stories/glass-cage.toml
git commit -m "feat: update seed system to use initialScene, seed first Scene node instead of TimePoint"
```

---

### Task 19: Console Client — Handle scene_update

**Files:**
- Modify: `src/console/main.ts`
- Modify: `src/console/SseClient.ts`

- [ ] **Step 1: Update SseClient to parse scene_update**

In `SseClient.ts`, in the event parsing switch, change `time_update` to `scene_update` — same pattern, just different event name. The callbacks interface already uses method names.

- [ ] **Step 2: Update main.ts callbacks**

Remove `onTimeUpdate` callback (or any `time_update` handling). Add `onSceneUpdate` if needed for display:

```typescript
// In createSseCallbacks(), add:
onSceneUpdate: (data) => {
  // Scene transitions are already conveyed through narrative — just log for now
  // The scene_id, start_time, location_name, characters, and reason are available
},
```

- [ ] **Step 3: Commit**

```
git add src/console/main.ts src/console/SseClient.ts
git commit -m "feat: handle scene_update SSE event in console client"
```

---

### Task 20: Remove Old Files

**Files:**
- Remove: `src/server/db/models/time.ts`
- Remove: `src/server/llm/tools/advanceTime.ts`

- [ ] **Step 1: Delete the files**

```
git rm src/server/db/models/time.ts
git rm src/server/llm/tools/advanceTime.ts
```

- [ ] **Step 2: Verify TypeScript compiles cleanly**

Run: `npx tsc --noEmit`
Expected: Clean compilation — no errors. All references to TimeModel and advanceTime have been removed.

- [ ] **Step 3: Commit**

```
git commit -m "feat: remove TimeModel and advanceTime tool (replaced by SceneModel and manageScene)"
```

---

### Task 21: Update & Run Tests

**Files:**
- Modify: `tests/unit/schema.test.ts`
- Modify: `tests/integration/time-model.test.ts`
- Modify: `tests/integration/message-model.test.ts`
- Modify: `tests/integration/note-model.test.ts`
- Modify: `tests/integration/plot-model.test.ts`
- Modify: `tests/integration/entity-crud.test.ts`
- Modify: `tests/helpers.ts`

- [ ] **Step 1: Update test helpers to seed Scene instead of TimePoint**

In `tests/helpers.ts`, update `setupTestDb` to seed a Scene after initializing. If setupTestDb already calls seedDatabase, it should work after Task 18 changes. Verify by reading the file.

- [ ] **Step 2: Update schema.test.ts**

Update expected counts for predefined nodes/rels. Remove assertions about TimeAnchor, TimePoint, Message. Add assertions about Scene, NEXT_SCENE, ABOUT_SCENE, CARRIES. Update any hardcoded counts.

- [ ] **Step 3: Rewrite time-model.test.ts as scene-model.test.ts**

Rename the test file. Rewrite tests to exercise SceneModel instead of TimeModel. Test: create first scene, create subsequent scene (closes old), modify scene, getHistory.

- [ ] **Step 4: Update message-model.test.ts**

Remove tests for `addMessage`, `getConversation`, `saveCurrentOptions`, `getCurrentOptions`. Keep tests for `saveGMMessages`, `loadGMMessages`, `getNextTurnNumber`.

- [ ] **Step 5: Update note-model.test.ts**

Replace ABOUT_MESSAGE test assertions with ABOUT_SCENE equivalents. Verify `linkToScene` works.

- [ ] **Step 6: Update plot-model.test.ts**

Update assertions that inspect TimePoint relationships. Verify `markPlotTimeRel` creates relationships to Scene nodes.

- [ ] **Step 7: Update entity-crud.test.ts**

Update LOCATED_AT assertions to account for new temporal properties (created_at, valid_at).

- [ ] **Step 8: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All tests pass. Fix any remaining failures.

- [ ] **Step 9: Commit**

```
git add tests/
git commit -m "test: update all tests for Scene-based model, temporal relationships, and Scene.log"
```

---

## Post-Implementation Verification

- [ ] Run `npx tsc --noEmit` — zero errors
- [ ] Run `npx vitest run` — all tests pass
- [ ] Start the server: `npm start`
- [ ] Start the console: `npm run console`
- [ ] Verify: Begin story → GM creates a scene → dialogue generates → scene transitions work
- [ ] Update DEVELOPER.md with new file structure and Scene model description
