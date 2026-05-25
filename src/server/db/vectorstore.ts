
import Database from "better-sqlite3";
import type { SparseVector } from "@/server/search/sparseEncoder";

// DESIGN NOTE: Brute-force cosine similarity over all filtered vectors. At Chorus's
// LLM-scale (<10K vectors), this is faster than a network round-trip to Qdrant.

function float32ToBlob(arr: Float32Array): Buffer {
  const byteOffset = arr.byteOffset;
  const byteLength = arr.byteLength;
  return Buffer.from(arr.buffer.slice(byteOffset, byteOffset + byteLength));
}

function blobToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

export interface StoredVector {
  pointId: string;
  nameVec: Float32Array;
  contentVec: Float32Array;
  sparseVec: SparseVector;
  payload: Record<string, unknown>;
}

export class VectorStore {
  private db: Database.Database | null = null;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  init(): void {
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        point_id    TEXT PRIMARY KEY,
        node_type   TEXT NOT NULL,
        kind        TEXT NOT NULL,
        name_vec    BLOB NOT NULL,
        content_vec BLOB NOT NULL,
        sparse_vec  TEXT NOT NULL,
        payload     TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vectors_filter ON vectors(node_type, kind);
    `);
  }

  upsert(
    pointId: string,
    nodeType: string,
    kind: string,
    nameVec: Float32Array,
    contentVec: Float32Array,
    sparseVec: SparseVector,
    payload: Record<string, unknown>,
  ): void {
    if (!this.db) throw new Error("VectorStore not initialized");
    this.db.prepare(
      `INSERT OR REPLACE INTO vectors (point_id, node_type, kind, name_vec, content_vec, sparse_vec, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      pointId,
      nodeType,
      kind,
      float32ToBlob(nameVec),
      float32ToBlob(contentVec),
      JSON.stringify(sparseVec),
      JSON.stringify(payload),
      new Date().toISOString(),
    );
  }

  delete(pointId: string): void {
    if (!this.db) throw new Error("VectorStore not initialized");
    this.db.prepare("DELETE FROM vectors WHERE point_id = ?").run(pointId);
  }

  deleteByFilter(nodeType: string, kind: string): void {
    if (!this.db) throw new Error("VectorStore not initialized");
    this.db.prepare("DELETE FROM vectors WHERE node_type = ? AND kind = ?").run(nodeType, kind);
  }

  getAllByFilter(nodeType: string, kind: string): StoredVector[] {
    if (!this.db) throw new Error("VectorStore not initialized");
    const rows = this.db.prepare(
      "SELECT point_id, name_vec, content_vec, sparse_vec, payload FROM vectors WHERE node_type = ? AND kind = ?",
    ).all(nodeType, kind) as Array<{
      point_id: string;
      name_vec: Buffer;
      content_vec: Buffer;
      sparse_vec: string;
      payload: string;
    }>;
    return rows.map((r) => ({
      pointId: r.point_id,
      nameVec: blobToFloat32(r.name_vec),
      contentVec: blobToFloat32(r.content_vec),
      sparseVec: JSON.parse(r.sparse_vec) as SparseVector,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  }

  clear(): void {
    if (!this.db) throw new Error("VectorStore not initialized");
    this.db.exec("DELETE FROM vectors");
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
