# Issues

## 1. "BEGIN FIRST TURN" prompt tells GM to call tools it doesn't have

**Source:** `src/server/gm/index.ts:174-185`

The first-turn prompt injection tells the GM to call `getContext`, `queryWorld`, and `searchWorld`. But the GM only has `searchWorld` (restricted to Note/Plot). It does NOT have `getContext` or `queryWorld`. This forces the GM to delegate to the assistant for database queries, creating unnecessary round-trips and confusion. The GM interprets this as "I must gather ALL database context before I can narrate," which pollutes its context with database schema details that are irrelevant to storytelling.

## 2. GM over-delegates — 4 duplicate `delegateToAssistant` calls in one turn

**Source:** generations file Steps 1, 4, 7, 11

The GM calls `delegateToAssistant` four separate times asking for essentially the same database context (full context → schema only → full context again → just the current time). This burns 7 of 10 available steps before calling `generateDialogueStep`, leaving no room for meaningful narrative development.

## 3. Assistant cannot signal "I already gave you this" — no feedback loop

Each `delegateToAssistant` call starts fresh. The assistant loads its message history, but the `delegateToAssistant` prompt injects the full GM request as a new user message. The assistant recognizes it's being asked for the same data (reasoning: "The GM is asking for the same thing I just gathered in the previous turn") but has no way to say "see previous response." It re-runs all queries from scratch.

**Step 5** reasoning: *"The GM is asking for the same thing I just gathered in the previous turn. Let me re-run the queries to get fresh data, though it should be the same."*

**Step 12** reasoning: *"I already have this from the earlier query - the TimePoint node shows Day 4, 6:00 AM. Let me query it directly to confirm."*

## 4. Massive token waste — ~900K input tokens for one turn with no player choice

**Source:** generations file, token counts across 17 steps

| Phase | Steps | Input tokens |
|---|---|---|
| Context gathering (attempts 1-3) | 1-10 | ~500K |
| Trivial time query | 11-13 | ~160K |
| Dialogue generation | 14-15 | ~90K |
| Auto-persist review | 16-17 | ~160K |
| **Total** | **17** | **~910K** |

All context gathering is wasted: the player hasn't chosen an option yet, so no world state changes. The full database was dumped 3 times (Steps 3, 6, 10) — each with the complete schema, all 17 characters, 7 locations, 5 objects, 7 plots, and 27 notes. The auto-persist phase re-fetched the same context yet again (Step 16).

## 5. Emoji in assistant output causes 2 delegation failures

**Source:** generations file Steps 3, 6

The assistant returns emoji in its text output (⭐ 💀 🔍 🎵 🩺 🙏 ⚔ 👁 🍺 ⚙ 🔴 ❌). `delegateToAssistant` applies `checkText` validation which rejects these as "disallowed characters." Two consecutive delegation attempts fail before the GM learns to add "Return everything as plain text with no special characters" to its request. This wastes 6 steps (Steps 1-10) on retries.

The assistant's tool descriptions do not forbid emoji. Either the assistant must be told not to use them, or `checkText` should not apply to assistant output.

## 6. Assistant returns reasoning as output

**Source:** generations file Step 10

The assistant's third text response is just its internal reasoning: *"Now I have all the data. Let me compile it all into a plain text response as requested."* followed by the raw data. Even worse, Step 9 has both text ("Let me fix the schema procs queries:") AND tool calls in the same step, showing the assistant's reasoning leaking into the output.

## 7. Assistant does GM-level analysis — role boundary blurred

**Source:** generations file Steps 3, 6, 10, 13, 17

Every assistant text response includes an OBSERVATIONS section with narrative analysis:

- *"Thea is a ticking time bomb. She saw someone near Crowne's compartment at midnight."*
- *"Ysara knows 3 people who can bypass arcane seals — this is the key to the locked-room mystery."*
- *"Dravos's case + Kest's stabilizer readings are two threads pointing to the same interference pattern."*
- *"The murder occurred at ~midnight, it's now 6 AM — the player may have been drugged or knocked out."*

**Root cause:** `src/server/assistant/index.ts:71` says: *"After answering, add a brief OBSERVATIONS section if you notice anything relevant to the GM."* This explicitly instructs the assistant to do narrative analysis.

The assistant's sole job should be to retrieve database facts. All analysis belongs to the GM.

## 8. Auto-persist re-fetches data it already has

**Source:** generations file Step 16

The auto-persist phase calls `getContext(["SCENE_CONTEXT", "RELATIONSHIP_DUMP"])` to verify state. But this same data was already retrieved in Steps 2 and 5 by the assistant. The auto-persist has no awareness that the assistant just gathered all this context. This adds ~160K tokens of redundant data processing.

## 9. `hintAfter` Zod validation failure on first dialogue attempt

**Source:** generations file Step 14

The first `generateDialogueStep` call fails because `options[0].hintAfter` is 57 characters (max 50). The GM retries with a fresh call (not `isCorrection: true`), resending all 7 messages and 4 options. A minor issue but it adds a wasted step.

## 10. LOCATED_AT brief property is incorrect in seed data

**Source:** generations file Step 16

The `getContext` SCENE_CONTEXT returns "Berthed in Compartment 3" as the LOCATED_AT brief for ALL characters across ALL locations (Passenger Car A, Passenger Car B, Crew Car, Engine Car). The actual `description` properties on individual relationships are correct (e.g., Crowne has "Berthed in Compartment 4 — now a sealed crime scene"), but the schema-defined `brief` property is wrong for most characters.

## 11. `validateMessageChain` drops orphaned tool messages on load

**Source:** console log lines 615-616, 707-708

The message validator detects and drops orphaned tool messages from the assistant's persisted history. This confirms old corrupted data remains in Neo4j. The validator works as a safety net but the underlying GMTurnMessage/AssistantMessage nodes need cleanup.
