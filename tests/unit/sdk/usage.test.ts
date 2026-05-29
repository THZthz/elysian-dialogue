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

// tests/unit/sdk/usage.test.ts
import { describe, it, expect } from "vitest";
import { Usage } from "@/sdk/types.js";

describe("Usage", () => {
  it("constructs with explicit values", () => {
    const u = new Usage(100, 50, 150, 60, 40);
    expect(u.promptTokens).toBe(100);
    expect(u.completionTokens).toBe(50);
    expect(u.totalTokens).toBe(150);
    expect(u.promptCacheHitTokens).toBe(60);
    expect(u.promptCacheMissTokens).toBe(40);
  });

  it("defaults to zero", () => {
    const u = new Usage();
    expect(u.promptTokens).toBe(0);
    expect(u.completionTokens).toBe(0);
    expect(u.cacheHitRatio).toBe(0);
  });

  it("computes cacheHitRatio", () => {
    const u = new Usage(0, 0, 0, 60, 40);
    expect(u.cacheHitRatio).toBe(0.6);
  });

  it("cacheHitRatio returns 0 when denominator is 0", () => {
    const u = new Usage();
    expect(u.cacheHitRatio).toBe(0);
  });

  describe("fromApi", () => {
    it("parses standard DeepSeek usage", () => {
      const raw = {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_cache_hit_tokens: 60,
        prompt_cache_miss_tokens: 40,
      };
      const u = Usage.fromApi(raw);
      expect(u.promptTokens).toBe(100);
      expect(u.completionTokens).toBe(50);
      expect(u.totalTokens).toBe(150);
      expect(u.promptCacheHitTokens).toBe(60);
      expect(u.promptCacheMissTokens).toBe(40);
    });

    it("handles ollama-style eval_count fields", () => {
      const raw = {
        prompt_eval_count: 80,
        eval_count: 30,
        total_tokens: 110,
        prompt_cache_hit_tokens: 20,
      };
      const u = Usage.fromApi(raw);
      expect(u.promptTokens).toBe(80);
      expect(u.completionTokens).toBe(30);
      expect(u.promptCacheHitTokens).toBe(20);
      expect(u.promptCacheMissTokens).toBe(60);
    });

    it("handles missing cache fields", () => {
      const raw = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
      const u = Usage.fromApi(raw);
      expect(u.promptCacheHitTokens).toBe(0);
      expect(u.promptCacheMissTokens).toBe(100);
    });

    it("handles null/undefined", () => {
      const u = Usage.fromApi(null);
      expect(u.promptTokens).toBe(0);
      expect(u.completionTokens).toBe(0);
    });
  });
});
