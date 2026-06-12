import { describe, it, expect, beforeEach, vi } from "vitest";
import { Logger, logger, type LogEntry } from "@/server/logger";

describe("Logger", () => {
  let instance: Logger;

  beforeEach(() => {
    instance = new Logger(10);
  });

  it("buffers entries up to max size", () => {
    for (let i = 0; i < 15; i++) {
      instance.info(`msg ${i}`);
    }
    const buf = instance.getBuffer();
    expect(buf.length).toBe(10);
    expect(buf[0].message).toBe("msg 5");
    expect(buf[9].message).toBe("msg 14");
  });

  it("emits to subscribers on info", () => {
    const fn = vi.fn();
    instance.subscribe(fn);
    instance.info("hello");
    expect(fn).toHaveBeenCalledTimes(1);
    const entry: LogEntry = fn.mock.calls[0][0];
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("hello");
    expect(typeof entry.timestamp).toBe("number");
  });

  it("emits to subscribers on error", () => {
    const fn = vi.fn();
    instance.subscribe(fn);
    instance.error("boom");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].level).toBe("error");
  });

  it("emits to subscribers on warn", () => {
    const fn = vi.fn();
    instance.subscribe(fn);
    instance.warn("hmm");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].level).toBe("warn");
  });

  it("unsubscribe removes listener", () => {
    const fn = vi.fn();
    const unsub = instance.subscribe(fn);
    unsub();
    instance.info("hello");
    expect(fn).not.toHaveBeenCalled();
  });

  it("joins multiple args with space", () => {
    const fn = vi.fn();
    instance.subscribe(fn);
    instance.info("a", "b", 123);
    expect(fn.mock.calls[0][0].message).toBe("a b 123");
  });

  it("getBuffer returns snapshot (not live reference)", () => {
    instance.info("one");
    const buf = instance.getBuffer();
    instance.info("two");
    expect(buf.length).toBe(1);
  });

  it("singleton is a Logger instance", () => {
    expect(logger).toBeInstanceOf(Logger);
  });
});
