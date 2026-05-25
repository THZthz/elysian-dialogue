
import { VectorStore } from "@/server/db/vectorstore";
import type { Embedder } from "@/server/search/embedder";
import { encodeSparse, type SparseVector } from "@/server/search/sparseEncoder";
import { getReranker, applyRerank } from "@/server/search/reranker";

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function sparseDot(sparse: SparseVector, dense: Float32Array): number {
  let score = 0;
  for (let i = 0; i < sparse.indices.length; i++) {
    const idx = sparse.indices[i];
    if (idx < dense.length) {
      score += sparse.values[i] * dense[idx];
    }
  }
  return score;
}

function rrfFuse(rankedLists: number[][], k = 60): number[] {
  const scores = new Map<number, number>();
  for (const lane of rankedLists) {
    for (let rank = 0; rank < lane.length; rank++) {
      const id = lane[rank];
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
}

function stripHidden(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith("_")) {
      out[k] = v;
    }
  }
  return out;
}

export interface SearchResult {
  similarity: number;
  relevance?: number;
  [key: string]: unknown;
}

export class HybridSearcher {
  private readonly vectorStore: VectorStore;
  private readonly embedder: Embedder;

  constructor(vectorStore: VectorStore, embedder: Embedder) {
    this.vectorStore = vectorStore;
    this.embedder = embedder;
  }

  async search(params: {
    domain: string;
    kind: "node" | "relationship";
    query: string;
    limit?: number;
    rerank?: boolean;
  }): Promise<SearchResult[]> {
    const { domain, kind, query, limit = 10, rerank: useRerank = true } = params;
    const rerankerAvailable = useRerank && getReranker() !== null;
    const fetchLimit = rerankerAvailable ? Math.max(limit * 4, 40) : limit;

    const nameText = `[${domain}] ${query}`;
    const [nameVec, contentVec, sparseVec] = await Promise.all([
      this.embedder.embed(nameText),
      this.embedder.embed(query),
      Promise.resolve(encodeSparse(query)),
    ]);

    const nameVecFA = new Float32Array(nameVec);
    const contentVecFA = new Float32Array(contentVec);
    const candidates = this.vectorStore.getAllByFilter(domain, kind);

    const nameScores: Array<{ idx: number; score: number }> = [];
    const contentScores: Array<{ idx: number; score: number }> = [];
    const sparseScores: Array<{ idx: number; score: number }> = [];

    for (let i = 0; i < candidates.length; i++) {
      nameScores.push({ idx: i, score: cosineSim(nameVecFA, candidates[i].nameVec) });
      contentScores.push({ idx: i, score: cosineSim(contentVecFA, candidates[i].contentVec) });
      sparseScores.push({ idx: i, score: sparseDot(sparseVec, candidates[i].contentVec) });
    }

    const rankIndices = (scored: Array<{ idx: number; score: number }>) =>
      scored.sort((a, b) => b.score - a.score).map((s) => s.idx);

    const fusedOrder = rrfFuse([
      rankIndices(nameScores),
      rankIndices(contentScores),
      rankIndices(sparseScores),
    ]);

    const topCandidates = fusedOrder.slice(0, fetchLimit).map((idx) => {
      const c = candidates[idx];
      const clean = { ...stripHidden(c.payload), similarity: Math.max(nameScores[idx].score, contentScores[idx].score) } as Record<string, unknown>;
      return clean;
    });

    if (rerankerAvailable && topCandidates.length > 0) {
      const withText = topCandidates.map((item) => ({
        ...item,
        text: (item as Record<string, unknown>).text as string || (item as Record<string, unknown>).name as string || (item as Record<string, unknown>).content as string || "",
      }));
      const reranked = await applyRerank(query, withText, limit);
      return reranked.map((r) => {
        const { text: _, ...rest } = r as Record<string, unknown>;
        return rest as SearchResult;
      });
    }

    return topCandidates.map((item) => {
      const { text: _, ...rest } = item as Record<string, unknown>;
      return rest as SearchResult;
    });
  }
}
