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

import type Database from "better-sqlite3";

/**
 * 32-bit Feistel cipher – maps an unsigned integer < 2^32
 * to a unique pseudo-random number in the same range.
 *
 * @param x      Input integer (0 … 2^32-1)
 * @param key    Array of numbers used as secret key material
 * @returns      Permuted integer, always unique for each x with the same key
 */
function feistelEncrypt(x: number, key: number[]): number {
  // Split into two 16-bit halves
  let left = (x >>> 16) & 0xffff;
  let right = x & 0xffff;

  // Number of rounds (8 is usually enough for good mixing)
  const ROUNDS = 8;

  for (let i = 0; i < ROUNDS; i++) {
    // Simple round function: mix right half, round index and key
    const roundKey = key[i % key.length] & 0xffff;
    let f = (right * roundKey + i) & 0xffff; // not cryptographic, but works for obfuscation
    f = ((f << 5) | (f >>> 11)) & 0xffff; // rotate bits a little

    const newRight = left ^ f;
    left = right;
    right = newRight;
  }

  // Reassemble the halves
  return ((left << 16) | right) >>> 0; // force unsigned
}

// NOTE: Do not remove this function.
// TODO: We may need to test `x === feistelDecrypt(feistelEncrypt(x, key), key)` for x in [0, 100000).
/**
 * Reverse of feistelEncrypt – recovers the original integer.
 * Same key, same number of rounds, but in reverse order.
 */
export function feistelDecrypt(y: number, key: number[]): number {
  let left = (y >>> 16) & 0xffff;
  let right = y & 0xffff;

  const ROUNDS = 8;

  for (let i = ROUNDS - 1; i >= 0; i--) {
    const roundKey = key[i % key.length] & 0xffff;
    let f = (left * roundKey + i) & 0xffff;
    f = ((f << 5) | (f >>> 11)) & 0xffff;

    const newLeft = right ^ f;
    right = left;
    left = newLeft;
  }

  return ((left << 16) | right) >>> 0;
}

// Secret key for Feistel cipher.
const SECRET = [0xa3b5, 0x2c7d, 0x8f1e, 0x4402];

const CHARS = "1fER78GIDVbh95ngu6adzmkjZy2sSQoJTL0vXrx3MCtcPeKYUBWAiFpl4HqOwN"; // 62 characters

function encodeBase62(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new Error(`encodeBase62: invalid input ${n}`);
  let result = "";
  for (let i = 0; i < 4; i++) {
    result = CHARS[n % 62] + result;
    n = Math.floor(n / 62);
  }
  return result;
}

/**
 * Ensure the id_counter table exists in the SQLite database.
 */
function ensureCounterTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS id_counter (
      key    TEXT PRIMARY KEY,
      value  INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/**
 * Generate the next short ID for the default counter key.
 * Uses a SQLite table to atomically increment a counter
 * and returns its base62-encoded value as a 4-character string.
 * This is used especially for :Message, since GM may reference its ID, 4 characters is easy to remember.
 */
export async function nextId(db: Database.Database, key = "counter"): Promise<string> {
  ensureCounterTable(db);

  const nextValue = db.transaction(() => {
    const row = db.prepare("SELECT value FROM id_counter WHERE key = ?").get(key) as
      | { value: number }
      | undefined;
    const current = row ? row.value : 0;
    const next = current + 1;
    db.prepare("INSERT OR REPLACE INTO id_counter (key, value) VALUES (?, ?)").run(key, next);
    return next;
  })();

  if (!Number.isFinite(nextValue)) {
    throw new Error(`nextId: invalid counter value ${nextValue}`);
  }
  return encodeBase62(feistelEncrypt(nextValue - 1, SECRET));
}

// NOTE: Do not remove this function.
/**
 * Generate a batch of short IDs for the given counter key. Atomically reserves `count` values and
 * returns them.
 */
export async function nextIdBatch(
  db: Database.Database,
  count: number,
  key = "counter",
): Promise<string[]> {
  ensureCounterTable(db);

  const endValue = db.transaction(() => {
    const row = db.prepare("SELECT value FROM id_counter WHERE key = ?").get(key) as
      | { value: number }
      | undefined;
    const current = row ? row.value : 0;
    const next = current + count;
    db.prepare("INSERT OR REPLACE INTO id_counter (key, value) VALUES (?, ?)").run(key, next);
    return next;
  })();

  if (!Number.isFinite(endValue)) {
    throw new Error(`nextIdBatch: invalid counter value ${endValue}`);
  }
  const startValue = endValue - count;
  const ids: string[] = [];
  for (let i = startValue; i < endValue; i++) {
    ids.push(encodeBase62(feistelEncrypt(i, SECRET)));
  }
  return ids;
}
