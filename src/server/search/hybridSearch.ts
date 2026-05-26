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

import { VectorStore, type StoredVector } from "@/server/db/vectorstore";
import type { Embedder } from "@/server/search/embedder";
import { getReranker, applyRerank } from "@/server/search/reranker";
import { BM25Scorer, tokenize } from "@/server/search/bm25";

function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

const INTERNAL_KEYS = new Set(["_uid", "node_type", "kind", "object_id"]);

function stripHidden(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith("_") && !INTERNAL_KEYS.has(k)) out[k] = v;
  }
  return out;
}

/** Concatenate name + text from a candidate payload for BM25 indexing. */
function candidateText(c: StoredVector): string {
  const p = c.payload;
  return [p.name, p.text, p.content]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(" ");
}

export interface SearchResult {
  similarity: number;
  relevance?: number;
  [key: string]: unknown;
}

/** Saturating normalization: maps unbounded BM25→[0,1). 3.0 = ~50%. */
const BM25_SAT = 3.0;

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

    // 1. Embed query (single dense vector)
    const contentVec = await this.embedder.embed(query);
    const contentVecFA = new Float32Array(contentVec);
    const queryTokens = tokenize(query);

    // 2. Load candidates
    const candidates = this.vectorStore.getAllByFilter(domain, kind);
    if (!candidates || candidates.length === 0) {
      return [];
    }

    // 3. Build BM25 scorer over candidate texts
    const bm25 = new BM25Scorer();
    bm25.indexDocuments(candidates.map((c) => ({ text: candidateText(c) })));

    // 4. Score each candidate: dense cosine + BM25
    const denseScores: Array<{ idx: number; score: number }> = [];
    const bm25Scores: Array<{ idx: number; score: number }> = [];

    for (let i = 0; i < candidates.length; i++) {
      const cVec = candidates[i].contentVec;
      denseScores.push({ idx: i, score: cVec ? cosineSim(contentVecFA, cVec) : 0 });
      bm25Scores.push({ idx: i, score: bm25.scoreDocument(queryTokens, i) });
    }

    // 5. Compute RRF scores and fuse (matching VectFox's proportional RRF decay)
    const rrfScores = new Map<number, number>();
    const denseRanks = [...denseScores].sort((a, b) => b.score - a.score);
    const bm25Ranks = [...bm25Scores].sort((a, b) => b.score - a.score);

    for (const lane of [denseRanks, bm25Ranks]) {
      for (let rank = 0; rank < lane.length; rank++) {
        const id = lane[rank].idx;
        rrfScores.set(id, (rrfScores.get(id) ?? 0) + 1 / (60 + rank + 1));
      }
    }

    const fusedOrder = [...rrfScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([idx]) => idx);

    const maxRawRrf = fusedOrder.length > 0 ? (rrfScores.get(fusedOrder[0]) ?? 0) : 0;

    // 6. Build results with post-RRF display scores (from VectFox hybrid-search.js)
    const topCandidates = fusedOrder.slice(0, fetchLimit).map((idx) => {
      const c = candidates[idx];
      const vectorScore = denseScores[idx].score;
      const rawBm25 = bm25Scores[idx].score;
      const normBm25 = rawBm25 / (rawBm25 + BM25_SAT);
      const rawRrf = rrfScores.get(idx) ?? 0;
      const rrfRankFactor = maxRawRrf > 0 ? rawRrf / maxRawRrf : 0;

      const hasVector = vectorScore > 0.01;
      const hasText = normBm25 > 0.01;
      let similarity: number;

      if (hasVector && hasText) {
        const combined = vectorScore * 0.55 + normBm25 * 0.45;
        const dualBonus = 1.0 + Math.min(vectorScore, normBm25) * 0.08;
        similarity = Math.min(1.0, combined * dualBonus * (0.95 + 0.05 * rrfRankFactor));
      } else if (hasVector) {
        similarity = vectorScore * 0.55 * (0.9 + 0.1 * rrfRankFactor);
      } else if (hasText) {
        similarity = normBm25 * 0.6 * (0.9 + 0.1 * rrfRankFactor);
      } else {
        similarity = rrfRankFactor * 0.25;
      }

      return {
        ...stripHidden(c.payload),
        similarity,
      } as unknown as Record<string, unknown>;
    });

    // 7. Optional cross-encoder reranker
    if (rerankerAvailable && topCandidates.length > 0) {
      const withText = topCandidates.map((item) => ({
        ...item,
        text:
          ((item as Record<string, unknown>).text as string) ||
          ((item as Record<string, unknown>).name as string) ||
          ((item as Record<string, unknown>).content as string) ||
          "",
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
