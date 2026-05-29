// src/sdk/loop.ts
// GameLoop — generator-based turn loop that streams model output, dispatches
// tool calls, detects storms, and folds history via ContextManager.
import { jsonrepair } from "jsonrepair";
import type { DeepSeekClient } from "./client.js";
import type { ImmutablePrefix } from "./prefix.js";
import { AppendOnlyLog } from "./log.js";
import { ContextManager } from "./context.js";
import { healMessages } from "./healing.js";
import {
  buildCacheDiagnostic,
  prefixDiagnosticHashes,
  type CacheDiagnostic,
} from "./diagnostics.js";
import type {
  ChatMessage,
  ChatOptions,
  ToolCall,
  LoopEvent,
  GameLoopOptions,
  ReconfigurableOptions,
  Usage as UsageType,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ITER_PER_TURN = 10;
const TURN_START_FOLD_THRESHOLD = 0.9;

// ---------------------------------------------------------------------------
// Accumulator
// ---------------------------------------------------------------------------

interface Accumulator {
  content: string;
  reasoning: string;
  toolCalls: Map<number, ToolCall>;
  usage: UsageType | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// streamModelResponse
// ---------------------------------------------------------------------------

async function* streamModelResponse(
  client: DeepSeekClient,
  model: string,
  messages: ChatMessage[],
  tools: ReadonlyArray<unknown>,
  thinking: boolean,
  reasoningEffort: string | undefined,
  maxTokens: number | undefined,
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
    reasoningEffort: reasoningEffort as "low" | "medium" | "high" | undefined,
    maxTokens,
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

// ---------------------------------------------------------------------------
// createGameLoop
// ---------------------------------------------------------------------------

export function createGameLoop(opts: GameLoopOptions) {
  const client = opts.client;
  const prefix = opts.prefix;
  const log = opts.sessionName
    ? new AppendOnlyLog({ persistence: opts.persistence })
    : new AppendOnlyLog();

  // Heal messages loaded from persistence on resume — oversized tool results,
  // missing reasoning_content, unpaired tool calls would 400 the next API call.
  if (log.totalLength > 0 && opts.persistence) {
    const loaded = log.toFullHistory();
    const healed = healMessages(loaded, {
      thinkingModeModel:
        (opts.thinking ?? true) && opts.model ? opts.model : null,
    });
    if (healed.healedCount > 0) {
      log.compactInPlace(healed.messages);
    }
  }

  const runTool = opts.runTool;
  const onIterStart = opts.onIterStart;
  const rebuildSystem = opts.rebuildSystem;

  let model = opts.model ?? "deepseek-v4-flash";
  let thinking = opts.thinking ?? true;
  let reasoningEffort = opts.reasoningEffort;
  let maxOutputTokens = opts.maxOutputTokens;
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
    log.append({ role: "user", content: userInput });

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
      await context.fold(model, { requireTailBoundary: true });
    }

    let foldedThisTurn = false;
    const previousToolCalls = new Set<string>(); // storm detection

    for (let iter = 0; iter < maxIterPerTurn; iter++) {
      if (signal.aborted) {
        // On discard, truncate the log to what existed before this turn
        // started. compactInPlace calls persistence.rewrite() internally,
        // so the on-disk session file is also updated — discarded messages
        // do not reappear on session resume.
        if (discardAbortRequested && turnStartLogIndex >= 0) {
          log.compactInPlace(log.toFullHistory().slice(0, turnStartLogIndex));
        }
        yield { turn, role: "done", content: "[aborted]" };
        return;
      }

      if (onIterStart) onIterStart(iter, log);

      const requestMessages = buildMessages();
      const toolsSnap = prefix.tools();

      const acc = yield* streamModelResponse(
        client,
        model,
        requestMessages,
        toolsSnap,
        thinking,
        reasoningEffort,
        maxOutputTokens,
        signal,
        turn,
      );

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
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      if (thinking) {
        assistantMsg.reasoning_content = acc.reasoning || "";
      }
      log.append(assistantMsg);

      // ── No tool calls = turn complete ──
      if (toolCalls.length === 0) {
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

      // ── All calls suppressed → force summary ──
      if (suppressedCount > 0 && suppressedCount === toolCalls.length) {
        yield {
          turn,
          role: "warning",
          severity: "high",
          content: "All tool calls suppressed — model is stuck in a loop.",
        };
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
          await context.fold(model);
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
