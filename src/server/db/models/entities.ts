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

import { v4 as uuidv4 } from "uuid";
import type { LadybugClient } from "@/server/db/ladybug";
import type { VectorStore } from "@/server/db/vectorstore";
import type { Embedder } from "@/server/search/embedder";
import { getNodeManager } from "@/server/db/schema";
import { encodeSparse } from "@/server/search/sparseEncoder";

export interface Entity {
  uid: string;
  name: string;
  label: string;
  brief: string;
  description: string;
  metadata: Record<string, unknown>;
  aliases: string[];
  isNew: boolean;
}

type EntityLabel = "Character" | "Object" | "Location";

export class EntityModel {
  private readonly graph: LadybugClient;
  private readonly vectors: VectorStore;
  private readonly embedder: Embedder;

  constructor(graph: LadybugClient, vectors: VectorStore, embedder: Embedder) {
    this.graph = graph;
    this.vectors = vectors;
    this.embedder = embedder;
  }

  async create(
    label: EntityLabel,
    props: {
      name: string;
      brief?: string;
      description?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Entity> {
    const uid = uuidv4();
    const now = new Date().toISOString();
    const brief = props.brief ?? "";
    const description = props.description ?? "";
    const metadata = JSON.stringify(props.metadata ?? {});

    await this.graph.query(
      `CREATE (e:\`${label}\` {uid: $uid, name: $name, brief: $brief, description: $description, metadata: $metadata, _created_at: $now, _updated_at: $now})`,
      { uid, name: props.name, brief, description, metadata, now },
    );

    const entityProps = { name: props.name, brief, description };
    const nameText = getNodeManager().getEmbeddingNameText(label, entityProps);
    const contentText = getNodeManager().getEmbeddingContentText(label, entityProps);
    const [nameVec, contentVec] = await Promise.all([
      this.embedder.embed(nameText || props.name),
      this.embedder.embed(contentText || `${props.name} ${brief} ${description}`),
    ]);
    const sparseVec = encodeSparse(contentText || props.name);

    this.vectors.upsert(
      `${label}:${props.name}`,
      label,
      "node",
      new Float32Array(nameVec),
      new Float32Array(contentVec),
      sparseVec,
      {
        node_type: label,
        kind: "node",
        object_id: `${label}:${props.name}`,
        text: contentText,
        name: props.name,
        brief,
        description,
        metadata,
      },
    );

    return {
      uid,
      name: props.name,
      label,
      brief,
      description,
      metadata: props.metadata ?? {},
      aliases: [],
      isNew: true,
    };
  }

  async update(
    label: EntityLabel,
    where: Record<string, unknown>,
    sets: Record<string, unknown>,
  ): Promise<Entity | null> {
    const whereClauses = Object.entries(where).map(([k]) => `n.\`${k}\` = $w_${k}`);
    const r = await this.graph.query(
      `MATCH (n:\`${label}\`) WHERE ${whereClauses.join(" AND ")} RETURN n`,
      Object.fromEntries(Object.entries(where).map(([k, v]) => [`w_${k}`, v])),
    );
    if (r.rows.length === 0) return null;

    const existing = (r.rows[0].n || r.rows[0]) as Record<string, unknown>;
    const oldName = existing.name as string;
    const name = (sets.name as string) ?? (existing.name as string);
    const brief = (sets.brief as string) ?? (existing.brief as string) ?? "";
    const description = (sets.description as string) ?? (existing.description as string) ?? "";
    const metadata = sets.metadata ? JSON.stringify(sets.metadata) : (existing.metadata as string);

    const setClauses = Object.entries(sets).map(([k]) => `n.\`${k}\` = $s_${k}`);
    setClauses.push("n._updated_at = $now");
    const allParams = {
      ...Object.fromEntries(Object.entries(where).map(([k, v]) => [`w_${k}`, v])),
      ...Object.fromEntries(Object.entries(sets).map(([k, v]) => [`s_${k}`, v])),
      now: new Date().toISOString(),
    };

    await this.graph.query(
      `MATCH (n:\`${label}\`) WHERE ${whereClauses.join(" AND ")} SET ${setClauses.join(", ")}`,
      allParams,
    );

    const entityProps = { name, brief, description };
    const nameText = getNodeManager().getEmbeddingNameText(label, entityProps);
    const contentText = getNodeManager().getEmbeddingContentText(label, entityProps);
    const [nameVec, contentVec] = await Promise.all([
      this.embedder.embed(nameText || name),
      this.embedder.embed(contentText || `${name} ${brief} ${description}`),
    ]);
    const sparseVec = encodeSparse(contentText || name);
    // Delete old vector if name changed (pointId uses the name)
    if (oldName !== name) {
      this.vectors.delete(`${label}:${oldName}`);
    }
    this.vectors.upsert(
      `${label}:${name}`,
      label,
      "node",
      new Float32Array(nameVec),
      new Float32Array(contentVec),
      sparseVec,
      {
        node_type: label,
        kind: "node",
        object_id: `${label}:${name}`,
        text: contentText,
        name,
        brief,
        description,
        metadata,
      },
    );

    return this.parseEntity(label, { ...existing, ...sets, name, brief, description, metadata });
  }

  async delete(label: EntityLabel, where: Record<string, unknown>): Promise<number> {
    if (where.name) this.vectors.delete(`${label}:${where.name}`);
    const whereClauses = Object.entries(where).map(([k]) => `n.\`${k}\` = $w_${k}`);
    const r = await this.graph.query(
      `MATCH (n:\`${label}\`) WHERE ${whereClauses.join(" AND ")} DETACH DELETE n RETURN count(n) AS deleted`,
      Object.fromEntries(Object.entries(where).map(([k, v]) => [`w_${k}`, v])),
    );
    return (r.rows[0]?.deleted as number) ?? 0;
  }

  async getByName(label: EntityLabel, name: string): Promise<Entity | null> {
    const r = await this.graph.query(`MATCH (n:\`${label}\` {name: $name}) RETURN n`, { name });
    if (r.rows.length === 0) return null;
    return this.parseEntity(label, (r.rows[0].n || r.rows[0]) as Record<string, unknown>);
  }

  async getById(id: string): Promise<Entity | null> {
    for (const label of ["Character", "Object", "Location"] as EntityLabel[]) {
      const r = await this.graph.query(`MATCH (n:\`${label}\` {uid: $id}) RETURN n`, { id });
      if (r.rows.length > 0) {
        return this.parseEntity(label, (r.rows[0].n || r.rows[0]) as Record<string, unknown>);
      }
    }
    return null;
  }

  parseEntity(label: string, row: Record<string, unknown>, isNew = false): Entity {
    const meta =
      typeof row.metadata === "string"
        ? (JSON.parse(row.metadata) as Record<string, unknown>)
        : ((row.metadata as Record<string, unknown>) ?? {});
    const aliases = Array.isArray(meta.aliases) ? (meta.aliases as string[]) : [];
    return {
      uid: row.uid as string,
      name: row.name as string,
      label,
      brief: (row.brief as string) ?? "",
      description: (row.description as string) ?? "",
      metadata: meta,
      aliases,
      isNew,
    };
  }
}
