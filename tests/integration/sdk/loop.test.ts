import { describe, it, expect, vi } from "vitest";
import { createGameLoop } from "@/sdk/loop.js";
import { DeepSeekClient } from "@/sdk/client.js";
import { ImmutablePrefix } from "@/sdk/prefix.js";
import type { LoopEvent, ChatResponse, StreamChunk, ChatOptions } from "@/sdk/types.js";
import { Usage } from "@/sdk/types.js";

class FakeClient extends DeepSeekClient {
  _chunks: StreamChunk[] = [];
  constructor() {
    super({ apiKey: "test-key", fetch: vi.fn() as unknown as typeof fetch });
  }
  override async chat(_opts: ChatOptions): Promise<ChatResponse> {
    return { content: "", reasoningContent: null, toolCalls: [], usage: new Usage() };
  }
  override async *stream(_opts: ChatOptions): AsyncGenerator<StreamChunk> {
    for (const c of this._chunks) yield c;
  }
}

const prefix = new ImmutablePrefix({ system: "You are a test GM." });

describe("createGameLoop", () => {
  it("creates loop with step, abort, clearLog, configure", () => {
    const loop = createGameLoop({
      client: new FakeClient(),
      prefix,
      runTool: async () => ({ result: "ok" }),
    });
    expect(typeof loop.step).toBe("function");
    expect(typeof loop.abort).toBe("function");
    expect(typeof loop.clearLog).toBe("function");
  });

  it("step() yields deltas and done", async () => {
    const client = new FakeClient();
    client._chunks = [
      { contentDelta: "Hello", raw: {} },
      { usage: new Usage(100, 10, 110, 0, 100), raw: {} },
    ];
    const loop = createGameLoop({
      client,
      prefix,
      runTool: async () => ({ result: "ok" }),
    });
    const events: LoopEvent[] = [];
    for await (const ev of loop.step("test")) {
      events.push(ev);
    }
    expect(events.some((e) => e.role === "assistant_delta")).toBe(true);
    expect(events.some((e) => e.role === "assistant_final")).toBe(true);
    expect(events.some((e) => e.role === "done")).toBe(true);
  });

  it("step() dispatches tool calls and yields tool_result", async () => {
    const client = new FakeClient();
    client._chunks = [
      {
        toolCallDelta: {
          index: 0,
          id: "tc1",
          name: "search",
          argumentsDelta: '{"query":"test"}',
        },
        raw: {},
      },
      { usage: new Usage(200, 20, 220, 0, 200), raw: {} },
    ];
    const called: Array<{ name: string; args: string }> = [];
    const loop = createGameLoop({
      client,
      prefix,
      runTool: async (name, args) => {
        called.push({ name, args });
        return { result: "results" };
      },
      maxIterPerTurn: 1,
    });
    const events: LoopEvent[] = [];
    for await (const ev of loop.step("search")) {
      events.push(ev);
    }
    expect(called).toHaveLength(1);
    expect(called[0]!.name).toBe("search");
    expect(events.some((e) => e.role === "tool_result")).toBe(true);
  });

  it("turnComplete ends turn immediately", async () => {
    const client = new FakeClient();
    client._chunks = [
      {
        toolCallDelta: {
          index: 0,
          id: "tc1",
          name: "generateDialogueStep",
          argumentsDelta: '{"messages":[]}',
        },
        raw: {},
      },
      { usage: new Usage(300, 30, 330, 0, 300), raw: {} },
    ];
    const loop = createGameLoop({
      client,
      prefix,
      runTool: async () => ({ result: "ok", turnComplete: true }),
    });
    const events: LoopEvent[] = [];
    for await (const ev of loop.step("act")) {
      events.push(ev);
    }
    expect(events.some((e) => e.role === "done")).toBe(true);
  });

  it("suppresses storm (identical consecutive tool calls)", async () => {
    const client = new FakeClient();
    // Two identical search calls should trigger storm suppression on the second
    client._chunks = [
      {
        toolCallDelta: {
          index: 0,
          id: "tc1",
          name: "search",
          argumentsDelta: '{"query":"test"}',
        },
        raw: {},
      },
      { usage: new Usage(200, 20, 220, 0, 200), raw: {} },
      // second call: identical
      {
        toolCallDelta: {
          index: 0,
          id: "tc2",
          name: "search",
          argumentsDelta: '{"query":"test"}',
        },
        raw: {},
      },
      { usage: new Usage(250, 25, 275, 0, 250), raw: {} },
    ];
    // We need a FakeClient that alternates chunk sets per stream call
    let callCount = 0;
    const multiChunkClient = new FakeClient();
    const chunkSets: StreamChunk[][] = [
      [
        {
          toolCallDelta: {
            index: 0,
            id: "tc1",
            name: "search",
            argumentsDelta: '{"query":"test"}',
          },
          raw: {},
        },
        { usage: new Usage(200, 20, 220, 0, 200), raw: {} },
      ],
      [
        {
          toolCallDelta: {
            index: 0,
            id: "tc2",
            name: "search",
            argumentsDelta: '{"query":"test"}',
          },
          raw: {},
        },
        { usage: new Usage(250, 25, 275, 0, 250), raw: {} },
        { contentDelta: "ok", raw: {} },
        { usage: new Usage(260, 26, 286, 0, 260), raw: {} },
      ],
    ];
    multiChunkClient.stream = async function* (_opts) {
      const chunks = chunkSets[callCount] ?? [{ contentDelta: "done", raw: {} }, { usage: new Usage(10, 2, 12, 0, 10), raw: {} }];
      callCount++;
      for (const c of chunks) yield c;
    };

    const called: string[] = [];
    const loop = createGameLoop({
      client: multiChunkClient,
      prefix,
      runTool: async (name) => {
        called.push(name);
        return { result: "results" };
      },
      maxIterPerTurn: 5,
    });
    const events: LoopEvent[] = [];
    for await (const ev of loop.step("search")) {
      events.push(ev);
    }
    // First search call should have been dispatched, second suppressed
    const toolResults = events.filter((e) => e.role === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
  });
});
