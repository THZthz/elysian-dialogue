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

import { describe, it, expect, beforeEach, vi } from "vitest";

// MUST mock BEFORE importing the subject under test
vi.mock("ai", () => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn((_n: number) => () => false),
  NoSuchToolError: { isInstance: () => false },
  tool: vi.fn(() => ({})),
}));

vi.mock("@/server/model", () => ({
  getModel: vi.fn(() => ({ model: "mock-model" })),
}));

const mockMessages: Array<{ role: string; content: unknown }> = [];
vi.mock("@/server/assistant/messages", () => ({
  loadAssistantMessages: vi.fn(() => Promise.resolve(mockMessages)),
  saveAssistantMessages: vi.fn(() => Promise.resolve()),
}));

import { streamText } from "ai";
import { autoPersist } from "@/server/assistant";
import { TurnStateMachine } from "@/server/turnState";

describe("autoPersist", () => {
  let sm: TurnStateMachine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessages.length = 0;
    sm = new TurnStateMachine();
  });

  it("builds persist prompt from tool calls and dialogue params", async () => {
    sm.recordToolCall("delegateToAssistant", { request: "find all characters" });
    sm.recordToolCall("editNote", { action: "CREATE", title: "A Clue" });
    sm.recordToolCall("generateDialogueStep");
    sm.dialogueValidated({
      messages: [{ speaker: "NARRATOR", type: "SYSTEM" as const, text: "The door creaks open." }],
      options: [
        { text: "Enter" },
        {
          text: "Run",
          check: {
            skill: "INSTINCT",
            difficulty: 10,
            difficultyText: "Hard",
            diceCount: 2,
            conditions: [],
          },
        },
      ],
    });

    const mockStreamText = streamText as ReturnType<typeof vi.fn>;
    mockStreamText.mockReturnValue({
      response: Promise.resolve({ messages: [] }),
    });

    await autoPersist(sm, 3);

    expect(mockStreamText).toHaveBeenCalledTimes(1);

    const callArgs = mockStreamText.mock.calls[0][0];
    const userMessage = (callArgs.messages as Array<{ role: string; content: string }>).find(
      (m) => m.role === "user",
    );
    expect(userMessage).toBeDefined();
    const content = userMessage!.content;

    expect(content).toContain("## TURN 3 — AUTO PERSIST");
    expect(content).toContain("## GM's Activity This Turn");
    expect(content).toContain("delegateToAssistant");
    expect(content).toContain("editNote");
    expect(content).toContain('"A Clue"');
    expect(content).toContain("## Dialogue Output");
    expect(content).toContain("The door creaks open.");
    expect(content).toContain("INSTINCT");
    expect(content).toContain("## Instructions");
    expect(content).toContain("Location changes");
    expect(content).toContain("Item movements");
    expect(content).toContain("Disposition shifts");
    expect(content).toContain("Plot triggers");
    expect(content).toContain("Time-sensitive events");
  });

  it("throws when streamText fails", async () => {
    sm.recordToolCall("generateDialogueStep");
    sm.dialogueValidated({
      messages: [{ speaker: "N", type: "SYSTEM" as const, text: "Hi." }],
      options: [{ text: "A" }, { text: "B" }],
    });

    const mockStreamText = streamText as ReturnType<typeof vi.fn>;
    mockStreamText.mockReturnValue({
      response: Promise.reject(new Error("LLM API error")),
    });

    await expect(autoPersist(sm, 1)).rejects.toThrow("LLM API error");
  });

  it("handles empty tool calls gracefully", async () => {
    sm.dialogueValidated({
      messages: [{ speaker: "N", type: "SYSTEM" as const, text: "Hi." }],
      options: [{ text: "A" }, { text: "B" }],
    });

    const mockStreamText = streamText as ReturnType<typeof vi.fn>;
    mockStreamText.mockReturnValue({
      response: Promise.resolve({ messages: [] }),
    });

    await autoPersist(sm, 1);

    const callArgs = mockStreamText.mock.calls[0][0];
    const userMessage = (callArgs.messages as Array<{ role: string; content: string }>).find(
      (m) => m.role === "user",
    );
    expect(userMessage!.content).toContain("(no tool calls)");
  });

  it("handles null dialogue params", async () => {
    sm.recordToolCall("generateDialogueStep");
    // dialogueValidated NOT called

    const mockStreamText = streamText as ReturnType<typeof vi.fn>;
    mockStreamText.mockReturnValue({
      response: Promise.resolve({ messages: [] }),
    });

    await autoPersist(sm, 1);

    const callArgs = mockStreamText.mock.calls[0][0];
    const userMessage = (callArgs.messages as Array<{ role: string; content: string }>).find(
      (m) => m.role === "user",
    );
    expect(userMessage!.content).toContain("(no dialogue output)");
  });
});
