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

import { getEmbedder } from "@/server/memory/embedder";
import { v5 as uuidv5 } from "uuid";
import type { SparseVector } from "@/server/memory/sparseEncoder";

const COLLECTION_NAME = "chorus_embeddings";
const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // DNS namespace

// WARNING: We should not use the official library @qdrant/js-client-rest since undici is not compatible with our env (rather new node.js)!

/** Convert a deterministic string key to a UUID v5 for use as Qdrant point ID. */
function toPointId(key: string): string {
  return uuidv5(key, UUID_NAMESPACE);
}

export interface QdrantSearchOptions {
  filter: {
    must: Array<{ key: string; match: { value: string } }>;
  };
  limit: number;
  scoreThreshold?: number;
}

export interface QdrantSearchResult {
  id: string | number;
  score: number;
  payload: Record<string, unknown>;
}

export interface PointVectors {
  nameVec?: number[];
  contentVec?: number[];
  sparseVec?: SparseVector;
}

class QdrantVectorClient {
  private readonly baseUrl: string;
  private readonly dimensions: number;
  private readonly ef: number;

  private constructor(url: string) {
    this.baseUrl = url.replace(/\/$/, "");
    this.dimensions = getEmbedder().dimensions;
    this.ef = parseInt(process.env.QDRANT_EF || "128", 10);
  }

  private async fetchApi<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const { method = "GET", body } = options;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Qdrant ${method} ${path} returned ${res.status}: ${err.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  private async fetchApiOk<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T | null> {
    const { method = "GET", body } = options;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return (await res.json()) as T;
    // 404 on GET means "not found" — return null.
    if (method === "GET" && res.status === 404) return null;
    const err = await res.text();
    throw new Error(`Qdrant ${method} ${path} returned ${res.status}: ${err.slice(0, 300)}`);
  }

  async ensureCollection(): Promise<void> {
    const info = await this.fetchApiOk<{
      result: { status?: string; config?: { params?: { vectors?: Record<string, unknown> } } };
    }>(`/collections/${COLLECTION_NAME}`);
    if (info) {
      if (info.result?.status === "green" || info.result?.status === "yellow") {
        const vectors = info.result?.config?.params?.vectors;
        if (vectors && typeof vectors === "object") {
          const nameVec = vectors["name_vec"] as { size?: number } | undefined;
          const existingSize = nameVec?.size ?? (vectors as { size?: number }).size;
          if (existingSize !== undefined && existingSize !== this.dimensions) {
            console.warn(
              `[qdrant] dimension mismatch: collection has ${existingSize}, embedder has ${this.dimensions}. Recreate collection or update EMBEDDING_DIMENSIONS.`,
            );
          }
        }
        console.log(`[qdrant] collection ${COLLECTION_NAME} ready`);
        return;
      }
      console.warn(
        `[qdrant] collection ${COLLECTION_NAME} status is "${String(info.result?.status)}", proceeding`,
      );
      return;
    }

    await this.fetchApi(`/collections/${COLLECTION_NAME}`, {
      method: "PUT",
      body: {
        vectors: {
          name_vec: { size: this.dimensions, distance: "Cosine" },
          content_vec: { size: this.dimensions, distance: "Cosine" },
        },
        sparse_vectors: {
          sparse_vec: { modifier: "idf" },
        },
        hnsw_config: {
          m: 16,
          ef_construct: 100,
          on_disk: true,
        },
        optimizers_config: {
          default_segment_number: 2,
        },
        quantization_config: {
          scalar: { type: "int8", quantile: 0.99, always_ram: true },
        },
        on_disk_payload: true,
      },
    });

    // Create payload indexes
    for (const field of ["node_type", "kind", "object_id"]) {
      await this.fetchApi(`/collections/${COLLECTION_NAME}/index`, {
        method: "PUT",
        body: { field_name: field, field_schema: "keyword" },
      });
    }

    console.log(
      `[qdrant] collection ${COLLECTION_NAME} created (${this.dimensions}d Cosine with named vectors + sparse)`,
    );
  }

  async upsert(
    key: string,
    vectors: PointVectors,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const id = toPointId(key);
    const vector: Record<string, unknown> = {};
    if (vectors.nameVec) vector["name_vec"] = vectors.nameVec;
    if (vectors.contentVec) vector["content_vec"] = vectors.contentVec;
    if (vectors.sparseVec) vector["sparse_vec"] = vectors.sparseVec;

    await this.fetchApi(`/collections/${COLLECTION_NAME}/points`, {
      method: "PUT",
      body: {
        points: [{ id, vector, payload }],
        wait: false,
      },
    });
  }

  async deletePoint(key: string): Promise<void> {
    const id = toPointId(key);
    await this.fetchApi(`/collections/${COLLECTION_NAME}/points/delete`, {
      method: "POST",
      body: { points: [id], wait: false },
    });
  }

  /**
   * Hybrid search using Qdrant's native /points/query endpoint with
   * server-side RRF fusion across name_vec, content_vec, and sparse_vec.
   */
  async queryPoints(
    nameVec: number[] | null,
    contentVec: number[] | null,
    sparseVec: SparseVector,
    filter: QdrantSearchOptions["filter"],
    limit: number,
    prefetchLimit?: number,
  ): Promise<QdrantSearchResult[]> {
    const prefetch: Array<Record<string, unknown>> = [];
    const pl = prefetchLimit ?? limit;

    if (nameVec) {
      prefetch.push({
        query: nameVec,
        using: "name_vec",
        limit: pl,
        filter,
        params: { ef: this.ef },
      });
    }

    if (contentVec) {
      prefetch.push({
        query: contentVec,
        using: "content_vec",
        limit: pl,
        filter,
        params: { ef: this.ef },
      });
    }

    prefetch.push({
      query: sparseVec,
      using: "sparse_vec",
      limit: pl,
      filter,
    });

    const res = await this.fetchApi<{
      result: {
        points?: Array<{ id: string | number; score: number; payload?: Record<string, unknown> }>;
      };
    }>(`/collections/${COLLECTION_NAME}/points/query`, {
      method: "POST",
      body: {
        prefetch,
        query: { fusion: "rrf" },
        limit,
        with_payload: true,
        with_vector: false,
      },
    });

    const points = res.result?.points ?? [];
    return points.map((p) => ({
      id: p.id,
      score: p.score,
      payload: p.payload ?? {},
    }));
  }

  async deleteByFilter(filter: QdrantSearchOptions["filter"]): Promise<void> {
    await this.fetchApi(`/collections/${COLLECTION_NAME}/points/delete`, {
      method: "POST",
      body: { filter, wait: false },
    });
  }

  async clearAll(): Promise<void> {
    // Delete all points via empty filter instead of dropping the collection.
    // Collection deletion requires filesystem cleanup which can fail on
    // Docker bind mounts (Permission denied on Windows).
    try {
      await this.fetchApi(`/collections/${COLLECTION_NAME}/points/delete`, {
        method: "POST",
        body: { filter: {}, wait: true },
      });
      console.log("[qdrant] all points deleted for reset");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("404") && !msg.includes("Not found")) {
        console.warn("[qdrant] clearAll failed:", msg);
      }
    }
  }

  async createSnapshot(): Promise<{ name: string; size: number }> {
    const res = await this.fetchApi<{
      result: { name: string; creation_time: string; size: number };
    }>(`/collections/${COLLECTION_NAME}/snapshots?wait=true`, {
      method: "POST",
    });
    return { name: res.result.name, size: res.result.size };
  }

  async downloadSnapshot(snapshotName: string): Promise<ArrayBuffer> {
    const res = await fetch(
      `${this.baseUrl}/collections/${COLLECTION_NAME}/snapshots/${encodeURIComponent(snapshotName)}`,
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(
        `Qdrant GET snapshot ${snapshotName} returned ${res.status}: ${err.slice(0, 300)}`,
      );
    }
    return res.arrayBuffer();
  }

  async uploadSnapshot(filePath: string): Promise<void> {
    const fs = await import("fs");
    const buf = fs.readFileSync(filePath);
    const form = new FormData();
    form.append("snapshot", new Blob([buf]));

    const res = await fetch(
      `${this.baseUrl}/collections/${COLLECTION_NAME}/snapshots/upload?priority=snapshot`,
      { method: "POST", body: form },
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Qdrant POST snapshot/upload returned ${res.status}: ${err.slice(0, 300)}`);
    }
  }

  async deleteSnapshot(snapshotName: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/collections/${COLLECTION_NAME}/snapshots/${encodeURIComponent(snapshotName)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      const err = await res.text();
      if (!err.includes("not found") && !err.includes("404")) {
        console.warn(`[qdrant] delete snapshot ${snapshotName} failed: ${err.slice(0, 200)}`);
      }
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.fetchApi("/collections");
      return true;
    } catch {
      return false;
    }
  }

  // ── Singleton ──

  private static instance: QdrantVectorClient | null = null;

  static getInstance(): QdrantVectorClient {
    if (!QdrantVectorClient.instance) {
      const url = process.env.QDRANT_URL || "http://localhost:6333";
      QdrantVectorClient.instance = new QdrantVectorClient(url);
      console.log(`[qdrant] client created for ${url}`);
    }
    return QdrantVectorClient.instance;
  }

  static resetInstance(): void {
    QdrantVectorClient.instance = null;
  }
}

export { QdrantVectorClient };

export function getQdrantClient(): QdrantVectorClient {
  return QdrantVectorClient.getInstance();
}
