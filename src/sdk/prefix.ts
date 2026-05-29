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

// src/sdk/prefix.ts
import { createHash } from "node:crypto";
import type { ChatMessage, ToolSpec } from "./types.js";

export interface ImmutablePrefixOptions {
  system: string;
  toolSpecs?: readonly ToolSpec[];
  fewShots?: readonly ChatMessage[];
}

export class ImmutablePrefix {
  system: string;
  private _toolSpecs: ToolSpec[];
  readonly fewShots: readonly ChatMessage[];
  private _fingerprintCache: string | null = null;
  private _frozenToolsCache: ToolSpec[] | null = null;

  constructor(opts: ImmutablePrefixOptions) {
    this.system = opts.system;
    this._toolSpecs = [...(opts.toolSpecs ?? [])];
    this.fewShots = Object.freeze([...(opts.fewShots ?? [])]);
  }

  get toolSpecs(): readonly ToolSpec[] {
    return this._toolSpecs;
  }

  replaceSystem(s: string): boolean {
    if (this.system === s) return false;
    this.system = s;
    this.invalidatePrefixCaches();
    return true;
  }

  toMessages(): ChatMessage[] {
    return [{ role: "system", content: this.system }, ...this.fewShots.map((m) => ({ ...m }))];
  }

  tools(): readonly ToolSpec[] {
    if (this._frozenToolsCache) return this._frozenToolsCache;
    const frozen = Object.freeze(
      this._toolSpecs.map((t) => Object.freeze({ ...t, function: { ...t.function } }) as ToolSpec),
    );
    this._frozenToolsCache = frozen as unknown as ToolSpec[];
    return this._frozenToolsCache;
  }

  addTool(spec: ToolSpec): boolean {
    const name = spec.function?.name;
    if (!name) return false;
    if (this._toolSpecs.some((t) => t.function?.name === name)) return false;
    this._toolSpecs.push(spec);
    this.invalidatePrefixCaches();
    this._frozenToolsCache = null;
    return true;
  }

  removeTool(name: string): boolean {
    const idx = this._toolSpecs.findIndex((t) => t.function?.name === name);
    if (idx < 0) return false;
    this._toolSpecs.splice(idx, 1);
    this.invalidatePrefixCaches();
    this._frozenToolsCache = null;
    return true;
  }

  get fingerprint(): string {
    if (this._fingerprintCache !== null) return this._fingerprintCache;
    this._fingerprintCache = this.computeFingerprint();
    return this._fingerprintCache;
  }

  private invalidatePrefixCaches(): void {
    this._fingerprintCache = null;
  }

  private computeFingerprint(): string {
    const blob = JSON.stringify({
      system: this.system,
      tools: this._toolSpecs,
      shots: this.fewShots,
    });
    return createHash("sha256").update(blob).digest("hex").slice(0, 16);
  }
}
