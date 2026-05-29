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

// tests/unit/sdk/diagnostics.test.ts
import { describe, it, expect } from "vitest";
import {
  buildCacheDiagnostic,
  prefixDiagnosticHashes,
  type CacheDiagnostic,
} from "@/sdk/diagnostics";
import { Usage } from "@/sdk/types";

describe("buildCacheDiagnostic", () => {
  const hashes = { system: "abc123", tools: "def456", fewShots: "ghi789" };

  it("builds diagnostic from usage and prefix hashes", () => {
    const diag = buildCacheDiagnostic({
      turn: 1,
      model: "deepseek-v4-flash",
      usage: new Usage(1000, 500, 1500, 600, 400),
      prefix: hashes,
    });
    expect(diag.turn).toBe(1);
    expect(diag.cacheHitRatio).toBe(0.6);
    expect(diag.cacheWarm).toBe(false);
  });

  it("detects cache-warm when hashes match previous", () => {
    const prev: CacheDiagnostic = {
      turn: 0,
      model: "deepseek-v4-flash",
      promptTokens: 500,
      cacheHitTokens: 0,
      cacheMissTokens: 500,
      cacheHitRatio: 0,
      estimatedCostUsd: 0.001,
      prefixHashes: hashes,
      cacheWarm: false,
    };
    const diag = buildCacheDiagnostic({
      turn: 1,
      model: "deepseek-v4-flash",
      usage: new Usage(800, 400, 1200, 500, 300),
      prefix: hashes,
      previous: prev,
    });
    expect(diag.cacheWarm).toBe(true);
  });

  it("detects cache-cold when hashes differ", () => {
    const prev: CacheDiagnostic = {
      turn: 0,
      model: "deepseek-v4-flash",
      promptTokens: 500,
      cacheHitTokens: 0,
      cacheMissTokens: 500,
      cacheHitRatio: 0,
      estimatedCostUsd: 0.001,
      prefixHashes: {
        system: "old",
        tools: "old",
        fewShots: "old",
      },
      cacheWarm: false,
    };
    const diag = buildCacheDiagnostic({
      turn: 1,
      model: "deepseek-v4-flash",
      usage: new Usage(800, 400, 1200, 0, 800),
      prefix: hashes,
      previous: prev,
    });
    expect(diag.cacheWarm).toBe(false);
  });

  it("cache-cold when no previous entry", () => {
    const diag = buildCacheDiagnostic({
      turn: 0,
      model: "deepseek-v4-flash",
      usage: new Usage(500, 200, 700, 0, 500),
      prefix: hashes,
    });
    expect(diag.cacheWarm).toBe(false);
    expect(diag.previousHashes).toBeUndefined();
    expect(diag.promptTokens).toBe(500);
    expect(diag.cacheHitTokens).toBe(0);
    expect(diag.cacheMissTokens).toBe(500);
  });
});

describe("prefixDiagnosticHashes", () => {
  it("returns stable hashes for the same inputs", () => {
    const opts = {
      system: "You are helpful.",
      toolSpecs: [
        {
          type: "function" as const,
          function: {
            name: "search",
            description: "search the web",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      fewShots: [{ role: "user" as const, content: "example" }],
    };
    const a = prefixDiagnosticHashes(opts);
    const b = prefixDiagnosticHashes(opts);
    expect(a).toEqual(b);
  });

  it("produces different hashes for different systems", () => {
    const base = {
      system: "System A",
      toolSpecs: [],
      fewShots: [],
    };
    const a = prefixDiagnosticHashes(base);
    const b = prefixDiagnosticHashes({ ...base, system: "System B" });
    expect(a.system).not.toBe(b.system);
  });

  it("produces hex strings of expected length", () => {
    const result = prefixDiagnosticHashes({
      system: "test",
      toolSpecs: [],
      fewShots: [],
    });
    expect(result.system).toHaveLength(12);
    expect(result.tools).toHaveLength(12);
    expect(result.fewShots).toHaveLength(12);
  });
});
