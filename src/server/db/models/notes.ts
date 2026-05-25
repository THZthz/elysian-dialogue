import type { LadybugClient } from "@/server/db/ladybug";
import type { VectorStore } from "@/server/db/vectorstore";
import type { Embedder } from "@/server/search/embedder";
import { getNodeManager } from "@/server/db/schema";
import { encodeSparse } from "@/server/search/sparseEncoder";

export interface MemoryNote {
  name: string;
  content: string;
  linkedEntities: string[];
  linkedMessages: string[];
  linkedPlots: string[];
}

export class NoteModel {
  constructor(
    private readonly graph: LadybugClient,
    private readonly vectors: VectorStore,
    private readonly embedder: Embedder,
  ) {}

  async create(name: string, content: string): Promise<void> {
    const now = new Date().toISOString();
    await this.graph.query("CREATE (n:Note {name: $name, content: $content, _created_at: $now, _updated_at: $now})", { name, content, now });

    const nameText = getNodeManager().getEmbeddingNameText("Note", { name });
    const contentText = getNodeManager().getEmbeddingContentText("Note", { content });
    const [nameVec, contentVec] = await Promise.all([
      this.embedder.embed(nameText || name),
      this.embedder.embed(contentText || content),
    ]);
    this.vectors.upsert(`Note:${name}`, "Note", "node", new Float32Array(nameVec), new Float32Array(contentVec),
      encodeSparse(contentText || content), { node_type: "Note", kind: "node", object_id: `Note:${name}`, text: contentText, name, content });
  }

  async update(name: string, content: string): Promise<void> {
    const now = new Date().toISOString();
    await this.graph.query("MATCH (n:Note {name: $name}) SET n.content = $content, n._updated_at = $now", { name, content, now });

    const contentText = getNodeManager().getEmbeddingContentText("Note", { content });
    const [nameVec, contentVec] = await Promise.all([
      this.embedder.embed(name),
      this.embedder.embed(contentText || content),
    ]);
    this.vectors.upsert(`Note:${name}`, "Note", "node", new Float32Array(nameVec), new Float32Array(contentVec),
      encodeSparse(contentText || content), { node_type: "Note", kind: "node", object_id: `Note:${name}`, text: contentText, name, content });
  }

  async delete(name: string): Promise<void> {
    this.vectors.delete(`Note:${name}`);
    await this.graph.query("MATCH (n:Note {name: $name}) DETACH DELETE n", { name });
  }

  async getByName(name: string): Promise<MemoryNote | null> {
    const r = await this.graph.query("MATCH (n:Note {name: $name}) RETURN n", { name });
    if (r.rows.length === 0) return null;
    const row = (r.rows[0].n || r.rows[0]) as Record<string, unknown>;
    return this.parseNote(name, row.content as string);
  }

  async linkToEntity(noteName: string, entityName: string): Promise<void> {
    const r = await this.graph.query("MATCH (n) WHERE (n:Character OR n:Object OR n:Location) AND n.name = $name RETURN label(n) AS label LIMIT 1", { name: entityName });
    if (r.rows.length === 0) throw new Error(`Entity "${entityName}" not found`);
    const label = r.rows[0].label as string;
    await this.graph.mergeRelationship("Note", "name", noteName, label, "name", entityName, "ABOUT_ENTITY");
  }

  async linkToMessage(noteName: string, messageId: string): Promise<void> {
    await this.graph.mergeRelationship("Note", "name", noteName, "Message", "id", messageId, "ABOUT_MESSAGE");
  }

  async linkToPlot(noteName: string, plotName: string): Promise<void> {
    await this.graph.mergeRelationship("Note", "name", noteName, "Plot", "name", plotName, "ABOUT_PLOT");
  }

  async clearLinks(noteName: string): Promise<void> {
    await this.graph.query("MATCH (n:Note {name: $name})-[r:ABOUT_ENTITY|ABOUT_MESSAGE|ABOUT_PLOT]->() DELETE r", { name: noteName });
  }

  async getLinkedEntities(noteName: string): Promise<string[]> {
    const r = await this.graph.query("MATCH (n:Note {name: $name})-[:ABOUT_ENTITY]->(e) WHERE label(e) IN ('Character', 'Object', 'Location') RETURN e.name AS name", { name: noteName });
    return r.rows.map((row) => row.name as string);
  }

  async getLinkedMessages(noteName: string): Promise<string[]> {
    const r = await this.graph.query("MATCH (n:Note {name: $name})-[:ABOUT_MESSAGE]->(m:Message) RETURN m.id AS id", { name: noteName });
    return r.rows.map((row) => row.id as string);
  }

  async getLinkedPlots(noteName: string): Promise<string[]> {
    const r = await this.graph.query("MATCH (n:Note {name: $name})-[:ABOUT_PLOT]->(p:Plot) RETURN p.name AS name", { name: noteName });
    return r.rows.map((row) => row.name as string);
  }

  private async parseNote(name: string, content: string): Promise<MemoryNote> {
    const [entities, messages, plots] = await Promise.all([
      this.getLinkedEntities(name), this.getLinkedMessages(name), this.getLinkedPlots(name),
    ]);
    return { name, content, linkedEntities: entities, linkedMessages: messages, linkedPlots: plots };
  }
}
