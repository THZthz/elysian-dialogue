// tests/unit/sdk/prefix.test.ts
import { describe, it, expect } from "vitest";
import { ImmutablePrefix } from "@/sdk/prefix.js";
import type { ToolSpec, ChatMessage } from "@/sdk/types.js";

const systemPrompt = "You are a helpful assistant.";
const toolSpecs: ToolSpec[] = [
  { type: "function", function: { name: "search", description: "Search", parameters: {} } },
];
const fewShots: ChatMessage[] = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
];

describe("ImmutablePrefix", () => {
  it("constructs with all fields", () => {
    const prefix = new ImmutablePrefix({ system: systemPrompt, toolSpecs, fewShots });
    expect(prefix.system).toBe(systemPrompt);
    expect(prefix.toolSpecs).toHaveLength(1);
    expect(prefix.fewShots).toHaveLength(2);
  });

  it("constructs with empty toolSpecs and fewShots", () => {
    const prefix = new ImmutablePrefix({ system: systemPrompt });
    expect(prefix.toolSpecs).toHaveLength(0);
    expect(prefix.fewShots).toHaveLength(0);
  });

  it("toMessages returns [system, ...fewShots]", () => {
    const prefix = new ImmutablePrefix({ system: systemPrompt, fewShots });
    const msgs = prefix.toMessages();
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[1]!.role).toBe("user");
    expect(msgs[2]!.role).toBe("assistant");
  });

  it("tools() returns frozen snapshot", () => {
    const prefix = new ImmutablePrefix({ system: systemPrompt, toolSpecs });
    const frozen = prefix.tools();
    expect(frozen).toHaveLength(1);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(prefix.tools()).toBe(frozen);
  });

  it("fingerprint is stable", () => {
    const prefix = new ImmutablePrefix({ system: systemPrompt, toolSpecs });
    const fp1 = prefix.fingerprint;
    const fp2 = prefix.fingerprint;
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(16);
  });

  it("fingerprint changes when system changes", () => {
    const prefix = new ImmutablePrefix({ system: systemPrompt, toolSpecs });
    const fp1 = prefix.fingerprint;
    prefix.replaceSystem("Different system prompt.");
    expect(prefix.fingerprint).not.toBe(fp1);
  });

  it("replaceSystem returns false when string unchanged", () => {
    const prefix = new ImmutablePrefix({ system: systemPrompt });
    expect(prefix.replaceSystem(systemPrompt)).toBe(false);
    expect(prefix.replaceSystem("New prompt")).toBe(true);
  });

  it("fingerprint changes when tool is added", () => {
    const prefix = new ImmutablePrefix({ system: systemPrompt, toolSpecs });
    const fp1 = prefix.fingerprint;
    prefix.addTool({
      type: "function",
      function: { name: "delete", description: "Delete", parameters: {} },
    });
    expect(prefix.fingerprint).not.toBe(fp1);
  });

  it("addTool returns false for duplicate name", () => {
    const prefix = new ImmutablePrefix({ system: systemPrompt, toolSpecs });
    expect(
      prefix.addTool({
        type: "function",
        function: { name: "search", description: "Dup", parameters: {} },
      }),
    ).toBe(false);
  });

  it("fingerprint changes when tool is removed", () => {
    const prefix = new ImmutablePrefix({ system: systemPrompt, toolSpecs });
    const fp1 = prefix.fingerprint;
    prefix.removeTool("search");
    expect(prefix.fingerprint).not.toBe(fp1);
  });

  it("fingerprint is stable across turns (only log changes, not prefix)", () => {
    const prefix = new ImmutablePrefix({ system: systemPrompt, toolSpecs });
    const fp1 = prefix.fingerprint;
    const fp2 = prefix.fingerprint;
    expect(fp1).toBe(fp2);
  });
});
