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
import { getNodeManager } from "@/server/nodeManager";
import { RelationshipManager } from "@/server/relationshipManager";
import { getReranker, applyRerank } from "@/server/memory/reranker";
import { encodeSparse } from "@/server/memory/sparseEncoder";
import type { QdrantVectorClient } from "@/server/memory/qdrant";

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

  private async search(
    domain: string,
    kind: "node" | "relationship",
    query: string,
    options?: { limit?: number; rerank?: boolean },
  ): Promise<Array<Record<string, unknown> & { similarity: number; relevance?: number }>> {
    const { limit = 10, rerank = true } = options || {};
    const useRerank = rerank !== false && getReranker() !== null;
    const fetchLimit = useRerank ? Math.max(limit * 4, 40) : limit;

    const embedder = getEmbedder();
    const filter = this.buildFilter(domain, kind);
    const nameText = `[${domain}] ${query}`;

    const [nameVec, contentVec, sparseVec] = await Promise.all([
      embedder.embed(nameText),
      embedder.embed(query),
      Promise.resolve(encodeSparse(query)),
    ]);

    const results = await this.qdrant.queryPoints(
      nameVec,
      contentVec,
      sparseVec,
      filter,
      fetchLimit,
      fetchLimit,
    );

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
      const manager = kind === "node" ? getNodeManager() : RelationshipManager.getCachedInstance();
      const withText = items.map((item) => ({
        ...item,
        text: item.text || manager.getEmbeddingText(domain, item),
      }));
      const reranked = await applyRerank(query, withText, limit);
      return reranked.map((r) => {
        const { text: _, ...rest } = r as Record<string, unknown>;
        return rest as Record<string, unknown> & { similarity: number; relevance?: number };
      });
    }

    return items.map(
      ({ text: _, ...rest }) => rest as Record<string, unknown> & { similarity: number },
    );
  }

  async searchByLabel(
    label: string,
    query: string,
    options?: { limit?: number; rerank?: boolean },
  ): Promise<Array<Record<string, unknown> & { similarity: number; relevance?: number }>> {
    return this.search(label, "node", query, options);
  }

  async searchByRelationshipType(
    type: string,
    query: string,
    options?: { limit?: number; rerank?: boolean },
  ): Promise<Array<Record<string, unknown> & { similarity: number; relevance?: number }>> {
    return this.search(type, "relationship", query, options);
  }
}
