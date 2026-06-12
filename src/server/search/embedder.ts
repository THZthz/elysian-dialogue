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

import { logger } from "@/server/logger";

export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
}

export class LlamaEmbedder implements Embedder {
  readonly dimensions: number;
  private readonly url: string;

  constructor(url: string, dimensions: number) {
    this.url = url;
    this.dimensions = dimensions;
  }

  private async post(body: unknown): Promise<number[][]> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Embedder returned ${res.status}: ${err.slice(0, 300)}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    if (json.data && Array.isArray(json.data)) {
      return (json.data as Array<{ embedding?: number[] }>).map((d) => d.embedding || []);
    }
    throw new Error(`Embedder unexpected response: ${JSON.stringify(json).slice(0, 300)}`);
  }

  async embed(text: string): Promise<number[]> {
    const embeddings = await this.post({ model: "embedding", input: text });
    return embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.post({ model: "embedding", input: texts });
  }
}

export async function checkEmbedderHealth(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "embedding", input: "health" }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const json = (await res.json()) as Record<string, unknown>;
    return (
      json.data !== undefined &&
      Array.isArray(json.data) &&
      (json.data as Array<unknown>).length > 0
    );
  } catch {
    return false;
  }
}

class StubEmbedder implements Embedder {
  readonly dimensions = 4;
  async embed(_text: string): Promise<number[]> {
    return [0.1, 0.2, 0.3, 0.4];
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
  }
}

let embedder: Embedder | null = null;

export function setEmbedder(e: Embedder): void {
  embedder = e;
}

export function getEmbedder(): Embedder {
  if (embedder) return embedder;

  // initEmbedder() should be called during startup. If not, fall back to stub
  // so the server can function (with degraded search) without llama-server.
  logger.warn("[embedder] not initialized — using StubEmbedder (4d)");
  embedder = new StubEmbedder();
  return embedder;
}

export async function initEmbedder(): Promise<void> {
  const url = process.env.LLAMA_EMBED_URL || "http://localhost:8080/v1/embeddings";
  const dims = parseInt(process.env.EMBEDDING_DIMENSIONS || "1024", 10);

  const healthy = await checkEmbedderHealth(url);
  if (healthy) {
    embedder = new LlamaEmbedder(url, dims);
    logger.info(`[embedder] ${dims}d at ${url}`);
  } else {
    embedder = new StubEmbedder();
    logger.info("[embedder] server unavailable, using StubEmbedder (4d)");
  }
}
