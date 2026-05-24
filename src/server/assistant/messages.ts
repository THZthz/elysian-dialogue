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

import type { ModelMessage } from "ai";
import { getMemoryClient } from "@/server/memory/client";
import { validateMessageChain } from "@/server/validateMessageChain";

const MAX_ASSISTANT_MESSAGES = 20;

export async function loadAssistantMessages(): Promise<ModelMessage[]> {
  const client = getMemoryClient();
  const rows = await client.neo4j.executeRead(
    `MATCH (m:AssistantMessage)
     RETURN m ORDER BY m._created_at, m.message_index`,
  );

  if (rows.length === 0) return [];

  // Take last N to avoid context bloat
  const recent = rows.slice(-MAX_ASSISTANT_MESSAGES);
  const raw = recent.map((r) => {
    const m = r.m as Record<string, unknown>;
    const msg: Record<string, unknown> = {
      role: m.role,
      content: JSON.parse(m.content as string),
    };
    return msg as unknown as ModelMessage;
  });

  return validateMessageChain(raw);
}

export async function saveAssistantMessages(
  messages: ModelMessage[],
  turnNumber: number,
): Promise<void> {
  const client = getMemoryClient();
  const now = new Date().toISOString();
  const filtered = messages.filter((m) => m.role !== "system");

  if (filtered.length === 0) return;

  // Count existing messages so we assign correct message_index offsets
  const countRows = await client.neo4j.executeRead(
    `MATCH (m:AssistantMessage) RETURN max(m.message_index) AS maxIdx`,
  );
  const existingCount = ((countRows[0]?.maxIdx as number) ?? -1) + 1;
  const totalAfterAdd = existingCount + filtered.length;

  // Prune oldest if over limit
  if (totalAfterAdd > MAX_ASSISTANT_MESSAGES) {
    const toDelete = totalAfterAdd - MAX_ASSISTANT_MESSAGES;
    await client.neo4j.executeWrite(
      `MATCH (m:AssistantMessage)
       WITH m ORDER BY m._created_at, m.message_index
       LIMIT $toDelete
       DETACH DELETE m`,
      { toDelete },
    );
  }

  // Find the last message to link from
  const lastRows = await client.neo4j.executeRead(
    `MATCH (m:AssistantMessage)
     WHERE NOT (m)-[:_NEXT_ASSISTANT_MESSAGE]->(:AssistantMessage)
     RETURN m._id AS id ORDER BY m._created_at DESC LIMIT 1`,
  );
  const previousLastId = lastRows.length > 0 ? (lastRows[0].id as string) : null;

  const ids: string[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const msg = filtered[i];
    const id = `amsg_${turnNumber}_${i}_${Date.now()}`;
    ids.push(id);
    await client.neo4j.executeWrite(
      `CREATE (m:AssistantMessage {
        _id: $id,
        role: $role,
        content: $content,
        turn_number: $turnNumber,
        message_index: $messageIndex,
        _created_at: datetime($now)
      })`,
      {
        id,
        role: msg.role,
        content: JSON.stringify(msg.content),
        turnNumber,
        messageIndex: existingCount + i,
        now,
      },
    );
  }

  // Chain messages together (linked list)
  if (previousLastId && ids.length > 0) {
    await client.neo4j.createRelationship(
      "AssistantMessage",
      "_id",
      previousLastId,
      "AssistantMessage",
      "_id",
      ids[0],
      "_NEXT_ASSISTANT_MESSAGE",
    );
  }
  for (let i = 0; i < ids.length - 1; i++) {
    await client.neo4j.createRelationship(
      "AssistantMessage",
      "_id",
      ids[i],
      "AssistantMessage",
      "_id",
      ids[i + 1],
      "_NEXT_ASSISTANT_MESSAGE",
    );
  }
}

export async function clearAssistantMessages(): Promise<void> {
  const client = getMemoryClient();
  await client.neo4j.executeWrite(`MATCH (m:AssistantMessage) DETACH DELETE m`);
}
