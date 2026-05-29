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

import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatMessage, SessionMeta, SessionPersistence } from "./types.js";

const DEFAULT_WINDOW = 200;

export class AppendOnlyLog {
  private _entries: ChatMessage[] = [];
  private _windowSize: number;
  private _persistence: SessionPersistence | null;
  private _totalLength: number;
  private _version = 0;
  private _fullHistoryCache: { version: number; messages: ChatMessage[] } | null = null;

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
    this._fullHistoryCache = null;
    if (this._persistence) {
      try {
        this._persistence.append(message);
      } catch {
        /* best-effort */
      }
    }
  }

  compactInPlace(replacement: ChatMessage[]): void {
    this._entries = [...replacement];
    this._totalLength = replacement.length;
    this._version++;
    this._fullHistoryCache = null;
    if (this._persistence) {
      try {
        this._persistence.rewrite(replacement);
      } catch {
        /* best-effort */
      }
    }
  }

  toFullHistory(): ChatMessage[] {
    // Return cached result if the log version hasn't changed.
    if (this._fullHistoryCache && this._fullHistoryCache.version === this._version) {
      return this._fullHistoryCache.messages.map((e) => ({ ...e }));
    }
    let messages: ChatMessage[];
    // If persistence is available and the in-memory window doesn't cover
    // everything, try loading the full history from persistence.
    if (this._persistence && this._totalLength > this._entries.length) {
      try {
        const loaded = this._persistence.load();
        if (loaded.length > this._entries.length) {
          messages = loaded;
        } else {
          messages = this._entries;
        }
      } catch {
        messages = this._entries;
      }
    } else {
      messages = this._entries;
    }
    this._fullHistoryCache = { version: this._version, messages };
    return messages.map((e) => ({ ...e }));
  }

  get entries(): readonly ChatMessage[] {
    return this._entries;
  }
  get length(): number {
    return this._entries.length;
  }
  get totalLength(): number {
    return this._totalLength;
  }
  get version(): number {
    return this._version;
  }
  get persistence(): SessionPersistence | null {
    return this._persistence;
  }
}

export class JsonlPersistence implements SessionPersistence {
  private readonly filePath: string;
  private readonly metaPath: string;

  constructor(dir: string, sessionName: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, `${sessionName}.jsonl`);
    this.metaPath = path.join(dir, `${sessionName}.meta.json`);
  }

  load(): ChatMessage[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      return raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as ChatMessage);
    } catch {
      return [];
    }
  }

  append(message: ChatMessage): void {
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(message) + "\n");
    } catch {
      /* disk full */
    }
  }

  rewrite(messages: ChatMessage[]): void {
    try {
      fs.writeFileSync(this.filePath, messages.map((m) => JSON.stringify(m)).join("\n") + "\n");
    } catch {
      /* disk full */
    }
  }

  archive(): string | null {
    try {
      const archivePath = this.filePath + ".archived";
      if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, archivePath);
      this.saveMeta({
        totalCostUsd: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalCompletionTokens: 0,
        turnCount: 0,
        lastPromptTokens: 0,
      });
      return archivePath;
    } catch {
      return null;
    }
  }

  loadMeta(): SessionMeta | null {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath, "utf8")) as SessionMeta;
    } catch {
      return null;
    }
  }

  saveMeta(meta: SessionMeta): void {
    try {
      fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2));
    } catch {
      /* disk full */
    }
  }
}
