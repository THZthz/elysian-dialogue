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

// src/sdk/index.ts
// DeepSeek API SDK — public entry point.
// Re-exports every symbol that callers need.

export { DeepSeekClient } from "@/sdk/client";
export type { DeepSeekClientOptions } from "@/sdk/client";

export { ImmutablePrefix } from "@/sdk/prefix";
export type { ImmutablePrefixOptions } from "@/sdk/prefix";

export { AppendOnlyLog, JsonlPersistence } from "@/sdk/log";

export { healMessages, stripHallucinatedToolMarkup } from "@/sdk/healing";
export type { HealingOptions, HealingResult } from "@/sdk/healing";

export { ContextManager } from "@/sdk/context";
export type { ContextManagerDeps, PostUsageDecision, FoldResult } from "@/sdk/context";

export { createGameLoop } from "@/sdk/loop";

export { buildCacheDiagnostic, prefixDiagnosticHashes } from "@/sdk/diagnostics";
export type { CacheDiagnostic, PrefixDiagnosticHashes } from "@/sdk/diagnostics";

export { toolToSpec } from "@/sdk/bridge";
export type { Tool } from "@/sdk/bridge";

export { Usage } from "@/sdk/types";
export type {
  ChatMessage,
  ToolCall,
  ToolSpec,
  StreamChunk,
  ChatOptions,
  ChatResponse,
  LoopEvent,
  ToolResult,
  GameLoopOptions,
  SessionPersistence,
  SessionMeta,
  ReconfigurableOptions,
} from "@/sdk/types";
