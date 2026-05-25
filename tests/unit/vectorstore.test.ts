import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { VectorStore } from "@/server/db/vectorstore";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

let store: VectorStore;
let tmpDir: string;

describe("VectorStore", () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chorus-test-vs-"));
    store = new VectorStore(path.join(tmpDir, "test.db"));
    store.init();
  });

  afterAll(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("upserts and retrieves vectors", () => {
    const nameVec = new Float32Array([0.1, 0.2, 0.3]);
    const contentVec = new Float32Array([0.4, 0.5, 0.6]);
    const sparseVec = { indices: [0, 2], values: [1.0, 2.0] };

    store.upsert("Character:Alice", "Character", "node", nameVec, contentVec, sparseVec, { name: "Alice" });
    const results = store.getAllByFilter("Character", "node");
    expect(results).toHaveLength(1);
    expect(results[0].pointId).toBe("Character:Alice");
    expect(results[0].nameVec[0]).toBeCloseTo(0.1);
  });

  it("delete removes a single point", () => {
    const vec = new Float32Array([1.0, 0.0]);
    store.upsert("Note:Test", "Note", "node", vec, vec, { indices: [], values: [] }, { name: "Test" });
    expect(store.getAllByFilter("Note", "node")).toHaveLength(1);
    store.delete("Note:Test");
    expect(store.getAllByFilter("Note", "node")).toHaveLength(0);
  });

  it("deleteByFilter removes all matching points", () => {
    const vec = new Float32Array([1.0]);
    store.upsert("A:1", "A", "node", vec, vec, { indices: [], values: [] }, {});
    store.upsert("A:2", "A", "node", vec, vec, { indices: [], values: [] }, {});
    store.upsert("B:1", "B", "node", vec, vec, { indices: [], values: [] }, {});
    store.deleteByFilter("A", "node");
    expect(store.getAllByFilter("A", "node")).toHaveLength(0);
    expect(store.getAllByFilter("B", "node")).toHaveLength(1);
  });

  it("clear removes everything", () => {
    const vec = new Float32Array([1.0]);
    store.upsert("X:1", "X", "node", vec, vec, { indices: [], values: [] }, {});
    store.upsert("Y:1", "Y", "node", vec, vec, { indices: [], values: [] }, {});
    store.clear();
    expect(store.getAllByFilter("X", "node")).toHaveLength(0);
    expect(store.getAllByFilter("Y", "node")).toHaveLength(0);
  });

  it("upsert with same pointId replaces existing", () => {
    const v1 = new Float32Array([0.1, 0.2]);
    const v2 = new Float32Array([0.9, 0.8]);
    store.upsert("Character:Bob", "Character", "node", v1, v1, { indices: [], values: [] }, { name: "Bob", version: 1 });
    store.upsert("Character:Bob", "Character", "node", v2, v2, { indices: [], values: [] }, { name: "Bob", version: 2 });
    const results = store.getAllByFilter("Character", "node");
    expect(results).toHaveLength(1);
    expect(results[0].payload.version).toBe(2);
  });
});
