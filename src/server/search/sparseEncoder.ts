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

/**
 * Tokenizes text into a sparse TF vector for storage (future Qdrant migration).
 * Uses FNV-1a 32-bit hashing for token to integer index mapping.
 * Tokens are stemmed, stop-word-filtered, and deduplicated for compact storage.
 */

import { tokenize } from "@/server/search/bm25";

function fnv1a32(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Sparse vector in Qdrant REST format: { indices: number[], values: number[] } */
export interface SparseVector {
  indices: number[];
  values: number[];
}

export function encodeSparse(text: string): SparseVector {
  const tokens = tokenize(text, { dedupe: false });
  const tf: Record<number, number> = {};
  for (const token of tokens) {
    const idx = fnv1a32(token);
    tf[idx] = (tf[idx] || 0) + 1;
  }
  const indices = Object.keys(tf)
    .map(Number)
    .sort((a, b) => a - b);
  return {
    indices,
    values: indices.map((i) => tf[i]),
  };
}
