import { getEmbedder } from "@/server/memory/embedder";
import { NodeManager } from "@/server/nodeManager";
import { RelationshipManager } from "@/server/relationshipManager";
import { getReranker, applyRerank } from "@/server/memory/reranker";
import type { QdrantVectorClient } from "@/server/memory/qdrant";

export class MemorySearch {
  private readonly qdrant: QdrantVectorClient;

  constructor(_neo4j: unknown, qdrant: QdrantVectorClient) {
    this.qdrant = qdrant;
  }

  getParams(options?: { limit?: number; threshold?: number; rerank?: boolean }) {
    const { limit = 10, threshold, rerank } = options || {};

    const useRerank = rerank !== false && getReranker() !== null;
    const effectiveThreshold = threshold ?? (useRerank ? 0.4 : 0.7);
    const fetchLimit = useRerank ? Math.max(limit * 4, 40) : limit;

    return { useRerank, effectiveThreshold, limit, fetchLimit };
  }

  private buildFilter(type: string, kind: "node" | "relationship") {
    return {
      must: [
        { key: "node_type", match: { value: type } },
        { key: "kind", match: { value: kind } },
      ],
    };
  }

  async searchByLabel(
    label: string,
    query: string,
    options?: {
      limit?: number;
      threshold?: number;
      rerank?: boolean;
    },
  ): Promise<Array<Record<string, unknown> & { similarity: number; relevance?: number }>> {
    const { useRerank, effectiveThreshold, limit, fetchLimit } = this.getParams(options);

    const embedder = getEmbedder();
    const queryEmbedding = await embedder.embed(query);

    const results = await this.qdrant.searchVector(queryEmbedding, {
      filter: this.buildFilter(label, "node"),
      limit: fetchLimit,
      scoreThreshold: effectiveThreshold,
    });

    const items = results.map((r) => {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r.payload)) {
        if (!k.startsWith("_") && k !== "node_type" && k !== "kind" && k !== "object_id") {
          clean[k] = v;
        }
      }
      return { ...clean, similarity: r.score, text: r.payload.text as string };
    });

    if (useRerank && items.length > 0) {
      const nodeManager = NodeManager.getCachedInstance();
      const withText = items.map((item) => ({
        ...item,
        text: item.text || nodeManager.getEmbeddingText(label, item),
      }));
      const reranked = await applyRerank(query, withText, limit);
      return reranked.map((r) => {
        const { text: _, ...rest } = r as Record<string, unknown>;
        return rest as Record<string, unknown> & { similarity: number; relevance?: number };
      });
    }

    return items.map(({ text: _, ...rest }) => rest as Record<string, unknown> & { similarity: number });
  }

  async searchByRelationshipType(
    type: string,
    query: string,
    options?: {
      limit?: number;
      threshold?: number;
      rerank?: boolean;
    },
  ): Promise<Array<Record<string, unknown> & { similarity: number; relevance?: number }>> {
    const { useRerank, effectiveThreshold, limit, fetchLimit } = this.getParams(options);

    const embedder = getEmbedder();
    const queryEmbedding = await embedder.embed(query);

    const results = await this.qdrant.searchVector(queryEmbedding, {
      filter: this.buildFilter(type, "relationship"),
      limit: fetchLimit,
      scoreThreshold: effectiveThreshold,
    });

    const items = results.map((r) => {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r.payload)) {
        if (!k.startsWith("_") && k !== "node_type" && k !== "kind" && k !== "object_id") {
          clean[k] = v;
        }
      }
      return { ...clean, similarity: r.score, text: r.payload.text as string };
    });

    if (useRerank && items.length > 0) {
      const relManager = RelationshipManager.getCachedInstance();
      const withText = items.map((item) => ({
        ...item,
        text: item.text || relManager.getEmbeddingText(type, item),
      }));
      const reranked = await applyRerank(query, withText, limit);
      return reranked.map((r) => {
        const { text: _, ...rest } = r as Record<string, unknown>;
        return rest as Record<string, unknown> & { similarity: number; relevance?: number };
      });
    }

    return items.map(({ text: _, ...rest }) => rest as Record<string, unknown> & { similarity: number });
  }
}
