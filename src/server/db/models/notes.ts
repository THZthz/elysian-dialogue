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

import type { LadybugClient } from "@/server/db/ladybug";
import type { VectorStore } from "@/server/db/vectorstore";
import type { Embedder } from "@/server/search/embedder";
import { getSchemaRegistry } from "@/server/db/schema";
import { encodeSparse } from "@/server/search/sparseEncoder";

export interface Note {
  name: string;
  content: string;
  linkedEntities: string[];
  linkedScenes: string[];
  linkedPlots: string[];
}

export class NoteModel {
  constructor(
    private readonly graph: LadybugClient,
    private readonly vectors: VectorStore,
    private readonly embedder: Embedder,
  ) {}

  async create(name: string, content: string): Promise<void> {
    const registry = getSchemaRegistry();

    const now = new Date().toISOString();
    await this.graph.query(
      "CREATE (n:Note {name: $name, content: $content, _created_at: $now, _updated_at: $now})",
      { name, content, now },
    );

    const nameText = registry.getEmbeddingNameText("Note", { name });
    const contentText = registry.getEmbeddingContentText("Note", { content });
    const [nameVec, contentVec] = await Promise.all([
      this.embedder.embed(nameText || name),
      this.embedder.embed(contentText || content),
    ]);
    this.vectors.upsert(
      `Note:${name}`,
      "Note",
      "node",
      new Float32Array(nameVec),
      new Float32Array(contentVec),
      encodeSparse(contentText || content),
      {
        node_type: "Note",
        kind: "node",
        object_id: `Note:${name}`,
        text: contentText,
        name,
        content,
      },
    );
  }

  async update(name: string, content: string): Promise<void> {
    const registry = getSchemaRegistry();

    const now = new Date().toISOString();
    await this.graph.query(
      "MATCH (n:Note {name: $name}) SET n.content = $content, n._updated_at = $now",
      { name, content, now },
    );

    const contentText = registry.getEmbeddingContentText("Note", { content });
    const [nameVec, contentVec] = await Promise.all([
      this.embedder.embed(name),
      this.embedder.embed(contentText || content),
    ]);
    this.vectors.upsert(
      `Note:${name}`,
      "Note",
      "node",
      new Float32Array(nameVec),
      new Float32Array(contentVec),
      encodeSparse(contentText || content),
      {
        node_type: "Note",
        kind: "node",
        object_id: `Note:${name}`,
        text: contentText,
        name,
        content,
      },
    );
  }

  async delete(name: string): Promise<void> {
    this.vectors.delete(`Note:${name}`);
    await this.graph.query("MATCH (n:Note {name: $name}) DETACH DELETE n", { name });
  }

  async getByName(name: string): Promise<Note | null> {
    const r = await this.graph.query("MATCH (n:Note {name: $name}) RETURN n", { name });
    if (r.rows.length === 0) return null;
    const row = (r.rows[0].n || r.rows[0]) as Record<string, unknown>;
    return this.parseNote(name, row.content as string);
  }

  async linkToEntity(noteName: string, entityName: string): Promise<void> {
    const r = await this.graph.query(
      "MATCH (n) WHERE (label(n) = 'Character' OR label(n) = 'Object' OR label(n) = 'Location') AND n.name = $name RETURN label(n) AS label LIMIT 1",
      { name: entityName },
    );
    if (r.rows.length === 0) throw new Error(`Entity "${entityName}" not found.`);
    const label = r.rows[0].label as string;
    await this.graph.mergeRelationship(
      "Note",
      "name",
      noteName,
      label,
      "name",
      entityName,
      "ABOUT_ENTITY",
    );
  }

  async linkToScene(noteName: string, sceneUid: string): Promise<void> {
    await this.graph.mergeRelationship(
      "Note",
      "name",
      noteName,
      "Scene",
      "_uid",
      sceneUid,
      "ABOUT_SCENE",
    );
  }

  async linkToPlot(noteName: string, plotName: string): Promise<void> {
    await this.graph.mergeRelationship(
      "Note",
      "name",
      noteName,
      "Plot",
      "name",
      plotName,
      "ABOUT_PLOT",
    );
  }

  async clearLinks(noteName: string): Promise<void> {
    await this.graph.query("MATCH (n:Note {name: $name})-[r:ABOUT_ENTITY]->() DELETE r", {
      name: noteName,
    });
    await this.graph.query("MATCH (n:Note {name: $name})-[r:ABOUT_SCENE]->() DELETE r", {
      name: noteName,
    });
    await this.graph.query("MATCH (n:Note {name: $name})-[r:ABOUT_PLOT]->() DELETE r", {
      name: noteName,
    });
  }

  async getLinkedEntities(noteName: string): Promise<string[]> {
    const r = await this.graph.query(
      "MATCH (n:Note {name: $name})-[:ABOUT_ENTITY]->(e) WHERE (label(e) = 'Character' OR label(e) = 'Object' OR label(e) = 'Location') RETURN e.name AS name",
      { name: noteName },
    );
    return r.rows.map((row) => row.name as string);
  }

  async getLinkedScenes(noteName: string): Promise<string[]> {
    const r = await this.graph.query(
      "MATCH (n:Note {name: $name})-[:ABOUT_SCENE]->(s:Scene) RETURN s._uid AS uid",
      { name: noteName },
    );
    return r.rows.map((row) => row.uid as string);
  }

  async getLinkedPlots(noteName: string): Promise<string[]> {
    const r = await this.graph.query(
      "MATCH (n:Note {name: $name})-[:ABOUT_PLOT]->(p:Plot) RETURN p.name AS name",
      { name: noteName },
    );
    return r.rows.map((row) => row.name as string);
  }

  private async parseNote(name: string, content: string): Promise<Note> {
    const [entities, scenes, plots] = await Promise.all([
      this.getLinkedEntities(name),
      this.getLinkedScenes(name),
      this.getLinkedPlots(name),
    ]);
    return { name, content, linkedEntities: entities, linkedScenes: scenes, linkedPlots: plots };
  }
}
