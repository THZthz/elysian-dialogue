// src/sdk/diagnostics.ts
// Cache telemetry — tracks prefix-hash stability across turns so callers can
// detect cache-warm/cache-cold transitions and attribute cache misses.
import { createHash } from "node:crypto";
import type { Usage } from "./types.js";

export interface PrefixDiagnosticHashes {
  system: string;
  tools: string;
  fewShots: string;
}

export interface CacheDiagnostic {
  turn: number;
  model: string;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheHitRatio: number;
  estimatedCostUsd: number;
  prefixHashes: PrefixDiagnosticHashes;
  previousHashes?: PrefixDiagnosticHashes;
  cacheWarm: boolean;
}

/**
 * Compute short (12-char hex) SHA-256 hashes of the three prefix segments.
 * Callers can compare these across turns to detect cache breaks.
 */
export function prefixDiagnosticHashes(opts: {
  system: string;
  toolSpecs: ReadonlyArray<unknown>;
  fewShots: ReadonlyArray<unknown>;
}): PrefixDiagnosticHashes {
  return {
    system: createHash("sha256").update(opts.system).digest("hex").slice(0, 12),
    tools: createHash("sha256").update(JSON.stringify(opts.toolSpecs)).digest("hex").slice(0, 12),
    fewShots: createHash("sha256").update(JSON.stringify(opts.fewShots)).digest("hex").slice(0, 12),
  };
}

/**
 * Build a single-turn cache diagnostic entry.
 *
 * `cacheWarm` is true when the current prefix hashes match the *previous* turn's
 * hashes — meaning the server-side prefix cache should be hot.
 */
export function buildCacheDiagnostic(opts: {
  turn: number;
  model: string;
  usage: Usage;
  prefix: PrefixDiagnosticHashes;
  previous?: CacheDiagnostic;
}): CacheDiagnostic {
  const cacheWarm =
    opts.previous !== undefined &&
    opts.previous.prefixHashes.system === opts.prefix.system &&
    opts.previous.prefixHashes.tools === opts.prefix.tools &&
    opts.previous.prefixHashes.fewShots === opts.prefix.fewShots;

  return {
    turn: opts.turn,
    model: opts.model,
    promptTokens: opts.usage.promptTokens,
    cacheHitTokens: opts.usage.promptCacheHitTokens,
    cacheMissTokens: opts.usage.promptCacheMissTokens,
    cacheHitRatio: opts.usage.cacheHitRatio,
    estimatedCostUsd: 0,
    prefixHashes: opts.prefix,
    previousHashes: opts.previous?.prefixHashes,
    cacheWarm,
  };
}
