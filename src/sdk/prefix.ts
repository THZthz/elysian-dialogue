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
    return [
      { role: "system", content: this.system },
      ...this.fewShots.map((m) => ({ ...m })),
    ];
  }

  tools(): readonly ToolSpec[] {
    if (this._frozenToolsCache) return this._frozenToolsCache;
    const frozen = Object.freeze(
      this._toolSpecs.map(
        (t) => Object.freeze({ ...t, function: { ...t.function } }) as ToolSpec,
      ),
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
