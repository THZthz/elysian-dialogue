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
