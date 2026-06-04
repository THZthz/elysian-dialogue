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

// src/sdk/types.ts
// DeepSeek API message format (OpenAI-compatible)

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string;
}

export interface ToolCall {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// Usage

export type RawUsage = {
  prompt_tokens?: number;
  prompt_eval_count?: number;
  completion_tokens?: number;
  eval_count?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
};

export class Usage {
  constructor(
    public promptTokens: number = 0,
    public completionTokens: number = 0,
    public totalTokens: number = 0,
    public promptCacheHitTokens: number = 0,
    public promptCacheMissTokens: number = 0,
  ) {}

  get cacheHitRatio(): number {
    const denom = this.promptCacheHitTokens + this.promptCacheMissTokens;
    return denom > 0 ? this.promptCacheHitTokens / denom : 0;
  }

  static fromApi(raw: RawUsage | undefined | null): Usage {
    const u = raw ?? {};
    const promptTokens = u.prompt_tokens ?? u.prompt_eval_count ?? 0;
    const completionTokens = u.completion_tokens ?? u.eval_count ?? 0;
    const cacheHitTokens = u.prompt_cache_hit_tokens ?? 0;
    const cacheMissTokens =
      u.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHitTokens);
    return new Usage(
      promptTokens,
      completionTokens,
      u.total_tokens ?? promptTokens + completionTokens,
      cacheHitTokens,
      cacheMissTokens,
    );
  }
}

// Stream chunks (internal to DeepSeekClient)

export interface StreamChunk {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCallDelta?: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
  usage?: Usage;
  finishReason?: string;
  raw: unknown;
}

// Chat request / response

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: readonly ToolSpec[];
  signal?: AbortSignal;
  thinking?: "enabled" | "disabled";
  reasoningEffort?: "high" | "max";
  maxTokens?: number;
}

export interface ChatResponse {
  content: string;
  reasoningContent: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
}

// Loop events (yielded by the generator)

export type LoopEvent =
  | { turn: number; role: "assistant_delta"; content: string }
  | { turn: number; role: "reasoning_delta"; content: string }
  | {
      turn: number;
      role: "tool_call_delta";
      toolName: string;
      argsChars: number;
      argsDelta?: string;
      index: number;
    }
  | { turn: number; role: "tool_result"; toolCallId: string; name: string; result: string }
  | {
      turn: number;
      role: "assistant_final";
      content: string;
      reasoning: string | null;
      usage: Usage;
      cacheHitRatio: number;
    }
  | { turn: number; role: "warning"; severity: "low" | "high"; content: string }
  | { turn: number; role: "error"; content: string; error: string; retryable: boolean }
  | { turn: number; role: "done"; content: string };

// Game loop options

export interface ToolResult {
  result: string;
  turnComplete?: boolean;
}

export interface ReconfigurableOptions {
  model?: string;
  thinking?: boolean;
  maxOutputTokens?: number;
}

export interface SessionMeta {
  totalCostUsd: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalCompletionTokens: number;
  turnCount: number;
  lastPromptTokens: number;
}

export interface SessionPersistence {
  load(): ChatMessage[];
  append(message: ChatMessage): void;
  rewrite(messages: ChatMessage[]): void;
  archive(): string | null;
  loadMeta(): SessionMeta | null;
  saveMeta(meta: SessionMeta): void;
}

// Forward-declare classes to break circular type dependency
import type { DeepSeekClient } from "@/sdk/client";
import type { ImmutablePrefix } from "@/sdk/prefix";
import type { AppendOnlyLog } from "@/sdk/log";

export interface GameLoopOptions {
  client: DeepSeekClient;
  prefix: ImmutablePrefix;
  sessionName?: string;
  model?: string;
  /** In thinking mode, 'low' and 'medium' are mapped to 'high', and 'xhigh' is mapped to 'max',
   *  these thinking effort control correspond to 'reasoning_effort' in API request. Setting
   *  'reasoningEffort' to 'none' will set 'thinking' to '{"type": "disabled" }' in request. */
  reasoningEffort?: "none" | "high" | "max";
  maxOutputTokens?: number;
  maxIterPerTurn?: number;
  runTool: (name: string, args: string, signal: AbortSignal) => Promise<ToolResult>;
  onIterStart?: (iter: number, log: AppendOnlyLog) => void;
  /** If provided, checked before ending the turn on "no tool calls."
   *  Return null/undefined if the turn can end; return a nudge message string
   *  to inject into the log and continue instead. */
  canEndTurn?: () => string | null | undefined;
  rebuildSystem?: () => string;
  persistence?: SessionPersistence;
}
