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
 * Tokenizes text into a sparse TF vector for Qdrant hybrid search.
 * Uses FNV-1a 32-bit hashing for token to integer index mapping.
 * Qdrant's "modifier": "idf" handles IDF weighting server-side.
 */

function fnv1a32(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export type SparseVector = Record<number, number>;

export function encodeSparse(text: string): SparseVector {
  const tokens = text.toLowerCase().split(/[\s\p{P}]+/u).filter(Boolean);
  const vec: SparseVector = {};
  for (const token of tokens) {
    const idx = fnv1a32(token);
    vec[idx] = (vec[idx] || 0) + 1;
  }
  return vec;
}
