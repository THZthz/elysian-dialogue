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

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HybridSearcher } from "@/server/search/hybridSearch";
import { VectorStore } from "@/server/db/vectorstore";
import type { Embedder } from "@/server/search/embedder";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Stub embedder that returns pre-set vectors for known queries
class StubEmbedder implements Embedder {
  readonly dimensions = 4;
  async embed(text: string): Promise<number[]> {
    // Return orthogonal vectors so ranking is predictable
    if (text.includes("brave knight")) return [1.0, 0, 0, 0];
    if (text.includes("cowardly mage")) return [0, 1.0, 0, 0];
    if (text.includes("knight")) return [1.0, 0, 0, 0]; // query matches "brave knight" vector
    return [0.5, 0.5, 0.5, 0.5]; // neutral
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

let store: VectorStore;
let searcher: HybridSearcher;
let tmpDir: string;

describe("HybridSearcher", () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-test-hs-"));
    store = new VectorStore(path.join(tmpDir, "test.db"));
    store.init();
    searcher = new HybridSearcher(store, new StubEmbedder());
  });

  afterAll(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ranks results by vector similarity", async () => {
    // Alice = "brave knight" → embedding [1,0,0,0], Bob = "cowardly mage" → [0,1,0,0]
    // Query "knight" → [1,0,0,0] should match Alice better than Bob
    const vAlice = new Float32Array([1.0, 0, 0, 0]);
    const vBob = new Float32Array([0, 1.0, 0, 0]);
    store.upsert(
      "Character:Alice",
      "Character",
      "node",
      vAlice,
      vAlice,
      { indices: [], values: [] },
      { name: "Alice", text: "brave knight" },
    );
    store.upsert(
      "Character:Bob",
      "Character",
      "node",
      vBob,
      vBob,
      { indices: [], values: [] },
      { name: "Bob", text: "cowardly mage" },
    );

    const results = await searcher.search({
      domain: "Character",
      kind: "node",
      query: "knight",
      limit: 2,
      rerank: false,
    });
    expect(results.length).toBe(2);
    // Alice (brave knight) should rank first since query "knight" matches her vector
    expect(results[0].name).toBe("Alice");
    expect(results[1].name).toBe("Bob");
    // Alice's similarity should be higher
    expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
  });

  it("returns empty for unknown domain", async () => {
    const results = await searcher.search({
      domain: "NonExistent",
      kind: "node",
      query: "test",
      limit: 5,
      rerank: false,
    });
    expect(results).toHaveLength(0);
  });

  it("respects limit parameter", async () => {
    const v = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    for (const name of ["A", "B", "C", "D", "E"]) {
      store.upsert(
        `Character:${name}`,
        "Character",
        "node",
        v,
        v,
        { indices: [], values: [] },
        { name },
      );
    }
    const results = await searcher.search({
      domain: "Character",
      kind: "node",
      query: "test",
      limit: 3,
      rerank: false,
    });
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
