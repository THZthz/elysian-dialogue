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

// tests/unit/sdk/healing.test.ts
import { describe, it, expect } from "vitest";
import { healMessages } from "@/sdk/healing";
import type { ChatMessage } from "@/sdk/types";

describe("healMessages", () => {
  it("passes through clean messages unchanged", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const result = healMessages(msgs);
    expect(result.messages).toEqual(msgs);
    expect(result.healedCount).toBe(0);
  });

  it("drops dangling tool_calls with no matching tool response", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "search for cats" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "1",
            type: "function",
            function: { name: "search", arguments: '{"q":"cats"}' },
          },
        ],
      },
      { role: "user", content: "next turn" },
    ];
    const result = healMessages(msgs);
    expect(result.messages).toHaveLength(2);
    expect(result.healedCount).toBeGreaterThan(0);
  });

  it("drops orphan tool responses with no matching assistant", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "search" },
      {
        role: "tool",
        tool_call_id: "orphan-1",
        name: "search",
        content: "results",
      },
      { role: "user", content: "next" },
    ];
    const result = healMessages(msgs);
    expect(result.messages.some((m) => m.role === "assistant")).toBe(false);
    expect(result.messages.some((m) => m.role === "tool")).toBe(false);
    expect(result.healedCount).toBeGreaterThan(0);
  });

  it("stamps missing reasoning_content on assistant messages in thinking mode", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "1",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "1",
        name: "search",
        content: "ok",
      },
    ];
    const result = healMessages(msgs, { thinkingModeModel: "deepseek-v4-pro" });
    const assistant = result.messages.find((m) => m.role === "assistant" && m.tool_calls);
    expect(assistant).toBeDefined();
    expect(assistant!.reasoning_content).toBe("");
  });

  it("strips droppable reasoning from non-thinking turns", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: "answer",
        reasoning_content: "long stale reasoning...",
      },
    ];
    const result = healMessages(msgs, { thinkingModeModel: null });
    const assistant = result.messages.find((m) => m.role === "assistant");
    expect(assistant?.reasoning_content).toBeUndefined();
  });

  it("keeps reasoning_content in thinking mode", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "x" },
      {
        role: "assistant",
        content: "answer",
        reasoning_content: "important reasoning",
      },
    ];
    const result = healMessages(msgs, {
      thinkingModeModel: "deepseek-v4-pro",
    });
    expect(result.messages.find((m) => m.role === "assistant")?.reasoning_content).toBe(
      "important reasoning",
    );
  });

  it("truncates oversized tool results", () => {
    const hugeContent = "x".repeat(90_000);
    const msgs: ChatMessage[] = [
      { role: "user", content: "search" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "1",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "1",
        name: "search",
        content: hugeContent,
      },
    ];
    const result = healMessages(msgs);
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect((toolMsg!.content as string).length).toBeLessThan(hugeContent.length);
    expect(toolMsg!.content).toContain("[truncated]");
    expect(result.healedCount).toBeGreaterThan(0);
    expect(result.tokensSaved).toBeGreaterThan(0);
  });

  it("does not truncate tool results within limit", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "search" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "1",
            type: "function",
            function: { name: "search", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "1",
        name: "search",
        content: "short result",
      },
    ];
    const result = healMessages(msgs);
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("short result");
    expect(result.tokensSaved).toBe(0);
  });
});
