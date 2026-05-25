import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { HybridSearcher } from "@/server/search/hybridSearch";
import { VectorStore } from "@/server/db/vectorstore";
import type { Embedder } from "@/server/search/embedder";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

class StubEmbedder implements Embedder {
  readonly dimensions = 4;
  private counter = 0;
  async embed(_text: string): Promise<number[]> {
    this.counter++;
    return [0.1 * this.counter, 0.2, 0.3, 0.4];
  }
  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((_, i) => [0.1 * (i + 1), 0.2, 0.3, 0.4]);
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

  it("returns results for node search", async () => {
    const v1 = new Float32Array([0.9, 0.1, 0.1, 0.1]);
    const v2 = new Float32Array([0.1, 0.9, 0.1, 0.1]);
    store.upsert("Character:Alice", "Character", "node", v1, v1, { indices: [], values: [] }, { name: "Alice", text: "brave knight" });
    store.upsert("Character:Bob", "Character", "node", v2, v2, { indices: [], values: [] }, { name: "Bob", text: "cowardly mage" });

    const results = await searcher.search({ domain: "Character", kind: "node", query: "knight", limit: 2, rerank: false });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty("similarity");
    expect(results[0]).toHaveProperty("name");
  });

  it("returns empty array for unknown domain", async () => {
    const results = await searcher.search({ domain: "NonExistent", kind: "node", query: "test", limit: 5, rerank: false });
    expect(results).toHaveLength(0);
  });

  it("respects limit parameter", async () => {
    const v = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    for (const name of ["A", "B", "C", "D", "E"]) {
      store.upsert(`Character:${name}`, "Character", "node", v, v, { indices: [], values: [] }, { name });
    }
    const results = await searcher.search({ domain: "Character", kind: "node", query: "test", limit: 3, rerank: false });
    expect(results.length).toBeLessThanOrEqual(3);
  });
});
