# Scene Management

## Overview

Replace the turn-based `advanceTime`/TimePoint time system with a **Scene**-based model.
Scene records story progression (time, location, involved characters, narrative log, dialogue options).
State-changing relationships become temporal (`created_at` + `valid_at`), accumulating history rather
than being deleted. World state exploration and persistence shift from per-turn to scene boundaries.

---

## Data Model

### New: Scene node

```
Scene {
  _uid: STRING (unique, uuidv4)
  start_time: DOUBLE       // day * 48 + half-hour
  end_time: DOUBLE|null    // NULL = scene still active (at most one at a time)
  location_name: STRING    // references Location.name; NULL for placeholder scenes
  characters: JSON         // ["Alice", "Bob"] — snapshot of involved character names at scene creation, always includes player
  log: JSON                // chronological array, see Scene.log Format below
  options: JSON            // current dialogue options (previously Conversation.options)
  _updated_at: STRING      // ISO 8601 timestamp
}
```

Scene has no lifecycle states. It is defined solely by time, location, and characters.

### New relationship: NEXT_SCENE

```
(Scene)-[:NEXT_SCENE { reason: STRING, _updated_at: STRING }]->(Scene)
```

Chronological chain linking scenes. Replaces `NEXT_TIMEPOINT`. `reason` captures why the scene
changed. No `created_at` — timing is on the target Scene's `start_time`.

### Temporal relationships — state-changing relationships only

These relationships gain temporal properties to track history:

| Relationship | Endpoints | Temporal? |
|---|---|---|
| LOCATED_AT | Character→Location | Yes |
| LOCATED_AT | Object→Location | Yes |
| LOCATED_IN | Location→Location | Yes |
| HAS_DISPOSITION | Character→Disposition | Yes |
| CARRIES | Character→Object | Yes |

Temporal properties added to these relationship types:

| Property | Type | Purpose |
|---|---|---|
| `created_at` | DOUBLE | Birth time: `day * 48 + half-hour` |
| `valid_at` | DOUBLE\|null | Death time: NULL = still valid |
| `_updated_at` | STRING | ISO 8601 timestamp of last write |

NULL `valid_at` means the relationship is currently valid.
When a relationship ends (character moves, item transfers), its `valid_at` is set to the end time.
A new relationship is created with `valid_at = NULL`. No relationships are ever deleted.

### Structural relationships (no temporal props, unchanged)

NEXT_SCENE, BRANCHES_TO, CONNECTED_TO, ABOUT_ENTITY, ABOUT_PLOT, ABOUT_SCENE,
ACTIVE_AT, COMPLETED_AT, STARTED_AT, and all `_`-prefixed internal relationships.

### Removed nodes

- **TimeAnchor** — active scene identified by `end_time IS NULL`
- **TimePoint** — replaced by Scene + NEXT_SCENE
- **Message** — narrative moves into `Scene.log`
- **SEGMENT_LABELS** constant — time-of-day labels were auto-computed from hour, no longer needed

### Removed relationships

- `NEXT_TIMEPOINT` — replaced by NEXT_SCENE
- `CURRENT_TIMEPOINT` — active scene identified by `end_time IS NULL`
- `AT_TIME` — Message node removed
- `HAS_MESSAGE`, `FIRST_MESSAGE`, `NEXT_MESSAGE` — Message node removed
- `ABOUT_MESSAGE` — replaced by ABOUT_SCENE

### Removed properties

- `Conversation.options` — moved to `Scene.options`

### Changed relationships

| Old | New |
|---|---|
| ABOUT_MESSAGE (Note→Message) | ABOUT_SCENE (Note→Scene) |
| ACTIVE_AT (Plot→TimePoint) | → references Scene |
| COMPLETED_AT (Plot→TimePoint) | → references Scene |
| STARTED_AT (Plot) | → references Scene |

### Kept unchanged

- **GMTurnMessage** + `_HAS_GM_MESSAGE` / `_FIRST_GM_MESSAGE` / `_NEXT_GM_MESSAGE` — internal ai-sdk continuity
- **Conversation** — reduced to internal bookkeeping anchor for GMTurnMessage chain; `options` removed
- All entity labels: Character, Object, Location, Note, Plot, Disposition
- All GM-defined node/relationship types
- Node `_created_at` properties — STRING ISO format unchanged on all node types

---

## Scene.log Format

A chronological array interleaving GM outputs and player inputs, managed entirely by the server
(the LLM never writes to it):

```json
[
  {
    "type": "gm",
    "content": [
      {"speaker": "Guard", "type": "CHARACTER", "text": "...", "metadata": {...}},
      {"speaker": "SYSTEM", "type": "SYSTEM", "text": "...", "metadata": {...}}
    ],
    "options": { ... }
  },
  {
    "type": "player",
    "content": "I draw my sword."
  },
  {
    "type": "roll",
    "content": "Rolled 2d6 + LOGIC(3) | Dice: [4, 6] | Total: 13 vs Difficulty: 10 | Result: SUCCESS",
    "metadata": {
      "speaker": "LOGIC",
      "rollResult": { "skill": "LOGIC", "difficulty": 10, "dice": [4, 6], "total": 13, "success": true }
    }
  }
]
```

**Write paths:**
- **Player input** — `generateTurn()` calls `SceneModel.appendPlayerLog(activeSceneId, userInput)` at turn start
- **GM output** — server appends messages + options after `generateDialogueStep` validates, then sets `Scene.options`
- **Roll results** — server appends a `"type": "roll"` entry after skill check resolution (replaces the current Message node with type ROLL)

The last `gm` entry always contains the current dialogue options.

---

## Tools

### New: `manageScene`

Replaces `advanceTime`. Registered as `TOOL_NAMES.MANAGE_SCENE`.

#### CREATE action

| Parameter | Type | Required | Description |
|---|---|---|---|
| `start_time` | DOUBLE | Yes | `day * 48 + half-hour` |
| `location_name` | STRING | Yes | Must match an existing Location.name |
| `characters` | STRING[] | Yes | Must include player name |
| `reason` | STRING | Yes | Why scene changed — stored on NEXT_SCENE |

Behavior:
1. If active scene exists (`end_time IS NULL`), set its `end_time = start_time`
2. If a placeholder Scene exists (`end_time IS NULL` with no location_name set), populate it with the provided data
3. Otherwise create a new Scene node with `end_time = NULL`
4. Link `(old)-[:NEXT_SCENE { reason }]->(new)`

#### MODIFY action

| Parameter | Type | Required | Description |
|---|---|---|---|
| `add_characters` | STRING[] | No | Merges into characters array |
| `end_time` | DOUBLE | No | Closes the active scene |
| `reason` | STRING | No | Why scene ended — stored on NEXT_SCENE when placeholder is created |

Behavior:
- Only operates on the active scene (`end_time IS NULL`)
- Setting `end_time` closes the scene AND auto-creates an empty placeholder Scene
- The placeholder has `end_time = NULL` but no real data (empty characters, `location_name = NULL`)
- Link `(old)-[:NEXT_SCENE { reason }]->(placeholder)`. If `reason` is not provided, defaults to `""`
- Next time CREATE is called, it populates the placeholder instead of creating a new node
- This guarantees exactly one Scene has `end_time IS NULL` at all times

**Placeholder crash recovery:** If the session crashes between MODIFY and CREATE, the placeholder
becomes the active scene. `SceneModel.getActive()` returns `null` when `location_name IS NULL`,
allowing the system to recover gracefully. CREATE will populate the existing placeholder.

### Changed: `editRelationship`

- **DELETE action removed** — relationships are never deleted
- UPDATE can set `valid_at` to end a state-changing relationship
- CREATE auto-sets `created_at` and `valid_at = NULL` on temporal relationship types
- Every write auto-updates `_updated_at` (ISO now)
- `created_at` and `valid_at` are tool-managed, not settable by the LLM

### Changed: `editPlot`

- `ACTIVE_AT`, `COMPLETED_AT`, `STARTED_AT` now reference Scene nodes (by `_uid`)
- Time references auto-wire to the active Scene (`end_time IS NULL`) via `PlotModel.markPlotTimeRel()`
- Same API surface — LLM just sets status, the tool handles linking

### Changed: `editNote`

- `aboutMessages` parameter removed
- New `aboutScenes` parameter for ABOUT_SCENE linking
- ABOUT_MESSAGE → ABOUT_SCENE

### Changed: `getContext`

- SCENE_CONTEXT reads from active Scene node (time, location, characters, NPCs, etc.)
- RELATIONSHIP_DUMP filters to `valid_at IS NULL` by default for current state
- SCHEMA_DUMP reflects new/removed types

### Removed: `advanceTime`

- Tool file deleted
- `time_update` SSE event replaced by `scene_update`

---

## SSE Events

### Removed: `time_update`

### New: `scene_update`

```typescript
interface SceneUpdateEvent {
  scene_id: string;
  start_time: number;
  end_time: number | null;
  location_name: string;
  characters: string[];
  reason: string | null; // from NEXT_SCENE reason, if transitioning
}
```

Emitted when `manageScene` executes CREATE or MODIFY (setting end_time).

---

## API Changes

- `/api/history` — rebuilt from Scene.log spanning the NEXT_SCENE chain; returns same JSON shape (Message[] contract unchanged)
- `/api/game/current` — reads options from active Scene (`end_time IS NULL`) instead of Conversation node

---

## Prompt Changes

**Old workflow:** SENSE → DRAFT → SPEAK → PERSIST (all tools every turn)

**New workflow (prompt-guided):**

```
SCENE START
  Explore world state (getContext, searchWorld, queryWorld)
  Review notes & plots
  Ensure characters/locations exist

IN-SCENE NARRATION
  generateDialogueStep — narrate the player forward
  Reactive edits: dispositions, plot flags (triggered by player actions)

SCENE END (triggered by manageScene)
  Persist all world changes (movement, items, relationships, plots, notes)
  Update relationship valid_at on changes
```

All tools remain available at all times. The prompt guides the rhythm but does not enforce phases.
Tool descriptions remove the old "PERSIST" language and `advanceTime` references.

---

## Seed Story

`SeedStory` gains an `initialScene` field:

```typescript
interface SeedScene {
  start_time: number;      // day * 48 + half-hour
  location_name: string;   // must match a seeded Location.name
  characters: string[];    // must include player name
}
```

Removed from `SeedStory`: `initialDay`, `initialSegment`, `initialLocationId`.

During seeding, the first Scene node is created from `initialScene`.

### TOML Mapping

Before (`glass-cage.toml`):
```toml
initialDay = 4
initialSegment = 6
initialLocationId = "player_compartment"
```

After:
```toml
[initialScene]
start_time = 204    # day 4 * 48 + half-hour 6*2 = 192 + 12 = 204
location_name = "Observation Car"
characters = ["Player"]
```

### CARRIES registration

`CARRIES` is used in seed TOML and `sceneContext.ts` queries but was never formally registered
as a relationship type. Register it as a PREDEFINED temporal relationship during this migration:
`(Character)-[:CARRIES]->(Object)` with `brief` (embedded_content) + temporal props.

The existing `LOCATED_AT(Object→Character)` variant (which also represents carrying, but in the
opposite direction) remains registered but is superseded by `CARRIES`. The inventory query in
`sceneContext.ts` should use `CARRIES` going forward.

---

## Refactoring Checklist

### Files to create

- `src/server/db/models/scene.ts` — SceneModel (getActive, create, modify, getChain, appendPlayerLog, appendGMLog, getHistory)

### Files to remove

- `src/server/db/models/time.ts`
- `src/server/llm/tools/advanceTime.ts`

### Files to modify

- `src/server/db/schema.ts` — Scene node, NEXT_SCENE rel, ABOUT_SCENE rel, remove TimePoint/TimeAnchor/Message nodes; remove HAS_MESSAGE/FIRST_MESSAGE/NEXT_MESSAGE/AT_TIME/CURRENT_TIMEPOINT/NEXT_TIMEPOINT rels; add `created_at`/`valid_at` to temporal rel defs; register CARRIES as PREDEFINED; update `getInternalTypeNames()` to remove TimeAnchor; update ACTIVE_AT/COMPLETED_AT/STARTED_AT `targetLabel` from TimePoint to Scene; register STARTED_AT as PREDEFINED if not already
- `src/server/db/models/messages.ts` — narrative messages → Scene.log; keep GMTurnMessage internal persistence; remove Message node CRUD; remove `saveCurrentOptions`/`getCurrentOptions` (moved to SceneModel); remove `linkToMessage`/ABOUT_MESSAGE handling
- `src/server/db/models/notes.ts` — remove `linkToMessage()` and ABOUT_MESSAGE handling from `clearLinks()`; remove `linkedMessages` from Note interface
- `src/server/db/models/plots.ts` — rewrite `markPlotTimeRel()` to find active Scene (`end_time IS NULL`) instead of TimeAnchor→CURRENT_TIMEPOINT→TimePoint
- `src/server/llm/tools/editRelationship.ts` — remove DELETE action; auto-set temporal props on CREATE/UPDATE; only for temporal relationship types; TODO: auto-expire old relationship when a new one of the same type+source is created (e.g. moving to new location)
- `src/server/llm/tools/editPlot.ts` — TimePoint refs → Scene refs (auto-wire to active Scene)
- `src/server/llm/tools/editNote.ts` — `aboutMessages` → `aboutScenes`; ABOUT_MESSAGE → ABOUT_SCENE
- `src/server/llm/tools/getContext.ts` — SCENE_CONTEXT from Scene node; RELATIONSHIP_DUMP defaults to `valid_at IS NULL`
- `src/server/llm/sceneContext.ts` — adapt queries to Scene-based model; use `end_time IS NULL` instead of TimeAnchor; all LOCATED_AT/CARRIES queries must add `valid_at IS NULL` filter; inventory query uses CARRIES instead of LOCATED_AT(Object→Character)
- `src/server/llm/prompt.ts` — new workflow, remove advanceTime references, update tool references
- `src/server/llm/index.ts` — tool registration (add manageScene, remove advanceTime); player input → Scene.log; GM output → Scene.log; roll results → Scene.log; call `SceneModel.saveOptions()` instead of `db.messages.saveCurrentOptions()`; prepareStep nudge logic remove advanceTime refs
- `src/server/llm/events.ts` — `emitTimeUpdate` → `emitSceneUpdate`
- `src/shared/constants.ts` — TOOL_NAMES: remove ADVANCE_TIME, add MANAGE_SCENE; remove SEGMENT_LABELS
- `src/shared/events.ts` — `time_update` → `scene_update` event type
- `src/server/db/index.ts` — wire SceneModel instead of TimeModel
- `src/server/api.ts` — `/api/history` rebuilt from Scene.log; `/api/game/current` reads options from Scene instead of `db.messages.getCurrentOptions()`
- `src/console/main.ts` — handle `scene_update` SSE event instead of `time_update`
- `src/server/stories/types.ts` — add `initialScene`, remove initialDay/initialSegment/initialLocationId
- `src/server/stories/seed.ts` — seed Scene instead of TimeAnchor/TimePoint; register CARRIES
- `src/server/stories/glass-cage.toml` — update to `initialScene`

### Tests to update

- `tests/integration/time-model.test.ts` — rename/rewrite for SceneModel
- `tests/integration/message-model.test.ts` — adapt to Scene.log
- `tests/integration/note-model.test.ts` — ABOUT_MESSAGE tests removed, ABOUT_SCENE tests added
- `tests/integration/plot-model.test.ts` — time relationship tests updated for Scene refs
- `tests/integration/entity-crud.test.ts` — LOCATED_AT now expects temporal props
- `tests/unit/schema.test.ts` — new/removed types, temporal props on state-changing rels

---

## Design Decisions Summary

1. **MODIFY with `end_time` auto-creates empty placeholder Scene** — ensures exactly one active Scene at all times; next CREATE populates it. If crash occurs between MODIFY and CREATE, `getActive()` returns `null` for placeholder detection.
2. **Server owns all Scene.log writes** — player input, GM output, and roll results all appended by server code. LLM never touches Scene.log.
3. **Only state-changing relationships get temporal props** — LOCATED_AT, CARRIES, HAS_DISPOSITION, LOCATED_IN. Structural rels (NEXT_SCENE, BRANCHES_TO, etc.) are not temporal. Nodes retain STRING ISO `_created_at`; only relationships carry game-time history.
4. **`/api/history` keeps contract** — rebuilt from Scene.log with same JSON shape; console client unchanged.
5. **Plot time refs auto-wire to active Scene** — same pattern as current TimePoint auto-wiring, just targeting `(Scene {end_time IS NULL})`.
6. **`editRelationship` DELETE removed** — relationships end via `valid_at` instead. TODO: auto-expire old relationship on CREATE of same type+source.
7. **Options stored on Scene** — replaces `Conversation.options`. `saveCurrentOptions`/`getCurrentOptions` moved from MessageModel to SceneModel.
8. **Placeholder Scene has `location_name = NULL`** — `SceneModel.getActive()` returns `null` when location is null, allowing graceful recovery from incomplete scene transitions.
9. **CARRIES registered as PREDEFINED** — standardizes item possession on `(Character)-[:CARRIES]->(Object)` with temporal props, superseding the unregistered ad-hoc usage.
10. **Scene.log entries have three types** — `"gm"`, `"player"`, `"roll"`. Each is a self-contained record in the chronological array.

---

## Implementation Notes

### Breaking change — no migration path

This redesign fundamentally changes the data model. Existing databases with TimePoint, TimeAnchor,
and Message nodes must be reset (`/api/reset`) after deploying. No incremental migration is provided.

### Scene.log growth

`Scene.log` is a single JSON array on each Scene node. For very long scenes (dozens of turns),
this array will grow. The `/api/history` endpoint traverses the NEXT_SCENE chain and assembles
all logs, so the read pattern is fine. But the read-modify-write cycle for each append may become
slow for large logs. If this becomes an issue in practice, a future optimization could paginate
the log or move entries to separate nodes.

### Temporal query performance

Queries for current state use `valid_at IS NULL`, which is straightforward. Reconstructing state
at a past time T requires `WHERE created_at <= T AND (valid_at IS NULL OR valid_at >= T)`.
This dual-range predicate should be monitored for performance as the relationship count grows.
Consider adding an index on `(created_at, valid_at)` for temporal relationship tables if queries
become slow.
