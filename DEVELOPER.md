# Developer Documentation: Chorus

Architecture, core systems, and data structures of the **Chorus** application.

---

## 1. Project Overview

**Chorus** is a cinematic dialogue engine with a vertical-scrolling "thought stream" aesthetic, branching dialogue paths, and probabilistic skill checks influenced by character attributes.

- **Stack:** TypeScript, Node.js
- **Backend:** Express + Neo4j (graph storage) + Qdrant (vector storage)
- **AI:** Dual-LLM — Game Master (narrative) + Database Assistant (graph ops), both via Vercel AI SDK
- **SSE:** Server-Sent Events for real-time streaming of LLM output
- **Console client:** Standalone Node.js REPL with chalk rendering
- **Deployment:** Local-only — runs on localhost, no authentication required

---

## 2. Core Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        CONSOLE CLIENT                                │
│  src/console/main.ts  ── SSE stream ──►  chalk rendering + REPL      │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ POST /api/chat/stream
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        EXPRESS SERVER                                │
│  src/server/main.ts  ── port 3000                                    │
│  src/server/api.ts   ── /api/chat/stream, /api/history, /api/reset   │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│                      LLM GAME MASTER                                 │
│  src/server/llm/index.ts  ── generateTurn()                          │
│                                                                      │
│  streamText({                                                        │
│    tools: {                                                          │
│      queryWorld, manageSchema, searchWorld,                          │
│      editNode, editRelationship, editNote, editPlot,                 │
│      getContext, generateDialogueStep, advanceTime                   │
│    }                                                                 │
│  })                                                                  │
│                                                                      │
│  stopWhen: generateDialogueStep passes validation                    │
│  prepareStep: nudges if GM forgets dialogue output                   │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ tool calls read/write Neo4j + Qdrant
                               ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                     MEMORY LAYER (Neo4j + Qdrant)                         │
│  src/server/memory/client.ts  ── MemoryClient singleton                   │
│                                                                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │
│  │ ShortTerm   │  │  LongTerm   │  │   Notes     │  │   Plots     │       │
│  ├─────────────┤  ├─────────────┤  ├─────────────┤  ├─────────────┤       │
│  │ messages    │  │ entities    │  │ GM notes    │  │ beats       │       │
│  │ conversation│  │ facts       │  │ CRUD        │  │ branches    │       │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘       │
│         └────────────────┴───────┬────────┴────────────────┘              │
│                                  ▼                                        │
│                      ┌───────────────────────────┐                        │
│                      │           Search          │                        │
│                      │  searchWorld              │                        │
│                      │  searchByLabel            │                        │
│                      │  searchByRelationshipType │                        │
│                      └──────┬──────────────┬─────┘                        │
│                             │              │                              │
│                  ┌──────────┘              └──────────┐                   │
│                  ▼                                    ▼                   │
│        ┌───────────────────┐                ┌───────────────────┐         │
│        │    embedder.ts    │                │   reranker.ts     │         │
│        │ llama-server      │                │ llama-server      │         │
│        │ LLAMA_EMBED_URL   │                │ LLAMA_RERANK_URL  │         │
│        │ (query→vector)    │                │ (cross-encoder)   │         │
│        └────────┬──────────┘                └────────┬──────────┘         │
│                 │                                    │                    │
│    ┌────────────┴────────────┐                       │                    │
│    ▼                         ▼                       │                    │
│  ┌───────────────────┐  ┌────────────────────────────┴────────────────┐   │
│  │    qdrant.ts      │  │              neo4j.ts                       │   │
│  │  Qdrant vector    │  │  driver wrapper with value normalization    │   │
│  │  upsert / search  │  │  nodeManager.ts — label registry            │   │
│  │  / delete         │  │  relationshipManager.ts — rel type registry │   │
│  └────────┬──────────┘  │  validation.ts — CypherValidator            │   │
│           │             └──────────────────────┬──────────────────────┘   │
└───────────┼────────────────────────────────────┼──────────────────────────┘
            │                                    │
            ▼                                    ▼
  ┌────────────────────┐             ┌──────────────────────────────┐
  │     QDRANT         │             │          NEO4J               │
  │  chorus_embeddings │             │  Node labels: Conversation,  │
  │  Cosine distance   │             │  Message, Entity (+ subtypes │
  │  vectors + payload │             │  Character,Location,Object), │
  └────────────────────┘             │  Disposition, Note, Plot,    │
                                     │  TimeAnchor, TimePoint,      │
                                     │  GMTurnMessage,              │
                                     │  RelationshipType, NodeType, │
                                     │  IdCounter                   │
                                     └──────────────────────────────┘
```

---

## 3. LLM Tools (Split: GM + Assistant)

GM tools defined in `src/server/llm/tools/`, registered in `generateTurn()`. Assistant tools are the same implementations but registered in `src/server/assistant/index.ts` within the Assistant's `streamText` call.

### GM tools — 6 tools for narrative

| Tool                   | Purpose                                                       |
|------------------------|---------------------------------------------------------------|
| `generateDialogueStep` | Produce narrative messages + player options                   |
| `advanceTime`          | Advance in-game clock                                         |
| `editNote`             | CREATE/UPDATE/DELETE notes (no entity/message/plot linking)   |
| `editPlot`             | CREATE/UPDATE/DELETE plots                                    |
| `searchWorld`          | Vector search scoped to Note and Plot domains only            |
| `delegateToAssistant`  | Natural-language delegation to the Database Assistant          |

### Assistant tools — 7 tools for database operations

| Tool               | Purpose                                                          |
|--------------------|------------------------------------------------------------------|
| `queryWorld`       | Full Cypher READ/WRITE                                           |
| `searchWorld`      | Full vector search across all node/relationship types            |
| `editNode`         | Full node CRUD                                                   |
| `editRelationship` | Full relationship CRUD                                           |
| `editNote`         | Full note CRUD with entity/message/plot linking                  |
| `getContext`       | Scene context, entity briefs, schema/relationship dumps          |
| `manageSchema`     | Register/unregister node types and relationship types            |

---

## 4. Database Assistant

The Assistant is a second LLM that manages Neo4j + Qdrant on behalf of the GM.

- **Module**: `src/server/assistant/`
- **Interface**: `delegateToAssistant(request: string, context: AssistantContext): Promise<string>`
- **Context**: receives recent conversation + GM's tool calls this turn for enrichment
- **Persistence**: `:AssistantMessage` nodes in Neo4j, trimmed to last 20 messages, linked via `NEXT_ASSISTANT_MESSAGE`
- **Model**: configured via `ASSISTANT_PROVIDER` and `ASSISTANT_MODEL` env vars; falls back to GM model

### Tool Flow

```
GM calls delegateToAssistant({ request: "..." })
  → loads :AssistantMessage history
  → builds context (conversation + GM tool calls)
  → streamText(Assistant) with 7 tools
  → saves new :AssistantMessage nodes
  → returns result + enrichment to GM
```

---

## 5. Relationship Type Registry

`relationshipManager.ts` — singleton registry. Keyed by composite `(name, sourceLabel, targetLabel)`. Same name with different endpoint labels creates separate entries.

- **Categories**: `INTERNAL` (system, write-blocked), `PREDEFINED` (world-modeling, write-allowed), `GM_DEFINED` (user-declared).
- **Key methods**: `register(name, desc, type, sourceLabel, targetLabel, props)`, `get(name, sourceLabel, targetLabel)`, `getByName(name)`, `isAllowedForWrite(name, sourceLabel, targetLabel)`, `updateDefinition(...)`, `unregister(...)`, `getEmbeddingText(name, props)`.
- **Wildcard sentinel**: empty string `""` means unconstrained endpoint — used by `validation.ts` for auto-registered types.
- **Neo4j sync**: stored as `:RelationshipType` nodes with `source_label`/`target_label` (singular scalars). Also creates property indexes, composite indexes, and vector indexes for relationship types that have `_embedding`.
- **Property tags**: `string`, `number`, `number[]`, `json`, `embedded`, `index`, `composite_index_1`, `composite_index_2`, `composite_index_3`. (`unique` is excluded — Neo4j does not support uniqueness constraints on relationship properties.)

## 6. Node Type Registry

`nodeManager.ts` — singleton registry mirroring RelationshipManager for node labels.

- **Categories**: `INTERNAL` (Conversation, GMTurnMessage, IdCounter — hidden), `PREDEFINED` (Entity, Message, Note, Plot, Disposition, etc.), `GM_DEFINED`.
- **Properties**: `NodePropertyDef` with `name`, `description`, `tags` (array of tags: `string`, `number`, `number[]`, `json`, `embedded`, `unique`, `index`, `composite_unique_1/2/3`, `composite_index_1/2/3`).
- **`getEmbeddingText(label, props)`**: builds embedding text by concatenating all `"embedded"`-tagged property values. Used by `addEntity`, `addMessage`, `createNote`, `createPlot`, `editNode`, and the reranker.
- **Vector indexes**: created dynamically in `syncToNeo4j` for any type with `_embedding` property.
- **Embedded properties** (tag `"embedded"`): Entity.{name,description,brief}, Plot.{name,description,brief}, Note.{content}, Message.{content}.

## 7. Dynamic Vector Search

`searchWorld` discovers searchable node types and relationship types at runtime via `NodeManager` and `RelationshipManager`. Types with `_embedding` property are searchable. Subtype labels (Character, Location, Object, etc.) are mapped to their canonical parent label (Entity) since they share the same Qdrant `node_type`.

**Parameters**: `target` (array of `"node"`/`"relationship"`, defaults to both), `domains` (optional list of node labels or relationship types to search), `query`, `limit`.

`MemorySearch.searchByLabel(label, query)` and `MemorySearch.searchByRelationshipType(type, query)` perform 3-way hybrid search across Qdrant named vectors (`name_vec` dense, `content_vec` dense, `sparse_vec` sparse). Results are fused with Reciprocal Rank Fusion (RRF, k=60), then top candidates are passed through the optional cross-encoder reranker when `LLAMA_RERANK_URL` is configured.

---

## 8. Turn Lifecycle

```
POST /api/chat/stream
        │
        ▼
┌──────────────────────────────────────────────────────┐
│  generateTurn()                                      │
│  streamText({ tools: { ...10 tools } })              │
│    stopWhen: generates once + passes validation      │
│    prepareStep: nudges if GM forgets dialogue        │
│                                                      │
│  fullStream iteration:                               │
│    text-delta          → discard                     │
│    tool-input-delta    → progressive streaming       │
│    tool-call           → definitive output           │
└──────────┬───────────────────────────────────────────┘
           │ SSE events
           ▼
┌──────────────────────────────────────┐
│  Console Client (console/main.ts)    │
│  State: idle → streaming → idle      │
│  Event handlers per SSE event type   │
└──────────────────────────────────────┘
```

---

## 9. SSE Events

Defined in `src/shared/events.ts`:

| Event                | Direction       | Payload                                                                       | Trigger                                   |
|----------------------|-----------------|-------------------------------------------------------------------------------|-------------------------------------------|
| `step_start`         | Server → Client | `{ stepId }`                                                                  | Turn begins                               |
| `streaming_messages` | Server → Client | `{ messages }`                                                                | Progressive during `generateDialogueStep` |
| `streaming_reset`    | Server → Client | `{}`                                                                          | LLM retried — discard previous            |
| `time_update`        | Server → Client | `{ day, segment, segmentsAdvanced }`                                          | `advanceTime` executes                    |
| `options`            | Server → Client | `{ options }`                                                                 | Options available mid-stream              |
| `parsed`             | Server → Client | `{ messages, options }`                                                       | Final structured output                   |
| `error`              | Server → Client | `{ message }`                                                                 | Error during generation                   |
| `done`               | Server → Client | `{}`                                                                          | Turn complete                             |
| `roll_result`        | Server → Client | `{ skill, difficulty, dice[], total, statBonus, success, matchedConditions }` | Skill check resolved                      |

---

## 10. API Endpoints

| Method | Path                            | Purpose                            |
|--------|---------------------------------|------------------------------------|
| `POST` | `/api/chat/stream`              | Primary AI turn (SSE streaming)    |
| `GET`  | `/api/history`                  | Full conversation history          |
| `GET`  | `/api/game/current`             | Current dialogue options           |
| `POST` | `/api/debug/tools/:toolName`    | Debug: invoke any GM tool directly |
| `POST` | `/api/reset`                    | Clear Neo4j and re-seed            |
| `GET`  | `/api/checkpoints`              | List all saved checkpoints         |
| `POST` | `/api/checkpoint/restore/:turn` | Restore to a previous checkpoint   |
| `MCP`  | `src/server/mcp.ts`             | Stdio MCP server — all 10 GM tools |

---

## 11. Memory Architecture

`MemoryClient` (`client.ts`) is the singleton facade composing all subsystems: `neo4j`, `shortTerm`, `search`, `notes`, `plots`.

### Subsystems

| Module                   | Responsibility                                                                                                                                                                                                      |
|--------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `shortTerm.ts`           | Conversation + `:Message` nodes as ordered linked list (NEXT_MESSAGE).                                                                                                                                              |
| `notes.ts`               | `:Note` CRUD with vector embedding. Links to entities/messages/plots via ABOUT_ENTITY/ABOUT_MESSAGE/ABOUT_PLOT. Uses `extractSearchTexts` for rerank text.                                                          |
| `plots.ts`               | `:Plot` lifecycle: beats, branches, flags. Uses `extractSearchTexts` for rerank text.                                                                                                                               |
| `search.ts`              | `MemorySearch`: 3-way hybrid search (name dense + content dense + sparse keyword) with RRF fusion. `searchByLabel(label, query)` for nodes, `searchByRelationshipType(type, query)` for relationships. Both support optional reranking. |
| `embedder.ts`            | llama-server via `LLAMA_EMBED_URL`. Default 1024 dimensions.                                                                                                                                                       |
| `sparseEncoder.ts`       | FNV-1a 32-bit token hashing for sparse TF vectors. Used for keyword matching in hybrid search.                                                                                                                      |
| `reranker.ts`            | Optional cross-encoder reranking (LLAMA_RERANK_URL). `extractSearchTexts` uses `NodeManager.getEmbeddingText` for node text extraction.                                                                             |
| `validation.ts`          | `CypherValidator`: validates Cypher queries against `NodeManager`/`RelationshipManager`. Auto-registers unknown relationship types with empty-string wildcard sentinel.                                             |
| `nodeManager.ts`         | Node label registry. `syncToNeo4j` creates constraints, indexes, and vector indexes dynamically. Has `getEmbeddingNameText()` and `getEmbeddingContentText()` for nodes.                                            |
| `relationshipManager.ts` | Relationship type registry with composite `(name, sourceLabel, targetLabel)` key. `syncToNeo4j` creates property, composite, and vector indexes for relationship types. Has `getEmbeddingNameText()` and `getEmbeddingContentText()` for relationships. |
| `gameState.ts`           | Persists dialogue options as JSON on `:Conversation` node.                                                                                                                                                          |

### Neo4j Schema

**Constraints**: Unique `_id` on Conversation, Message, Entity, Note, Plot, TimePoint. Unique `name` on Plot.

**Indexes**: Regular indexes on Entity.type, Entity.name, Message.timestamp, Plot.status. Composite indexes on Disposition(source_name, target_name) and TimePoint(day, segment). Composite unique constraints supported via `composite_unique_1/2/3` tags. All created dynamically by `syncToNeo4j`.

**Vector storage**: Embeddings stored in Qdrant collection `chorus_embeddings` using named vectors (`name_vec`, `content_vec` dense Cosine) and sparse vectors (`sparse_vec` with IDF modifier). HNSW graph on-disk with int8 scalar quantization. Payload indexed by `node_type`, `kind`, `object_id`. Neo4j vector indexes are no longer used.

### Embeddings

`embedder.ts` — llama-server via `LLAMA_EMBED_URL` (default `http://localhost:8080/v1/embeddings`). Default dimensions: 1024. Each entity/relationship stores three vectors in Qdrant: `name_vec` (dense, identity/exact-match from `embedded_name`-tagged props), `content_vec` (dense, semantic meaning from `embedded_content`-tagged props), and `sparse_vec` (sparse TF vector for keyword matching via FNV-1a token hashing). Sparse vectors use Qdrant's `"modifier": "idf"` for server-side IDF weighting. Collection config includes HNSW tuning (`m=16, ef_construct=100`), int8 scalar quantization, and query-time `ef` via `QDRANT_EF` env var (default 128). Optional cross-encoder reranking via `LLAMA_RERANK_URL`.

---

## 12. Game Time

Minimum unit: 30 minutes (0.5 hours). Day is integer, hour is 0–23.5 in 0.5 increments. Only advances via `advanceTime`.

**Storage**: `:TimeAnchor {_id: "anchor"}` → `:CURRENT_TIMEPOINT` → `:TimePoint` chain via `NEXT_TIMEPOINT`. Each TimePoint stores `day`, `hour`, `label`. NEXT_TIMEPOINT relationship stores `reason`.

**Model** (`src/server/models/time.ts`): `getCurrentTimePoint()`, `advanceGameTime(halfHours, reason?)`, `describeTime()`, `formatHour()`.

---

## 13. Seed Story System

Stories under `src/server/stories/` (TOML format, `types.ts` interface). Active story set via `ACTIVE_SEED_STORY` in `index.ts`.

`seedDatabase()` checks for existing `:Entity` nodes before seeding (idempotent on restart). On `/api/reset`, Neo4j is cleared then re-seeded.

Relationship types declared via `[[relationshipTypes]]` with `name`, `description`, `sourceLabel`, `targetLabel`.

---

## 14. Internal Voices (Inner Skills)

12 skills: LOGIC, RHETORIC, EMPATHY, PERCEPTION, VOLITION, ENDURANCE, SORCERY, SUGGESTION, INSTINCT, MIGHT, CLOCKWORK, ALCHEMY.

### Skill Checks

- **White Checks**: Repeatable after stat increases
- **Formula**: `2d6 + Stat >= Difficulty`
- **Server-side resolution**: Roll computed automatically when player selects a checked option; result injected into GM prompt
- **Conditional outcomes**: `conditions` array with JS expression evaluation

---

## 15. Key Design Decisions

1. **World state in Neo4j** — entities, messages, plots, notes, game time all persisted.
2. **Singleton memory layer** — `MemoryClient`, `RelationshipManager`, `NodeManager`.
3. **LLM text output silently discarded** — tool-only output; text deltas ignored.
4. **`_` prefix = hidden** — `stripHiddenProperties()` strips `_`-prefixed keys at tool boundaries.
5. **Properties use snake_case in Neo4j** — `_created_at`, `trigger_condition`, `source_name`.
6. **Composite key for relationship types** — `(name, sourceLabel, targetLabel)` uniquely identifies a `RelationshipDef`.
7. **Dynamic vector search** — `searchWorld` queries `NodeManager` and `RelationshipManager` at runtime for node labels and relationship types with `_embedding`, not a hardcoded enum.
8. **Embedding text from schema** — `getEmbeddingNameText()` and `getEmbeddingContentText()` read `"embedded_name"` and `"embedded_content"`-tagged properties from `NodeManager` (nodes) and `RelationshipManager` (relationships).
9. **Three-way hybrid retrieval** — dense name + dense content + sparse keyword search fused via RRF, then cross-encoder rerank when `LLAMA_RERANK_URL` is set.
10. **GM message history persisted** — `:GMTurnMessage` nodes for multi-turn continuity.
11. **COLE+O entity model** — CHARACTER, OBJECT, LOCATION, ORGANIZATION, EVENT with dynamic Neo4j sub-labels.
12. **Skill checks resolved server-side** — dice rolls computed automatically, result injected into prompt.
13. **Compact 4-layer GM prompt** — SENSE (getContext/searchWorld/queryWorld READ) → ACT (editNode/editRelationship/manageSchema/queryWorld WRITE/advanceTime) → TRACK (editNote/editPlot) → SPEAK (generateDialogueStep). Tool descriptions carry operational detail; prompt carries the mental model.
14. **Relationship brief properties** — LOCATED_AT, CARRIES, and LOCATED_IN have `brief` (string, embedded) for narrative context. Character attitudes and alliances use Disposition nodes instead of relationships.
15. **Schema dump from memory** — `getContext SCHEMA_DUMP` reads type definitions directly from `NodeManager`/`RelationshipManager` registries (no Neo4j round-trip), presenting full property schemas with tags and descriptions.
16. **MCP server** — `src/server/mcp.ts` exposes all 10 GM tools over stdio via `@modelcontextprotocol/sdk`. Wraps each tool's `execute(args) => Promise<string>` into MCP's `{ content: [{ type: "text", text }] }`. Two factory-based tools (`generateDialogueStep`, `advanceTime`) are instantiated with MCP-appropriate options.
17. **Turn checkpoints** — at the end of each successful turn, the full Neo4j graph is serialized via `apoc.export.json.all` and the Qdrant collection is snapshotted via the native snapshot API. Both files are saved to `data/checkpoints/`. Restoring a checkpoint wipes both databases and reimports the checkpoint data, then deletes all later checkpoints (linear undo only).

---

## 16. Checkpoint System

`checkpointManager.ts` provides save/restore for turn-level rollback.

### Save (end of each successful turn)

1. `apoc.export.json.all(null, {stream: true, useTypes: true})` — streams the entire Neo4j graph as JSON Lines through the driver
2. `POST /collections/chorus_embeddings/snapshots?wait=true` — creates a Qdrant snapshot, then downloads it
3. Both files written to `data/checkpoints/turn_NNNN_neo4j.jsonl` and `data/checkpoints/turn_NNNN_qdrant.snapshot`
4. Index updated in `data/checkpoints/index.json`

### Restore (`POST /api/checkpoint/restore/:turnNumber`)

1. Writes `.restore_in_progress` sentinel (crash safety)
2. Parses the checkpoint JSONL file
3. `MATCH (n) DETACH DELETE n` — wipes Neo4j
4. Creates nodes in batches grouped by label combination, tracking old APOC id → Neo4j elementId via a temporary `_chorus_restore_id` property
5. Creates relationships using elementId endpoint matching, strips `_`-prefixed system properties
6. Removes temporary `_chorus_restore_id` from all nodes
7. `POST /collections/chorus_embeddings/snapshots/upload` — restores Qdrant snapshot
8. Calls `NodeManager.reloadGmDefined()` and `RelationshipManager.reloadGmDefined()` to sync GM_DEFINED types from restored Neo4j
9. Deletes all checkpoint files for turns > restored turn
10. Removes sentinel

Restore uses manual batch Cypher instead of `apoc.import.json` to avoid the import-directory constraint (Neo4j may run containerized).

Restore returns 409 if a turn is in progress or if the sentinel exists from a previous crashed restore.

### Files

Checkpoints stored on the filesystem (not inside either database):
- `data/checkpoints/index.json` — checkpoint listing
- `data/checkpoints/turn_NNNN_neo4j.jsonl` — APOC JSON Lines export
- `data/checkpoints/turn_NNNN_qdrant.snapshot` — Qdrant binary snapshot

### Qdrant snapshot methods

Added to `qdrant.ts`:
- `createSnapshot()` — `POST /collections/{name}/snapshots?wait=true`
- `downloadSnapshot(name)` — `GET /collections/{name}/snapshots/{name}` (binary)
- `uploadSnapshot(filePath)` — `POST /collections/{name}/snapshots/upload` (multipart)
- `deleteSnapshot(name)` — `DELETE /collections/{name}/snapshots/{name}`

---

## Debugging

`scripts/inspect-devtools.sh` renders LLM interactions from `.devtools/generations.json`. Supports `--run`, `--step`, `--tool-result`, `--full` parameters.

`scripts/debug-endpoints.sh` provides curl examples for each GM tool endpoint.
