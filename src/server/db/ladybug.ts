import type { Database as LadybugDatabase, Connection as LadybugConnection } from "@ladybugdb/core";

export interface QueryResult {
  rows: Record<string, unknown>[];
}

export class LadybugClient {
  private db: LadybugDatabase | null = null;
  private conn: LadybugConnection | null = null;
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async init(): Promise<void> {
    const lbug = await import("@ladybugdb/core");
    this.db = new lbug.Database(this.filePath);
    this.conn = new lbug.Connection(this.db);
  }

  async query(cypher: string, params?: Record<string, unknown>): Promise<QueryResult> {
    if (!this.conn) throw new Error("LadybugClient not initialized");
    // conn.query() does not accept params — use prepare + execute for parameterized queries.
    const stmt = await this.conn.prepare(cypher);
    const raw = await this.conn.execute(
      stmt,
      params as Record<string, import("@ladybugdb/core").LbugValue> | undefined,
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
