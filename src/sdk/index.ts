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

export { DeepSeekClient } from "./client.js";
export type { DeepSeekClientOptions } from "./client.js";

export { ImmutablePrefix } from "./prefix.js";
export type { ImmutablePrefixOptions } from "./prefix.js";

export { AppendOnlyLog, JsonlPersistence } from "./log.js";

export { healMessages, stripHallucinatedToolMarkup } from "./healing.js";
export type { HealingOptions, HealingResult } from "./healing.js";

export { ContextManager } from "./context.js";
export type { ContextManagerDeps, PostUsageDecision, FoldResult } from "./context.js";

export { createGameLoop } from "./loop.js";

export { buildCacheDiagnostic, prefixDiagnosticHashes } from "./diagnostics.js";
export type { CacheDiagnostic, PrefixDiagnosticHashes } from "./diagnostics.js";

export { vercelToolToSpec } from "./bridge.js";

export { Usage } from "./types.js";
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
} from "./types.js";
