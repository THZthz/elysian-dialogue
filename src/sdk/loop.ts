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

// src/sdk/loop.ts
// GameLoop — generator-based turn loop that streams model output, dispatches
// tool calls, detects storms, and folds history via ContextManager.

// The part of the code in this source file originally came from https://github.com/esengine/DeepSeek-Reasonix.
// Although subsequent modifications may have completely changed it, this text is guaranteed to remain unless the file is completely deleted.
// Copyright (c) 2026 esengine (https://github.com/esengine/). Licensed under the MIT License.
// See NOTICE in the project root for full terms.

import { jsonrepair } from "jsonrepair";
import { type DeepSeekClient, DeepSeekError } from "@/sdk/client";
import { AppendOnlyLog } from "@/sdk/log";
import { ContextManager } from "@/sdk/context";
import { healMessages } from "@/sdk/healing";
import {
  buildCacheDiagnostic,
  prefixDiagnosticHashes,
  type CacheDiagnostic,
} from "@/sdk/diagnostics";
import type {
  ChatMessage,
  ChatOptions,
  ToolCall,
  LoopEvent,
  GameLoopOptions,
  ReconfigurableOptions,
  Usage as UsageType,
} from "@/sdk/types";
import { ROLE_NAMES } from "@/shared/constants.ts";

const DEFAULT_MAX_ITER_PER_TURN = 10;
const TURN_START_FOLD_THRESHOLD = 0.9;

interface Accumulator {
  content: string;
  reasoning: string;
  toolCalls: Map<number, ToolCall>;
  usage: UsageType | null;
}

function looksLikeCompleteJson(s: string): boolean {
  if (!s.trim()) return false;
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
}

/** Repair malformed tool call arguments using jsonrepair. */
function repairToolCallArgs(tc: ToolCall): ToolCall {
  try {
    const args = tc.function?.arguments ?? "{}";
    const repaired = jsonrepair(args);
    if (repaired !== args) {
      return {
        ...tc,
        function: { ...tc.function, arguments: repaired },
      };
    }
  } catch {
    /* repair failed — use original */
  }
  return tc;
}

/** Drop a trailing assistant-with-tool_calls before a forced exit so the next
 *  API call doesn't 400 on unpaired tool_calls. Returns true if trimmed. */
function trimTrailingToolCalls(log: AppendOnlyLog): boolean {
  const entries = log.entries;
  const tail = entries[entries.length - 1];
  if (
    tail &&
    tail.role === "assistant" &&
    Array.isArray(tail.tool_calls) &&
    tail.tool_calls.length > 0
  ) {
    log.compactInPlace(entries.slice(0, -1));
    return true;
  }
  return false;
}

async function* streamModelResponse(
  client: DeepSeekClient,
  model: string,
  messages: ChatMessage[],
  tools: ReadonlyArray<unknown>,
  thinking: boolean,
  reasoningEffort: string | undefined,
  maxTokens: number | undefined,
  toolChoice: ChatOptions["toolChoice"],
  signal: AbortSignal,
  turn: number,
): AsyncGenerator<LoopEvent, Accumulator, void> {
  const acc: Accumulator = {
    content: "",
    reasoning: "",
    toolCalls: new Map(),
    usage: null,
  };
  const readyIndices = new Set<number>();

  const chatOpts: ChatOptions = {
    model,
    messages,
    tools: tools.length ? (tools as ChatOptions["tools"]) : undefined,
    thinking: thinking ? "enabled" : "disabled",
    reasoningEffort: reasoningEffort as "high" | "max" | undefined,
    maxTokens,
    toolChoice,
    signal,
  };

  for await (const chunk of client.stream(chatOpts)) {
    if (chunk.reasoningDelta) {
      acc.reasoning += chunk.reasoningDelta;
      yield {
        turn,
        role: "reasoning_delta",
        content: chunk.reasoningDelta,
      };
    }
    if (chunk.contentDelta) {
      acc.content += chunk.contentDelta;
      yield {
        turn,
        role: "assistant_delta",
        content: chunk.contentDelta,
      };
    }
    if (chunk.toolCallDelta) {
      const d = chunk.toolCallDelta;
      const cur = acc.toolCalls.get(d.index) ?? {
        id: d.id,
        type: "function" as const,
        function: { name: "", arguments: "" },
      };
      if (d.id) cur.id = d.id;
      if (d.name) cur.function.name = (cur.function.name ?? "") + d.name;
      if (d.argumentsDelta) {
        cur.function.arguments = (cur.function.arguments ?? "") + d.argumentsDelta;
      }
      acc.toolCalls.set(d.index, cur);

      if (
        !readyIndices.has(d.index) &&
        cur.function.name &&
        looksLikeCompleteJson(cur.function.arguments ?? "")
      ) {
        readyIndices.add(d.index);
      }

      if (cur.function.name) {
        yield {
          turn,
          role: "tool_call_delta",
          toolName: cur.function.name,
          argsChars: (cur.function.arguments ?? "").length,
          argsDelta: d.argumentsDelta,
          index: d.index,
        };
      }
    }
    if (chunk.usage) acc.usage = chunk.usage;
  }

  return acc;
}

export function createGameLoop(opts: GameLoopOptions) {
  const client = opts.client;
  const prefix = opts.prefix;
  const log = new AppendOnlyLog({ persistence: opts.persistence });

  // Heal messages loaded from persistence on resume — oversized tool results,
  // missing reasoning_content, unpaired tool calls would 400 the next API call.
  if (log.totalLength > 0) {
    const loaded = log.toFullHistory();
    const healed = healMessages(loaded, {
      thinkingModeModel:
        ((opts.reasoningEffort && opts.reasoningEffort !== "none") ?? true)
          ? (opts.model ?? "deepseek-v4-flash")
          : null,
    });
    if (healed.healedCount > 0) {
      log.compactInPlace(healed.messages);
    }
  }

  const runTool = opts.runTool;
  const onIterStart = opts.onIterStart;
  const canEndTurn = opts.canEndTurn;
  const rebuildSystem = opts.rebuildSystem;

  let model = opts.model ?? "deepseek-v4-flash";
  let thinking = (opts.reasoningEffort && opts.reasoningEffort !== "none") ?? true;
  const reasoningEffort = opts.reasoningEffort;
  let maxOutputTokens = opts.maxOutputTokens;
  let toolChoice = opts.toolChoice;
  const maxIterPerTurn = opts.maxIterPerTurn ?? DEFAULT_MAX_ITER_PER_TURN;
  let turn = 0;
  const cacheDiagnostics: CacheDiagnostic[] = [];

  let turnAbort: AbortController = new AbortController();
  let discardAbortRequested = false;

  const context = new ContextManager({
    client,
    log,
    getAbortSignal: () => turnAbort.signal,
    getCurrentTurn: () => turn,
    getSystemPrompt: () => prefix.system,
    getToolSpecs: () => prefix.toolSpecs,
    getFewShots: () => prefix.fewShots,
  });

  // Healing cache — avoids recomputing the expensive 4-pass healing
  // pipeline every time buildMessages() is called (2-3x per iteration).
  // Invalidated by log version bumps from append/compactInPlace.
  let _healedCache: ChatMessage[] | null = null;
  let _healedVersion = -1;

  function buildMessages(): ChatMessage[] {
    if (_healedCache && _healedVersion === log.version) {
      return [...prefix.toMessages(), ..._healedCache];
    }
    const raw = log.toFullHistory();
    const healed = healMessages(raw, {
      thinkingModeModel: thinking ? model : null,
    });
    if (healed.healedCount > 0) {
      // Persist healed state so the same break isn't re-noticed on every
      // buildMessages() call or session resume.
      log.compactInPlace(healed.messages);
    }
    _healedCache = healed.messages;
    _healedVersion = log.version;
    return [...prefix.toMessages(), ..._healedCache];
  }

  async function* step(userInput: string): AsyncGenerator<LoopEvent> {
    turn++;
    const turnStartLogIndex = log.length;
    log.append({ role: "user", content: userInput, name: SCRIBE });

    turnAbort = new AbortController();
    discardAbortRequested = false;
    const signal = turnAbort.signal;

    // ── Turn-start fold check ──
    const messages = buildMessages();
    const tsEstimate = context.estimateTurnStart(messages, prefix.toolSpecs, model);
    if (tsEstimate.ratio > TURN_START_FOLD_THRESHOLD) {
      yield {
        turn,
        role: "warning",
        severity: "high",
        content: `Context at ${Math.round(tsEstimate.ratio * 100)}% — folding history before starting turn.`,
      };
      await context.compact(model, undefined, { requireTailBoundary: true });
    }

    let foldedThisTurn = false;
    let turnSelfCorrected = false;

    for (let iter = 0; iter < maxIterPerTurn; iter++) {
      // Storm detection: track (name + args) signatures for THIS iteration
      // only. Resetting each iter lets the model re-attempt a call after
      // getting new context, while still catching duplicate calls within a
      // single response.
      const previousToolCalls = new Set<string>();
      if (signal.aborted) {
        // On discard, truncate the log to what existed before this turn
        // started. compactInPlace calls persistence.rewrite() internally,
        // so the on-disk session file is also updated — discarded messages
        // do not reappear on session resume.
        if (discardAbortRequested && turnStartLogIndex >= 0) {
          log.compactInPlace(log.toFullHistory().slice(0, turnStartLogIndex));
        } else {
          // Non-discard abort: append synthetic assistant message so the
          // user can see the interruption and retry.
          log.append({
            role: "assistant",
            content: "[aborted by user — ask again or retry when ready]",
            name: STORYTELLER,
          });
        }
        yield { turn, role: "done", content: "[aborted]" };
        return;
      }

      if (onIterStart) onIterStart(iter, log);

      const requestMessages = buildMessages();
      const toolsSnap = prefix.tools();

      let acc: Accumulator;
      try {
        acc = yield* streamModelResponse(
          client,
          model,
          requestMessages,
          toolsSnap,
          thinking,
          reasoningEffort,
          maxOutputTokens,
          toolChoice,
          signal,
          turn,
        );
      } catch (err) {
        if (err instanceof DeepSeekError) {
          yield {
            turn,
            role: "error",
            content: "",
            error: err.message,
            retryable: err.retryable,
          };
        } else {
          console.error("[loop] unexpected error in streamModelResponse:", err);
          const msg = err instanceof Error ? err.message : String(err);
          yield {
            turn,
            role: "error",
            content: "",
            error: `API request failed: ${msg}`,
            retryable: false,
          };
        }
        return;
      }

      if (!acc.usage) {
        yield {
          turn,
          role: "error",
          content: "",
          error: "No usage data in response",
          retryable: true,
        };
        return;
      }

      // ── Cache diagnostic ──
      const prevDiag = cacheDiagnostics[cacheDiagnostics.length - 1];
      const diag = buildCacheDiagnostic({
        turn,
        model,
        usage: acc.usage,
        prefix: prefixDiagnosticHashes({
          system: prefix.system,
          toolSpecs: toolsSnap,
          fewShots: prefix.fewShots,
        }),
        previous: prevDiag,
      });
      cacheDiagnostics.push(diag);

      // ── Repair tool call arguments ──
      const toolCalls = [...acc.toolCalls.values()].map(repairToolCallArgs);

      yield {
        turn,
        role: "assistant_final",
        content: acc.content,
        reasoning: acc.reasoning || null,
        usage: acc.usage,
        cacheHitRatio: acc.usage.cacheHitRatio,
      };

      // ── Persist assistant message ──
      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: acc.content || null,
        name: STORYTELLER,
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      if (thinking) {
        assistantMsg.reasoning_content = acc.reasoning || "";
      }
      log.append(assistantMsg);

      // ── No tool calls = turn complete (unless blocked by canEndTurn) ──
      if (toolCalls.length === 0) {
        const blockReason = canEndTurn?.();
        if (blockReason) {
          log.append({ role: "user", content: blockReason, name: SCRIBE });
          continue;
        }
        yield { turn, role: "done", content: acc.content };
        return;
      }

      // ── Dispatch tool calls (with storm detection) ──
      let suppressedCount = 0;
      for (const tc of toolCalls) {
        const sig = `${tc.function?.name}:${tc.function?.arguments}`;
        if (previousToolCalls.has(sig)) {
          suppressedCount++;
          log.append({
            role: "tool",
            tool_call_id: tc.id ?? "",
            name: tc.function?.name ?? "",
            content:
              "[suppressed] identical call to previous iteration — try a different approach.",
          });
          yield {
            turn,
            role: "tool_result",
            toolCallId: tc.id ?? "",
            name: tc.function?.name ?? "",
            result: "[suppressed] identical call",
          };
          continue;
        }
        previousToolCalls.add(sig);

        if (signal.aborted) {
          yield {
            turn,
            role: "done",
            content: "[aborted during tool dispatch]",
          };
          return;
        }

        const name = tc.function?.name ?? "unknown";
        const args = tc.function?.arguments ?? "{}";

        let toolResult;
        try {
          toolResult = await runTool(name, args, signal);
        } catch (err) {
          toolResult = {
            result: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        log.append({
          role: "tool",
          tool_call_id: tc.id ?? "",
          name,
          content: toolResult.result,
        });
        yield {
          turn,
          role: "tool_result",
          toolCallId: tc.id ?? "",
          name,
          result: toolResult.result,
        };

        if (toolResult.turnComplete) {
          yield { turn, role: "done", content: acc.content };
          return;
        }
      }

      // ── All calls suppressed ──
      const allSuppressed = suppressedCount > 0 && suppressedCount === toolCalls.length;

      if (allSuppressed && !turnSelfCorrected) {
        // First all-suppressed: give model one self-correction chance.
        // The assistant message already carries the original tool_calls in
        // the log, and the for-loop above appended suppressed tool stubs for
        // each call, so the model sees what was attempted and can recover.
        turnSelfCorrected = true;
        yield {
          turn,
          role: "warning",
          severity: "low",
          content: "All tool calls were repeat calls. Try a different approach.",
        };
        continue;
      }

      if (allSuppressed) {
        // Second all-suppressed → model is truly stuck
        yield {
          turn,
          role: "warning",
          severity: "high",
          content: "All tool calls suppressed again — model is stuck in a loop.",
        };
        trimTrailingToolCalls(log);
        yield { turn, role: "done", content: acc.content };
        return;
      }

      // ── Context check ──
      if (acc.usage) {
        const decision = context.decideAfterUsage(acc.usage, model, foldedThisTurn);
        if (decision.kind === "fold" && !foldedThisTurn) {
          foldedThisTurn = true;
          yield {
            turn,
            role: "warning",
            severity: "low",
            content: `Context at ${Math.round(decision.ratio * 100)}% — compacting history.`,
          };
          await context.compact(model);
        } else if (decision.kind === "exit-with-summary") {
          yield {
            turn,
            role: "warning",
            severity: "high",
            content: `Context exhausted at ${Math.round(decision.ratio * 100)}% — forcing summary.`,
          };
          trimTrailingToolCalls(log);
          yield { turn, role: "done", content: acc.content };
          return;
        }
      }
    }

    // ── Max iterations reached ──
    trimTrailingToolCalls(log);
    yield {
      turn,
      role: "warning",
      severity: "high",
      content: `Reached max iterations (${maxIterPerTurn}).`,
    };
    yield { turn, role: "done", content: "" };
  }

  function abort(opts?: { discardCurrentTurn?: boolean }): void {
    if (opts?.discardCurrentTurn) discardAbortRequested = true;
    turnAbort.abort();
  }

  function clearLog(opts?: { rebuildSystem?: boolean }): {
    dropped: number;
    systemRebuilt: boolean;
  } {
    const dropped = log.length;
    log.persistence?.archive();
    log.compactInPlace([]);
    _healedCache = null;
    _healedVersion = -1;
    turn = 0;
    let systemRebuilt = false;
    if (opts?.rebuildSystem && rebuildSystem) {
      try {
        systemRebuilt = prefix.replaceSystem(rebuildSystem());
      } catch {
        /* builder threw — keep prior */
      }
    }
    return { dropped, systemRebuilt };
  }

  function configure(opts: ReconfigurableOptions): void {
    if (opts.model !== undefined) model = opts.model;
    if (opts.thinking !== undefined) thinking = opts.thinking;
    if (opts.maxOutputTokens !== undefined) maxOutputTokens = opts.maxOutputTokens;
    if (opts.toolChoice !== undefined) toolChoice = opts.toolChoice;
  }

  return {
    step,
    abort,
    clearLog,
    configure,
    getLogTokens: () => 0,
    getCacheDiagnostics: () => cacheDiagnostics,
    currentTurn: turn,
  };
}
