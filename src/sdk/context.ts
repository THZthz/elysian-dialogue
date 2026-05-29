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

// src/sdk/context.ts
// ContextManager — decides when to fold history and performs chat()-based
// compaction by summarizing older turns into a single assistant message.
import type { DeepSeekClient } from "@/sdk/client";
import type { AppendOnlyLog } from "@/sdk/log";
import type { ChatMessage, ToolSpec, Usage } from "@/sdk/types";
import { healMessages, stripHallucinatedToolMarkup } from "@/sdk/healing";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FOLD_THRESHOLD = 0.75;
const AGGRESSIVE_THRESHOLD = 0.78;
const FORCE_SUMMARY_THRESHOLD = 0.8;
const FOLD_TAIL_FRACTION = 0.2;
const AGGRESSIVE_TAIL_FRACTION = 0.1;
const FOLD_MIN_SAVINGS_FRACTION = 0.3;
const FOLD_SUMMARY_TIMEOUT_MS = 15_000;

/** Extract HIGH PRIORITY constraints / User memory / Project memory blocks
 *  from the system prompt so they survive compaction. */
function extractPinnedConstraints(systemPrompt: string): string {
  const pattern =
    /# (?:HIGH PRIORITY constraints|User memory|Project memory)[\s\S]*?(?=\n# |\n---|$)/g;
  return Array.from(systemPrompt.matchAll(pattern), (m) => m[0]).join("\n\n");
}

const CONTEXT_TOKENS: Record<string, number> = {
  "deepseek-v4-flash": 131_072,
  "deepseek-v4-pro": 131_072,
  "deepseek-chat": 131_072,
};
const DEFAULT_CONTEXT = 131_072;

function resolveContextTokens(model: string): number {
  return CONTEXT_TOKENS[model] ?? DEFAULT_CONTEXT;
}

function countTokensBounded(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateRequestTokens(
  messages: ChatMessage[],
  toolSpecs: ReadonlyArray<unknown> | null,
  _includeWrapper: boolean,
): number {
  let total = 0;
  for (const m of messages) {
    total += countTokensBounded(typeof m.content === "string" ? m.content : "");
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      total += countTokensBounded(JSON.stringify(m.tool_calls));
    }
    if (typeof m.reasoning_content === "string") {
      total += countTokensBounded(m.reasoning_content);
    }
  }
  if (toolSpecs) {
    total += countTokensBounded(JSON.stringify(toolSpecs));
  }
  return total;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DecisionKind = "none" | "fold" | "exit-with-summary";

export interface PostUsageDecision {
  kind: DecisionKind;
  promptTokens: number;
  ctxMax: number;
  ratio: number;
  tailBudget?: number;
  aggressive?: boolean;
}

export interface FoldResult {
  folded: boolean;
  beforeMessages: number;
  afterMessages: number;
  summaryChars: number;
}

export interface ContextManagerDeps {
  client: DeepSeekClient;
  log: AppendOnlyLog;
  getAbortSignal: () => AbortSignal;
  getCurrentTurn: () => number;
  getSystemPrompt: () => string;
  getToolSpecs?: () => ReadonlyArray<ToolSpec>;
  getFewShots?: () => ReadonlyArray<ChatMessage>;
  /** Fired when the message log was rewritten by fold; lets the loop drop
   *  session-scoped caches whose validity rested on the elided history. */
  onLogRewrite?: () => void;
  /** Returns true when the loop is configured for thinking mode.
   *  Used to stamp reasoning_content on synthetic fold summaries so the
   *  next API call doesn't 400. */
  isThinkingMode?: () => boolean;
}

// ---------------------------------------------------------------------------
// ContextManager
// ---------------------------------------------------------------------------

export class ContextManager {
  constructor(private deps: ContextManagerDeps) {}

  /** Decision after a turn's response — fold, exit with summary, or carry on. */
  decideAfterUsage(
    usage: Usage | null,
    model: string,
    alreadyFoldedThisTurn: boolean,
  ): PostUsageDecision {
    const ctxMax = resolveContextTokens(model);
    if (!usage) return { kind: "none", promptTokens: 0, ctxMax, ratio: 0 };
    const ratio = usage.promptTokens / ctxMax;
    const base = { promptTokens: usage.promptTokens, ctxMax, ratio };
    if (ratio > FORCE_SUMMARY_THRESHOLD) {
      return { kind: "exit-with-summary", ...base };
    }
    if (alreadyFoldedThisTurn) return { kind: "none", ...base };
    if (ratio > AGGRESSIVE_THRESHOLD) {
      return {
        kind: "fold",
        ...base,
        tailBudget: Math.floor(ctxMax * AGGRESSIVE_TAIL_FRACTION),
        aggressive: true,
      };
    }
    if (ratio > FOLD_THRESHOLD) {
      return {
        kind: "fold",
        ...base,
        tailBudget: Math.floor(ctxMax * FOLD_TAIL_FRACTION),
        aggressive: false,
      };
    }
    return { kind: "none", ...base };
  }

  /** Turn-start estimate vs ctxMax — caller folds if the ratio crosses
   *  TURN_START_FOLD_THRESHOLD (0.9). */
  estimateTurnStart(
    messages: ChatMessage[],
    toolSpecs: ReadonlyArray<unknown> | null,
    model: string,
  ): { estimateTokens: number; ctxMax: number; ratio: number } {
    const ctxMax = resolveContextTokens(model);
    const estimate = estimateRequestTokens(messages, toolSpecs, true);
    return { estimateTokens: estimate, ctxMax, ratio: estimate / ctxMax };
  }

  /** Summarise older turns into a single assistant message, preserving a
   *  recent tail. Uses a fast model (`deepseek-v4-flash`) with a 15 s timeout
   *  so a hung summary request cannot stall the turn loop. */
  async fold(
    model: string,
    opts?: { keepRecentTokens?: number; requireTailBoundary?: boolean },
  ): Promise<FoldResult> {
    const ctxMax = resolveContextTokens(model);
    const tailBudget = opts?.keepRecentTokens ?? Math.floor(ctxMax * FOLD_TAIL_FRACTION);
    const all = this.deps.log.toFullHistory();
    const noop: FoldResult = {
      folded: false,
      beforeMessages: all.length,
      afterMessages: all.length,
      summaryChars: 0,
    };
    if (all.length === 0) return noop;

    // Per-message token estimate — includes tool_calls JSON so heavy
    // tool-call arguments don't slip through the tail-budget check.
    const tokenCounts = all.map((m) => {
      let n = countTokensBounded(typeof m.content === "string" ? m.content : "");
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        n += countTokensBounded(JSON.stringify(m.tool_calls));
      }
      return n;
    });
    const totalTokens = tokenCounts.reduce((a, b) => a + b, 0);

    // Walk backwards accumulating tail until the budget is exhausted.
    // Align the fold boundary to the nearest user message.
    let cumTokens = 0;
    let boundary = all.length;
    for (let i = all.length - 1; i >= 0; i--) {
      if (cumTokens + tokenCounts[i]! > tailBudget) break;
      cumTokens += tokenCounts[i]!;
      if (all[i]!.role === "user") boundary = i;
    }
    if (boundary <= 0) return noop;
    if (opts?.requireTailBoundary && boundary >= all.length) return noop;

    const head = all.slice(0, boundary);
    const tail = all.slice(boundary);

    // Skip the fold if the head wouldn't shrink the log by at least 30 %.
    if (totalTokens - cumTokens < totalTokens * FOLD_MIN_SAVINGS_FRACTION) {
      return noop;
    }

    const healed = healMessages(head).messages;
    const instruction =
      "Summarize the conversation above as one self-contained prose recap. " +
      "Preserve the user's ORIGINAL OBJECTIVE, all decisions reached, " +
      "tool results still relevant, and any open todos. " +
      "Output plain prose only.";

    const fewShots = this.deps.getFewShots?.() ?? [];
    const msgs: ChatMessage[] = [
      { role: "system", content: this.deps.getSystemPrompt() },
      ...fewShots.map((m) => ({ ...m })),
      ...healed,
      { role: "user", content: instruction },
    ];

    // Wire turn abort → fold abort so Esc cancels a running fold immediately.
    const turnSignal = this.deps.getAbortSignal();
    if (turnSignal.aborted) return noop;

    const foldCtrl = new AbortController();
    let cleanupAbort = () => {};

    const onAbort = () => foldCtrl.abort();
    turnSignal.addEventListener("abort", onAbort, { once: true });
    cleanupAbort = () => turnSignal.removeEventListener("abort", onAbort);

    const timer = setTimeout(
      () => foldCtrl.abort(new Error("fold-timeout")),
      FOLD_SUMMARY_TIMEOUT_MS,
    );

    try {
      const resp = await this.deps.client.chat({
        model: "deepseek-v4-flash",
        messages: msgs,
        thinking: "disabled",
        signal: foldCtrl.signal,
      });

      const constraints = extractPinnedConstraints(this.deps.getSystemPrompt());
      const constraintTail = constraints
        ? `\n\n[PINNED CONSTRAINTS — preserved verbatim]\n\n${constraints}`
        : "";
      const summary: ChatMessage = {
        role: "assistant",
        content: `[History summary]\n${stripHallucinatedToolMarkup(resp.content)}${constraintTail}`,
      };
      // In thinking mode, stamp empty reasoning_content to prevent 400
      // on the next API call — DeepSeek requires it on ALL assistant messages.
      if (this.deps.isThinkingMode?.()) {
        summary.reasoning_content = "";
      }
      const replacement = [summary, ...tail];
      this.deps.log.compactInPlace(replacement);
      this.deps.onLogRewrite?.();
      return {
        folded: true,
        beforeMessages: all.length,
        afterMessages: replacement.length,
        summaryChars: summary.content!.length,
      };
    } catch {
      return noop;
    } finally {
      clearTimeout(timer);
      cleanupAbort();
    }
  }
}
