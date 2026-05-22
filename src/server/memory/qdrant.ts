import { getEmbedder } from "@/server/memory/embedder";
import { v5 as uuidv5 } from "uuid";

const COLLECTION_NAME = "chorus_embeddings";
const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // DNS namespace

// WARNING: We shoudld not use the official library @qdrant/js-client-rest since undici is not compatible with our env (rather new node.js)!

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

class QdrantVectorClient {
  private readonly baseUrl: string;
  private readonly dimensions: number;

  private constructor(url: string) {
    this.baseUrl = url.replace(/\/$/, "");
    this.dimensions = getEmbedder().dimensions;
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
    const info = await this.fetchApiOk<{ result: { status?: string; config?: { params?: { vectors?: { size?: number } } } } }>(
      `/collections/${COLLECTION_NAME}`,
    );
    if (info) {
      if (info.result?.status === "green" || info.result?.status === "yellow") {
        const existingSize = info.result?.config?.params?.vectors?.size;
        if (existingSize !== undefined && existingSize !== this.dimensions) {
          console.warn(
            `[qdrant] dimension mismatch: collection has ${existingSize}, embedder has ${this.dimensions}. Recreate collection or update EMBEDDING_DIMENSIONS.`,
          );
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
        vectors: { size: this.dimensions, distance: "Cosine" },
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

    console.log(`[qdrant] collection ${COLLECTION_NAME} created (${this.dimensions}d Cosine)`);
  }

  async upsert(
    key: string,
    embedding: number[],
    payload: Record<string, unknown>,
  ): Promise<void> {
    const id = toPointId(key);
    await this.fetchApi(`/collections/${COLLECTION_NAME}/points`, {
      method: "PUT",
      body: {
        points: [{ id, vector: embedding, payload }],
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

  async searchVector(
    embedding: number[],
    options: { filter: QdrantSearchOptions["filter"]; limit: number; scoreThreshold?: number },
  ): Promise<QdrantSearchResult[]> {
    const body: Record<string, unknown> = {
      vector: embedding,
      filter: options.filter,
      limit: options.limit,
      with_payload: true,
      with_vector: false,
    };
    if (options.scoreThreshold) {
      body["score_threshold"] = options.scoreThreshold;
    }
    const res = await this.fetchApi<{ result: Array<{ id: string | number; score: number; payload?: Record<string, unknown> }> }>(
      `/collections/${COLLECTION_NAME}/points/search`,
      { method: "POST", body },
    );
    return (res.result || []).map((r) => ({
      id: r.id,
      score: r.score,
      payload: r.payload ?? {},
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
