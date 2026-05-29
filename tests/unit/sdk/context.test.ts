import { describe, it, expect, vi } from "vitest";
import { ContextManager } from "@/sdk/context.js";
import { Usage } from "@/sdk/types.js";
import type { AppendOnlyLog } from "@/sdk/log.js";
import type { DeepSeekClient } from "@/sdk/client.js";
import type { ChatMessage } from "@/sdk/types.js";

function mockLog(messages: ChatMessage[]): AppendOnlyLog {
  return {
    entries: messages.map((m) => ({ ...m })),
    toFullHistory: () => messages.map((m) => ({ ...m })),
    compactInPlace: vi.fn(),
    version: 1,
    length: messages.length,
    append: vi.fn(),
    totalLength: messages.length,
    persistence: null,
  } as unknown as AppendOnlyLog;
}

describe("ContextManager", () => {
  const mockClient = {} as DeepSeekClient;

  function createManager() {
    return new ContextManager({
      client: mockClient,
      log: mockLog([]),
      getAbortSignal: () => new AbortController().signal,
      getCurrentTurn: () => 1,
      getSystemPrompt: () => "system prompt",
    });
  }

  describe("decideAfterUsage", () => {
    it("returns 'none' when usage is null", () => {
      const d = createManager().decideAfterUsage(null, "deepseek-v4-flash", false);
      expect(d.kind).toBe("none");
      expect(d.ratio).toBe(0);
    });

    it("returns 'none' when well below threshold", () => {
      const d = createManager().decideAfterUsage(
        new Usage(1000, 200, 1200, 0, 1000),
        "deepseek-v4-flash",
        false,
      );
      expect(d.kind).toBe("none");
    });

    it("returns 'fold' when exceeding 75% threshold", () => {
      const d = createManager().decideAfterUsage(
        new Usage(100_000, 2000, 102_000, 0, 100_000),
        "deepseek-v4-flash",
        false,
      );
      expect(d.kind).toBe("fold");
      expect(d.ratio).toBeGreaterThan(0.75);
      expect(d.tailBudget).toBeDefined();
    });

    it("returns 'none' when already folded this turn", () => {
      const d = createManager().decideAfterUsage(
        new Usage(100_000, 2000, 102_000, 0, 100_000),
        "deepseek-v4-flash",
        true,
      );
      expect(d.kind).toBe("none");
    });

    it("returns 'exit-with-summary' when exceeding 80%", () => {
      const d = createManager().decideAfterUsage(
        new Usage(110_000, 2000, 112_000, 0, 110_000),
        "deepseek-v4-flash",
        false,
      );
      expect(d.kind).toBe("exit-with-summary");
    });

    it("returns 'fold' with aggressive tail when exceeding 78%", () => {
      const d = createManager().decideAfterUsage(
        new Usage(104_000, 2000, 106_000, 0, 104_000),
        "deepseek-v4-flash",
        false,
      );
      expect(d.kind).toBe("fold");
      expect(d.aggressive).toBe(true);
    });
  });

  describe("estimateTurnStart", () => {
    it("returns ratio relative to 131K context window", () => {
      const msgs = Array.from({ length: 100 }, (_, i) => ({
        role: "user" as const,
        content: `message ${i}`,
      }));
      const est = createManager().estimateTurnStart(msgs, [], "deepseek-v4-flash");
      expect(est.ctxMax).toBe(131_072);
      expect(est.estimateTokens).toBeGreaterThan(0);
      expect(est.ratio).toBeGreaterThan(0);
    });

    it("defaults to 131K for unknown models", () => {
      const msgs: ChatMessage[] = [];
      const est = createManager().estimateTurnStart(msgs, null, "some-unknown-model");
      expect(est.ctxMax).toBe(131_072);
      expect(est.estimateTokens).toBe(0);
      expect(est.ratio).toBe(0);
    });

    it("includes tool specs in token estimate", () => {
      const msgs: ChatMessage[] = [];
      const toolSpecs = [
        {
          type: "function" as const,
          function: {
            name: "test",
            description: "a test tool",
            parameters: { type: "object", properties: { x: { type: "string" } } },
          },
        },
      ];
      const est = createManager().estimateTurnStart(msgs, toolSpecs, "deepseek-v4-flash");
      expect(est.estimateTokens).toBeGreaterThan(0);
    });
  });

  describe("fold", () => {
    it("returns noop on empty log", async () => {
      const mgr = createManager();
      const result = await mgr.fold("deepseek-v4-flash");
      expect(result.folded).toBe(false);
      expect(result.beforeMessages).toBe(0);
    });

    it("returns noop when log is too short to fold", async () => {
      const msgs: ChatMessage[] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ];
      const log = mockLog(msgs);
      const mgr = new ContextManager({
        client: mockClient,
        log,
        getAbortSignal: () => new AbortController().signal,
        getCurrentTurn: () => 1,
        getSystemPrompt: () => "system prompt",
      });
      const result = await mgr.fold("deepseek-v4-flash");
      expect(result.folded).toBe(false);
    });
  });
});
