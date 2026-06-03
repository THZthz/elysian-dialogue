# Chorus — Developer Guide

Cinematic dialogue engine with branching paths, skill checks, and LLM Game Master.
**Stack:** TypeScript, Express, LadybugDB (graph), SQLite (vectors), DeepSeek SDK + ai (tool definitions only).

---

## Project overview

Chorus is a cinematic dialogue engine — an AI Game Master that generates branching narrative via LLM tool-calling, streamed to an interactive terminal client through SSE. The LLM uses Neo4j-compatible graph database tools to read/write world state (characters, locations, objects, plots, notes, dispositions). Hybrid search (dense + BM25 + cross-encoder reranking) runs locally via llama-server.

## Commands

```bash
npm run server          # Start Express server (port 3000)
npm run server:dev      # Start server with watch mode
npm run console         # Start interactive terminal client

npm run lint            # npx tsc --noEmit and npx eslint .
npm run format          # Format source (prettier)
npm run format:check    # Check formatting

npm run test            # Run all tests (vitest run, fileParallelism: false)
npm run test:watch      # Run tests in watch mode
npm run test:unit       # tests/unit/
npm run test:integration # tests/integration/
npm run test:scenarios  # tests/scenarios/
```

Single test file:
```bash
npx vitest run tests/integration/entity-crud.test.ts
```

---

## Files Overview

```
src/
├── console/                          # REPL client
│   ├── main.ts                       # Entry, SSE listener, chalk rendering, REPL loop
│   ├── SseClient.ts                  # SSE stream parser
│   └── markdown.ts                   # Terminal markdown rendering
│
├── server/
│   ├── main.ts                       # Express entry (port 3000)
│   ├── api.ts                        # Routes: /chat/stream, /history, /reset, /checkpoints, /debug/tools/*
│   ├── validation.ts                 # Zod schemas for API input
│   │
│   ├── db/                           # Persistence (LadybugDB + SQLite)
│   │   ├── index.ts                  # Database singleton facade
│   │   ├── ladybug.ts                # LadybugDB client wrapper (Cypher queries)
│   │   ├── vectorstore.ts            # SQLite-backed vector store (brute-force cosine)
│   │   ├── schema.ts                 # SchemaRegistry: node/rel DDL, embedding text, search helpers
│   │   ├── checkpoint.ts             # CheckpointManager: turn-level save/restore (file copy)
│   │   └── models/                   # Domain models
│   │       ├── entities.ts           # EntityModel: Character/Object/Location CRUD + embedding
│   │       ├── plots.ts              # PlotModel: lifecycle, branching, flags
│   │       ├── notes.ts              # NoteModel: GM notes with entity/scene/plot linking
│   │       ├── messages.ts           # MessageModel: GM turn message persistence
│   │       └── scene.ts              # SceneModel: scene lifecycle, log append, history, chaining
│   │
│   ├── search/                       # In-process hybrid vector search
│   │   ├── hybridSearch.ts           # 3-way RRF fusion (name dense + content dense + sparse)
│   │   ├── embedder.ts               # llama-server client
│   │   ├── sparseEncoder.ts          # FNV-1a token hashing
│   │   └── reranker.ts               # Optional cross-encoder rerank
│   │
│   ├── llm/                          # Game Master AI
│   │   ├── index.ts                  # generateTurn(): creates game loop, emits SSE, persists checkpoints
│   │   ├── prompt.ts                 # System prompt: toolbox, turn rhythm, memory, plots
│   │   ├── events.ts                 # TurnEventEmitter — SSE event emission
│   │   ├── sceneContext.ts           # Builds scene context, entity briefs, plot trees
│   │   ├── conditionEvaluator.ts     # JS expression evaluation for skill checks
│   │   ├── rollSkillCheck.ts         # 2d6 + stat vs difficulty resolution
│   │   └── tools/                    # LLM tool implementations (10 tools)
│   │       ├── queryWorld.ts         # Cypher READ/WRITE
│   │       ├── searchWorld.ts        # Dynamic vector search
│   │       ├── editNode.ts           # Node CRUD
│   │       ├── editRelationship.ts   # Relationship CRUD
│   │       ├── editNote.ts           # Note CRUD + linking
│   │       ├── editPlot.ts           # Plot CRUD + branching
│   │       ├── manageSchema.ts       # Register/unregister node/rel types
│   │       ├── getContext.ts         # Scene context, schema dump, relationship dump
│   │       ├── generateDialogueStep.ts  # Structured narrative output
│   │       ├── manageScene.ts        # Scene lifecycle management
│   │       └── shared.ts             # wrapSafe, extractInternalAndUnknownKeys
│   │
│   └── stories/                      # World seeding (TOML)
│       ├── index.ts                  # Active story selection
│       ├── seed.ts                   # seedDatabase(): idempotent seed via domain models
│       ├── types.ts                  # TOML format types
│       ├── glass-cage.toml           # Default seed story
│       └── magic-awakening.toml      # Alternate seed story
│
├── shared/                           # Shared constants & types
│   ├── constants.ts                  # TOOL_NAMES, SKILL_NAMES, SEGMENT_LABELS
│   ├── events.ts                     # SSE event type definitions
│   ├── sse.ts                        # SSE formatting helpers
│   └── colors.ts                     # Chalk wrappers for console output
│
├── sdk/                              # DeepSeek API SDK (replaces AI SDK providers)
│   ├── types.ts                      # Shared types: ChatMessage, ToolSpec, Usage, LoopEvent
│   ├── client.ts                     # DeepSeekClient — HTTP, auth, SSE parsing
│   ├── prefix.ts                     # ImmutablePrefix — cacheable request prefix
│   ├── log.ts                        # AppendOnlyLog — message history + JSONL persistence
│   ├── healing.ts                    # Message healing pipeline
│   ├── diagnostics.ts                # Cache telemetry
│   ├── context.ts                    # ContextManager — token estimation, fold decisions
│   ├── loop.ts                       # createGameLoop() — generator turn loop
│   ├── bridge.ts                     # Vercel tool() → ToolSpec converter
│   └── index.ts                      # Re-exports
│
└── types/                            # Frontend types
    └── dialogue.ts                   # Message, DialogueOption
```

---

## Architecture

### Two-process model

**Server** (`src/server/`) — Express API on port 3000. Manages the LadybugDB graph database, vector store (better-sqlite3), LLM orchestration via DeepSeek SDK + ai (tool definitions only), and SSE event streaming.

**Console** (`src/console/`) — Interactive terminal client using `@inquirer/prompts`. Connects to server via SSE, renders markdown with chalk colors. Supports resume from saved game state.

### Data flow

```
Console (SSE client) ──POST /api/chat/stream──▶ Express API
                                                      │
                                                      ▼
                                              generateTurn() (src/server/llm/index.ts)
                                                      │
                                    ┌─────────────────┼──────────────────┐
                                    ▼                 ▼                  ▼
                              createGameLoop()  buildSystemPrompt()   Tool definitions
                              .step()           (src/server/llm/prompt.ts)  (via bridge.ts)
                              (SDK generator)
                                    │
                              ┌─────┴──────┐
                              ▼            ▼
                          Tool calls    generateDialogueStep
                          (read world)  (streamed to player via SSE)
```

### LLM tool system

The GM is given 10 tools (defined in `src/server/llm/tools/`), each with a specific responsibility:

- **`queryWorld`** — raw Cypher queries (multi-hop traversals, aggregations, bulk ops)
- **`searchWorld`** — hybrid vector + BM25 + rerank search
- **`editNode`** — single-node UPSERT / DELETE with embedding updates and JSON partial merge
- **`editRelationship`** — single-relationship UPSERT (auto-detects create vs update, JSON partial merge)
- **`editNote`** — GM scratchpad (ABOUT_CHARACTER/OBJECT/LOCATION/SCENE/PLOT)
- **`editPlot`** — story arc management with status lifecycle and conditions
- **`manageSchema`** — register new node/rel types (must run before data insertion)
- **`getContext`** — one-shot context bundle (schema dump, entity summaries, relationship dump)
- **`generateDialogueStep`** — streaming output tool: produces messages and dialogue options for the player
- **`manageScene`** — scene transitions with time tracking, location/character changes

### SDK turn loop

`generateTurn()` calls `createGameLoop()` — a generator-based turn loop that replaces the old `streamText()`/`prepareStep` nudge system:

- **Generator loop**: `createGameLoop()` returns an async generator that yields `LoopEvent` objects (tool_call, content_delta, usage, complete, error). The caller iterates with `for await (const event of gameLoop)`, dispatching events to the SSE emitter.
- **ImmutablePrefix**: The system prompt and initial messages are wrapped in an `ImmutablePrefix` to enable prompt caching — the prefix hash is included in API requests so the provider only recomputes from the first differing token.
- **Tool definitions via bridge.ts**: The 10 tool files use `tool()` from `ai` for schema definitions, converted to `ToolSpec` format via the bridge for API requests. Tool dispatch uses an injected `runTool` callback, keeping the SDK provider-agnostic.
- **Streaming dialogue**: As `tool_call_delta` events arrive for `generateDialogueStep` arguments, `parsePartial` accumulates and parses the JSON to emit progressive `content` events for real-time player display.
- **Nudge via `onIterStart`**: Instead of `prepareStep` callbacks, the `onIterStart` hook injects reminder messages when the GM has been processing for several iterations without calling `generateDialogueStep`.
- **ContextManager**: Token estimation (4 chars/token heuristic) triggers automatic history folding at 75% (soft fold — summarize oldest turns), 78% (restore from fold), and 80% (hard limit) of the context window.
- **Cache diagnostics**: `loop.getCacheDiagnostics()` exposes cache hit/miss tokens and estimated cost savings for monitoring.
- **Debug logging**: `DEBUG_PRINT_LLM_GENERATIONS` in `src/shared/constants.ts` (default `true`) prints system prompt, user prompt, reasoning, text output, tool calls, and tool results to the server console with chalk coloring.

### Database: LadybugDB (not Neo4j)

This project uses **LadybugDB** (`@ladybugdb/core`), an embedded, schema-first, strongly-typed Cypher database. Critical differences from Neo4j:

- **Schema-first**: every node label and relationship type must be registered as a table (`CREATE NODE TABLE` / `CREATE REL TABLE`) before inserting data
- **No APOC**: use `CALL show_tables()`, `CALL show_xxx()` instead of `SHOW` commands
- **`id()` not `elementId()`**, **`label()` not `labels()`** (single label only), **`current_timestamp()` not `datetime()`**
- **Walk semantics** for pattern matching (repeated edges allowed). Use `TRAIL`/`ACYCLIC` path modifiers or `is_trail()`/`is_acyclic()` to constrain
- **Variable-length paths require upper bound** (defaults to 30)
- **`null = null` → `NULL`** (not `true`), use `IS NULL` / `IS NOT NULL`
- No `FOREACH` — use `UNWIND` instead
- No `REMOVE` — use `SET n.prop = NULL` to delete properties

The full Cypher cookbook is embedded in the system prompt at `src/server/llm/prompt.ts`.

Read CYPHER.md if doing Cypher-intensive jobs or confused about syntax in LadybugDB.

### Vector search pipeline

1. `llama-server` (port 8080) provides embeddings via `Qwen3-Embedding-0.6B`
2. Optionally, a second `llama-server` (port 8081) provides cross-encoder reranking via `Qwen3-Reranker-0.6B`
3. `VectorStore` (better-sqlite3) stores vectors locally with `(node_type, kind)` filtering
4. `HybridSearcher` fuses dense cosine + BM25 via RRF, optionally reranks top candidates

### Test infrastructure

- Tests use temporary directories (`os.tmpdir()`), isolated LadybugDB + SQLite per test
- `tests/helpers.ts` provides `setupTestDb()`, `teardownTestDb()`, `resetDb()`, `exec()`
- Embedder stub (4-dimensional) used when llama-server is unavailable
- `fileParallelism: false` — tests run sequentially because they share a global `Database` singleton
- `testTimeout: 30000` — some integration tests may need this for DB operations
- `tests/integration/tools.test.ts` — comprehensive tests for all 10 LLM tools (93 active, 11 skipped for known bugs)

### Story seeding

Stories are defined as TOML files in `src/server/stories/` (currently only `glass-cage.toml`). The active story is hardcoded in `src/server/stories/index.ts` (`ACTIVE_SEED_STORY`). Seeding populates the graph with characters, locations, objects, plots, notes, and relationships. The story's `settingDescription` and `toneDescription` are injected into the system prompt via `{{setting_description}}` and `{{tone_description}}`. Notes support `ABOUT_CHARACTER`, `ABOUT_OBJECT`, `ABOUT_LOCATION`, `ABOUT_SCENE`, and `ABOUT_PLOT` relationships for GM reference.

### Time representation

In-game time uses the formula `day * 48 + half_hour` (48 half-hours per day). For example, day 1 at 08:00 = `1 * 48 + 16 = 64`. Relationships have `created_at` (birth) and `valid_at` (death, NULL = still active) — relationships are never deleted, only ended via `valid_at`.
