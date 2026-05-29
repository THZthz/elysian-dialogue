import type { ChatMessage, SessionPersistence } from "./types.js";

const DEFAULT_WINDOW = 200;

export class AppendOnlyLog {
  private _entries: ChatMessage[] = [];
  private _windowSize: number;
  private _persistence: SessionPersistence | null;
  private _totalLength: number;
  private _version = 0;

  constructor(opts?: { windowSize?: number; persistence?: SessionPersistence }) {
    this._windowSize = opts?.windowSize ?? DEFAULT_WINDOW;
    this._persistence = opts?.persistence ?? null;
    this._totalLength = 0;
    // Hydrate from persistence on construction
    if (this._persistence) {
      const loaded = this._persistence.load();
      if (loaded.length > 0) {
        this._entries = loaded.slice(-this._windowSize);
        this._totalLength = loaded.length;
      }
    }
  }

  append(message: ChatMessage): void {
    if (!message || typeof message !== "object" || !("role" in message)) {
      throw new Error(`invalid log entry: ${JSON.stringify(message)}`);
    }
    this._entries.push(message);
    this._totalLength++;
    if (this._entries.length > this._windowSize) {
      this._entries.shift();
    }
    this._version++;
    if (this._persistence) {
      try { this._persistence.append(message); } catch { /* best-effort */ }
    }
  }

  compactInPlace(replacement: ChatMessage[]): void {
    this._entries = [...replacement];
    this._totalLength = replacement.length;
    this._version++;
    if (this._persistence) {
      try { this._persistence.rewrite(replacement); } catch { /* best-effort */ }
    }
  }

  toFullHistory(): ChatMessage[] {
    return this._entries.map((e) => ({ ...e }));
  }

  get entries(): readonly ChatMessage[] { return this._entries; }
  get length(): number { return this._entries.length; }
  get totalLength(): number { return this._totalLength; }
  get version(): number { return this._version; }
  get persistence(): SessionPersistence | null { return this._persistence; }
}
