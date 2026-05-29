import { describe, it, expect, beforeEach } from "vitest";
import { AppendOnlyLog } from "@/sdk/log.js";
import type { ChatMessage } from "@/sdk/types.js";

describe("AppendOnlyLog", () => {
  let log: AppendOnlyLog;

  beforeEach(() => {
    log = new AppendOnlyLog();
  });

  it("starts empty", () => {
    expect(log.length).toBe(0);
    expect(log.toFullHistory()).toEqual([]);
  });

  it("appends messages", () => {
    log.append({ role: "user", content: "hello" });
    expect(log.length).toBe(1);
    expect(log.toFullHistory()).toEqual([{ role: "user", content: "hello" }]);
  });

  it("appends multiple messages", () => {
    log.append({ role: "user", content: "a" });
    log.append({ role: "assistant", content: "b" });
    log.append({ role: "user", content: "c" });
    expect(log.length).toBe(3);
    expect(log.toFullHistory()).toHaveLength(3);
  });

  it("version increments on append", () => {
    const v1 = log.version;
    log.append({ role: "user", content: "x" });
    expect(log.version).toBeGreaterThan(v1);
  });

  it("compactInPlace replaces all entries", () => {
    log.append({ role: "user", content: "old" });
    log.append({ role: "assistant", content: "old" });
    log.compactInPlace([{ role: "user", content: "new" }]);
    expect(log.length).toBe(1);
    expect(log.toFullHistory()[0]!.content).toBe("new");
  });

  it("version increments on compactInPlace", () => {
    log.append({ role: "user", content: "a" });
    const v1 = log.version;
    log.compactInPlace([{ role: "user", content: "b" }]);
    expect(log.version).toBeGreaterThan(v1);
  });

  it("freezes in-memory window at configured size", () => {
    const bigLog = new AppendOnlyLog({ windowSize: 3 });
    for (let i = 0; i < 10; i++) bigLog.append({ role: "user", content: `msg${i}` });
    expect(bigLog.length).toBe(3);
  });

  it("persists via SessionPersistence and loads on construction", () => {
    const persisted: ChatMessage[] = [{ role: "user", content: "preloaded" }];
    const persistence = {
      load: () => persisted,
      append: (m: ChatMessage) => {
        persisted.push(m);
      },
      rewrite: (ms: ChatMessage[]) => {
        persisted.length = 0;
        persisted.push(...ms);
      },
      archive: () => null,
      loadMeta: () => null,
      saveMeta: () => {},
    };
    const plog = new AppendOnlyLog({ persistence });
    // Should hydrate from persistence.load() on construction
    expect(plog.length).toBe(1);
    expect(plog.toFullHistory()[0]!.content).toBe("preloaded");
    // Appending persists
    plog.append({ role: "user", content: "hello" });
    expect(persisted).toHaveLength(2);
  });
});
