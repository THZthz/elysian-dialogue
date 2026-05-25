import { v4 as uuidv4 } from "uuid";
import type { LadybugClient } from "@/server/db/ladybug";
import type { VectorStore } from "@/server/db/vectorstore";
import type { Embedder } from "@/server/search/embedder";
import { getNodeManager } from "@/server/db/schema";

export interface MemoryMessage {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

export class MessageModel {
  private readonly graph: LadybugClient;
  private readonly vectors: VectorStore;
  private readonly embedder: Embedder;

  constructor(graph: LadybugClient, vectors: VectorStore, embedder: Embedder) {
    this.graph = graph;
    this.vectors = vectors;
    this.embedder = embedder;
  }

  async nextId(): Promise<string> {
    const result = await this.graph.query(
      `MERGE (c:IdCounter {uid: 'counter'})
       ON CREATE SET c.value = 0
       SET c.value = c.value + 1
       RETURN c.value AS value`,
    );
    const value = result.rows[0]?.value as number;
    return String(value).padStart(4, "0");
  }

  async addMessage(
    content: string,
    metadata?: Record<string, unknown>,
    generateEmbedding = true,
    linkToCurrentTime = true,
  ): Promise<MemoryMessage> {
    const convId = await this.ensureConversation();

    let contentVec: Float32Array | undefined;
    let embedText: string | undefined;
    if (generateEmbedding) {
      embedText = getNodeManager().getEmbeddingContentText("Message", { content });
      if (embedText) {
        const vec = await this.embedder.embed(embedText);
        contentVec = new Float32Array(vec);
      }
    }

    const messageId = await this.nextId();
    const now = new Date().toISOString();
    const merged = { ...metadata };

    await this.graph.query(
      `MATCH (c:Conversation {uid: $convId})
       CREATE (m:Message {
         id: $id, content: $content,
         timestamp: $now,
         metadata: $metadata
       })
       CREATE (c)-[r:HAS_MESSAGE]->(m)
       SET r._created_at = current_timestamp()`,
      { convId, id: messageId, content, now, metadata: JSON.stringify(merged) },
    );

    if (contentVec && embedText) {
      try {
        this.vectors.upsert(
          `Message:${messageId}`,
          "Message",
          "node",
          contentVec,
          contentVec,
          { indices: [], values: [] },
          {
            node_type: "Message",
            kind: "node",
            object_id: `Message:${messageId}`,
            text: embedText,
            content,
            id: messageId,
            metadata: JSON.stringify(merged),
            timestamp: now,
          },
        );
      } catch (err) {
        console.warn(
          "[messages] vector upsert failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const lastId = await this.getLastMessageId(convId, messageId);
    const isFirst = lastId === null;
    await this.createMessageLinks(convId, [messageId], lastId, isFirst);

    if (linkToCurrentTime) {
      try {
        await this.graph.query(
          `MATCH (a:TimeAnchor {uid: 'anchor'})-[:CURRENT_TIMEPOINT]->(tp:TimePoint)
           MATCH (m:Message {id: $msgId})
           MERGE (m)-[r:AT_TIME]->(tp)
           ON CREATE SET r._created_at = current_timestamp()`,
          { msgId: messageId },
        );
      } catch {
        // TimePoint system not yet initialized — skip
      }
    }

    return { id: messageId, content, metadata: metadata || {} };
  }

  async getConversation(limit = 1000): Promise<MemoryMessage[]> {
    const result = await this.graph.query(
      `MATCH (c:Conversation)-[:HAS_MESSAGE]->(m:Message)
       RETURN m ORDER BY m.timestamp DESC LIMIT $limit`,
      { limit },
    );
    return result.rows.reverse().map((r) => {
      const m = (r.m as Record<string, unknown>) || r;
      const meta = m.metadata ? (JSON.parse(m.metadata as string) as Record<string, unknown>) : {};
      return { id: m.id as string, content: m.content as string, metadata: meta };
    });
  }

  async saveCurrentOptions(options: unknown): Promise<void> {
    await this.graph.query(
      `MERGE (c:Conversation {uid: 'singleton'}) SET c.options = $options, c._updated_at = $now`,
      { options: JSON.stringify(options), now: new Date().toISOString() },
    );
  }

  async getCurrentOptions(): Promise<{ id: string; options: unknown } | null> {
    const r = await this.graph.query(
      "MATCH (c:Conversation) RETURN c.uid AS id, c.options AS options",
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    const raw = row.options;
    if (typeof raw === "string") {
      try {
        return { id: row.id as string, options: JSON.parse(raw) };
      } catch {
        return { id: row.id as string, options: raw };
      }
    }
    return { id: row.id as string, options: raw };
  }

  async saveGMMessages(
    messages: Array<{ role: string; content: unknown; providerOptions?: unknown }>,
    turnNumber: number,
  ): Promise<void> {
    const convRows = await this.graph.query("MATCH (c:Conversation) RETURN c.uid AS id");
    if (convRows.rows.length === 0) return;
    const convId = convRows.rows[0].id as string;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgId = uuidv4();
      const now = new Date().toISOString();

      await this.graph.query(
        `MATCH (c:Conversation {uid: $convId})
         CREATE (c)-[r:_HAS_GM_MESSAGE]->(m:GMTurnMessage {
           uid: $msgId, role: $role,
           content: $content, provider_options: $providerOpts,
           turn_number: $turn, message_index: $idx,
           _created_at: $now
         })
         SET r._created_at = current_timestamp()`,
        {
          convId,
          msgId,
          now,
          role: msg.role,
          content: JSON.stringify(msg.content),
          providerOpts: msg.providerOptions ? JSON.stringify(msg.providerOptions) : null,
          turn: turnNumber,
          idx: i,
        },
      );

      const lastRows = await this.graph.query(
        `MATCH (c:Conversation {uid: $convId})-[:_HAS_GM_MESSAGE]->(m:GMTurnMessage)
         WHERE NOT (m)-[:_NEXT_GM_MESSAGE]->(:GMTurnMessage)
         RETURN m.uid AS id ORDER BY m._created_at DESC LIMIT 1`,
        { convId },
      );
      if (lastRows.rows.length > 0 && lastRows.rows[0].id !== msgId) {
        await this.graph.mergeRelationship(
          "GMTurnMessage",
          "uid",
          lastRows.rows[0].id,
          "GMTurnMessage",
          "uid",
          msgId,
          "_NEXT_GM_MESSAGE",
        );
      }
    }

    if (turnNumber === 1) {
      const firstRows = await this.graph.query(
        `MATCH (c:Conversation {uid: $convId})-[:_HAS_GM_MESSAGE]->(m:GMTurnMessage)
         RETURN m.uid AS id ORDER BY m._created_at LIMIT 1`,
        { convId },
      );
      if (firstRows.rows.length > 0) {
        try {
          await this.graph.mergeRelationship(
            "Conversation",
            "uid",
            convId,
            "GMTurnMessage",
            "uid",
            firstRows.rows[0].id,
            "_FIRST_GM_MESSAGE",
          );
        } catch {
          /* may already exist */
        }
      }
    }
  }

  async loadGMMessages(): Promise<
    Array<{ role: string; content: unknown; providerOptions?: unknown }>
  > {
    const r = await this.graph.query(
      `MATCH (c:Conversation)-[:_HAS_GM_MESSAGE]->(m:GMTurnMessage)
       RETURN m ORDER BY m._created_at, m.message_index`,
    );
    return r.rows.map((row) => {
      const m = (row.m as Record<string, unknown>) || row;
      return {
        role: m.role as string,
        content: typeof m.content === "string" ? JSON.parse(m.content) : m.content,
        providerOptions: m.provider_options
          ? typeof m.provider_options === "string"
            ? JSON.parse(m.provider_options as string)
            : m.provider_options
          : undefined,
      };
    });
  }

  async getNextTurnNumber(): Promise<number> {
    const r = await this.graph.query(
      "MATCH (c:Conversation)-[:_HAS_GM_MESSAGE]->(m:GMTurnMessage) RETURN max(m.turn_number) AS maxTurn",
    );
    const maxTurn = r.rows[0]?.maxTurn as number | null;
    return (maxTurn ?? 0) + 1;
  }

  private async ensureConversation(): Promise<string> {
    // Clean up orphaned Conversation nodes from prior runs (paranoid safety)
    await this.graph.query("MATCH (c:Conversation) WHERE c.uid <> 'singleton' DETACH DELETE c");

    const r = await this.graph.query(
      "MATCH (c:Conversation {uid: 'singleton'}) RETURN c.uid AS id",
    );
    if (r.rows.length > 0) return r.rows[0].id as string;
    const now = new Date().toISOString();
    await this.graph.query(
      "CREATE (c:Conversation {uid: 'singleton', _created_at: $now, _updated_at: $now})",
      { now },
    );
    return "singleton";
  }

  private async getLastMessageId(convId: string, excludeId: string): Promise<string | null> {
    const r = await this.graph.query(
      `MATCH (c:Conversation {uid: $convId})-[:HAS_MESSAGE]->(m:Message)
       WHERE m.id <> $excludeId AND NOT (m)-[:NEXT_MESSAGE]->(:Message)
       RETURN m.id AS id ORDER BY m.timestamp DESC LIMIT 1`,
      { convId, excludeId },
    );
    return r.rows.length > 0 ? (r.rows[0].id as string) : null;
  }

  private async createMessageLinks(
    convId: string,
    messageIds: string[],
    previousLastId: string | null,
    isFirst: boolean,
  ): Promise<void> {
    if (messageIds.length === 0) return;
    if (previousLastId && messageIds.length > 0) {
      await this.graph.mergeRelationship(
        "Message",
        "id",
        previousLastId,
        "Message",
        "id",
        messageIds[0],
        "NEXT_MESSAGE",
      );
    }
    for (let i = 0; i < messageIds.length - 1; i++) {
      await this.graph.mergeRelationship(
        "Message",
        "id",
        messageIds[i],
        "Message",
        "id",
        messageIds[i + 1],
        "NEXT_MESSAGE",
      );
    }
    if (isFirst && messageIds.length > 0) {
      await this.graph.mergeRelationship(
        "Conversation",
        "uid",
        convId,
        "Message",
        "id",
        messageIds[0],
        "FIRST_MESSAGE",
      );
    }
  }
}
