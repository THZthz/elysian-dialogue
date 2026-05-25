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

import { Database, Connection, LbugValue } from "@ladybugdb/core";

export interface QueryResult {
  rows: Record<string, unknown>[];
}

export class LadybugClient {
  private db: Database | null = null;
  private conn: Connection | null = null;
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    this.db = new Database(this.filePath);
    this.conn = new Connection(this.db);
  }

  async query(cypher: string, params?: Record<string, unknown>): Promise<QueryResult> {
    if (!this.conn) throw new Error("LadybugClient not initialized");
    // conn.query() does not accept params — use prepare + execute for parameterized queries.
    const stmt = await this.conn.prepare(cypher);
    const raw = await this.conn.execute(
      stmt,
      params as Record<string, LbugValue> | undefined,
    );
    const result = Array.isArray(raw) ? raw[0] : raw;
    const rows: Record<string, unknown>[] = [];
    const all = await result.getAll();
    for (const row of all) {
      rows.push(row as Record<string, unknown>);
    }
    return { rows };
  }

  async close(): Promise<void> {
    if (this.conn) {
      await this.conn.close();
      this.conn = null;
    }
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }

  async mergeRelationship(
    srcLabel: string,
    srcKey: string,
    srcVal: unknown,
    tgtLabel: string,
    tgtKey: string,
    tgtVal: unknown,
    type: string,
    props?: Record<string, unknown>,
  ): Promise<void> {
    const setClauses: string[] = ["r._created_at = current_timestamp()"];
    const setParams: Record<string, unknown> = { srcVal, tgtVal };
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        setClauses.push(`r.\`${k}\` = $p_${k}`);
        setParams[`p_${k}`] = v;
      }
    }
    await this.query(
      `MATCH (src:\`${srcLabel}\` {\`${srcKey}\`: $srcVal})
       MATCH (tgt:\`${tgtLabel}\` {\`${tgtKey}\`: $tgtVal})
       MERGE (src)-[r:\`${type}\`]->(tgt)
       ON CREATE SET ${setClauses.join(", ")}`,
      setParams,
    );
  }

  async deleteRelationship(
    srcLabel: string,
    srcKey: string,
    srcVal: unknown,
    tgtLabel: string,
    tgtKey: string,
    tgtVal: unknown,
    type: string,
  ): Promise<number> {
    const result = await this.query(
      `MATCH (src:\`${srcLabel}\` {\`${srcKey}\`: $srcVal})-[r:\`${type}\`]->(tgt:\`${tgtLabel}\` {\`${tgtKey}\`: $tgtVal})
       DELETE r RETURN count(r) AS deleted`,
      { srcVal, tgtVal },
    );
    return (result.rows[0]?.deleted as number) ?? 0;
  }
}
