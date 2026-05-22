import { getEmbedder } from "@/server/memory/embedder";
import { NodeManager } from "@/server/nodeManager";
import { RelationshipManager } from "@/server/relationshipManager";
import { getReranker, applyRerank } from "@/server/memory/reranker";
import { encodeSparse } from "@/server/memory/sparseEncoder";
import type { QdrantVectorClient, MultiSearchResult } from "@/server/memory/qdrant";

const RRF_K = 60;

function rrfFuse(
  multi: MultiSearchResult,
  limit: number,
): Array<{ payload: Record<string, unknown>; rrfScore: number; text: string }> {
  const allIds = new Set<string>();
  for (const id of multi.nameResults.keys()) allIds.add(id);
  for (const id of multi.contentResults.keys()) allIds.add(id);
  for (const id of multi.sparseResults.keys()) allIds.add(id);

  const scored: Array<{ payload: Record<string, unknown>; rrfScore: number; text: string }> = [];

  for (const id of allIds) {
    const nameRank = [...multi.nameResults.keys()].indexOf(id);
    const contentRank = [...multi.contentResults.keys()].indexOf(id);
    const sparseRank = [...multi.sparseResults.keys()].indexOf(id);

    let rrfScore = 0;
    if (nameRank >= 0) rrfScore += 1 / (RRF_K + nameRank + 1);
    if (contentRank >= 0) rrfScore += 1 / (RRF_K + contentRank + 1);
    if (sparseRank >= 0) rrfScore += 1 / (RRF_K + sparseRank + 1);

    const r = multi.contentResults.get(id)
      ?? multi.nameResults.get(id)
      ?? multi.sparseResults.get(id);

    scored.push({
      payload: r!.payload,
      rrfScore,
      text: (r!.payload.text as string) || "",
    });
  }

  scored.sort((a, b) => b.rrfScore - a.rrfScore);
  return scored.slice(0, limit);
}

export class MemorySearch {
  private readonly qdrant: QdrantVectorClient;

  constructor(_neo4j: unknown, qdrant: QdrantVectorClient) {
    this.qdrant = qdrant;
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
      rerank?: boolean;
    },
  ): Promise<Array<Record<string, unknown> & { similarity: number; relevance?: number }>> {
    const { limit = 10, rerank = true } = options || {};
    const useRerank = rerank !== false && getReranker() !== null;
    const fetchLimit = useRerank ? Math.max(limit * 4, 40) : limit;

    const embedder = getEmbedder();
    const filter = this.buildFilter(label, "node");

    const nodeManager = NodeManager.getCachedInstance();
    const nameText = `[${label}] ${query}`;

    const [nameVec, contentVec, sparseVec] = await Promise.all([
      embedder.embed(nameText),
      embedder.embed(query),
      Promise.resolve(encodeSparse(query)),
    ]);

    const multi = await this.qdrant.searchMultiVector(
      nameVec,
      contentVec,
      sparseVec,
      filter,
      fetchLimit,
    );

    const fused = rrfFuse(multi, fetchLimit);

    if (useRerank && fused.length > 0) {
      const withText = fused.map((item) => ({
        ...item.payload,
        text: item.text || nodeManager.getEmbeddingText(label, item.payload),
      }));
      const reranked = await applyRerank(query, withText, limit);
      return reranked.map((r) => {
        const { text: _, ...rest } = r as Record<string, unknown>;
        return rest as Record<string, unknown> & { similarity: number; relevance?: number };
      });
    }

    return fused.map((item) => ({
      ...item.payload,
      similarity: item.rrfScore,
    })) as Array<Record<string, unknown> & { similarity: number }>;
  }

  async searchByRelationshipType(
    type: string,
    query: string,
    options?: {
      limit?: number;
      rerank?: boolean;
    },
  ): Promise<Array<Record<string, unknown> & { similarity: number; relevance?: number }>> {
    const { limit = 10, rerank = true } = options || {};
    const useRerank = rerank !== false && getReranker() !== null;
    const fetchLimit = useRerank ? Math.max(limit * 4, 40) : limit;

    const embedder = getEmbedder();
    const filter = this.buildFilter(type, "relationship");

    const nameText = `[${type}] ${query}`;

    const [nameVec, contentVec, sparseVec] = await Promise.all([
      embedder.embed(nameText),
      embedder.embed(query),
      Promise.resolve(encodeSparse(query)),
    ]);

    const multi = await this.qdrant.searchMultiVector(
      nameVec,
      contentVec,
      sparseVec,
      filter,
      fetchLimit,
    );

    const fused = rrfFuse(multi, fetchLimit);

    if (useRerank && fused.length > 0) {
      const relManager = RelationshipManager.getCachedInstance();
      const withText = fused.map((item) => ({
        ...item.payload,
        text: item.text || relManager.getEmbeddingText(type, item.payload),
      }));
      const reranked = await applyRerank(query, withText, limit);
      return reranked.map((r) => {
        const { text: _, ...rest } = r as Record<string, unknown>;
        return rest as Record<string, unknown> & { similarity: number; relevance?: number };
      });
    }

    return fused.map((item) => ({
      ...item.payload,
      similarity: item.rrfScore,
    })) as Array<Record<string, unknown> & { similarity: number }>;
  }
}
