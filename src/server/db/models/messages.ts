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

export class MessageModel {
  constructor(private readonly graph: LadybugClient) {}

  async saveGMMessages(
    messages: Array<{ role: string; content: unknown; providerOptions?: unknown }>,
    turnNumber: number,
  ): Promise<void> {
    const convRows = await this.graph.query("MATCH (c:Conversation) RETURN c._uid AS id");
    if (convRows.rows.length === 0) return;
    const convId = convRows.rows[0].id as string;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgId = uuidv4();
      const now = new Date().toISOString();

      await this.graph.query(
        `MATCH (c:Conversation {_uid: $convId})
         CREATE (c)-[r:_HAS_GM_MESSAGE]->(m:GMTurnMessage {
           _uid: $msgId, role: $role,
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
        `MATCH (c:Conversation {_uid: $convId})-[:_HAS_GM_MESSAGE]->(m:GMTurnMessage)
         WHERE NOT (m)-[:_NEXT_GM_MESSAGE]->(:GMTurnMessage)
         RETURN m._uid AS id ORDER BY m._created_at DESC LIMIT 1`,
        { convId },
      );
      if (lastRows.rows.length > 0 && lastRows.rows[0].id !== msgId) {
        await this.graph.mergeRelationship(
          "GMTurnMessage",
          "_uid",
          lastRows.rows[0].id,
          "GMTurnMessage",
          "_uid",
          msgId,
          "_NEXT_GM_MESSAGE",
        );
      }
    }

    if (turnNumber === 1) {
      const firstRows = await this.graph.query(
        `MATCH (c:Conversation {_uid: $convId})-[:_HAS_GM_MESSAGE]->(m:GMTurnMessage)
         RETURN m._uid AS id ORDER BY m._created_at LIMIT 1`,
        { convId },
      );
      if (firstRows.rows.length > 0) {
        try {
          await this.graph.mergeRelationship(
            "Conversation",
            "_uid",
            convId,
            "GMTurnMessage",
            "_uid",
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
        content: m.content,
        providerOptions: m.provider_options ?? undefined,
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
    await this.graph.query("MATCH (c:Conversation) WHERE c._uid <> 'singleton' DETACH DELETE c");

    const r = await this.graph.query(
      "MATCH (c:Conversation {_uid: 'singleton'}) RETURN c._uid AS id",
    );
    if (r.rows.length > 0) return r.rows[0].id as string;
    const now = new Date().toISOString();
    await this.graph.query(
      "CREATE (c:Conversation {_uid: 'singleton', _created_at: $now, _updated_at: $now})",
      { now },
    );
    return "singleton";
  }

}
