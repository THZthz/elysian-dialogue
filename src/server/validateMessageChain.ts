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

interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
}

interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  result: unknown;
}

type ContentPart = { type: string } & Record<string, unknown>;

/**
 * Validates and repairs a message chain so that every `tool` message
 * has a preceding `assistant` message with a matching `tool-call`.
 * Orphaned `tool` messages (e.g. from corrupted persistence) are dropped.
 */
export function validateMessageChain(messages: ModelMessage[]): ModelMessage[] {
  const expectedToolIds = new Set<string>();
  const cleaned: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const parts = extractContentParts(msg.content);
      for (const part of parts) {
        if (part.type === "tool-call") {
          const tc = part as unknown as ToolCallPart;
          if (tc.toolCallId) expectedToolIds.add(tc.toolCallId);
        }
      }
      cleaned.push(msg);
    } else if (msg.role === "tool") {
      const parts = extractContentParts(msg.content);
      const allValid = parts.every((part) => {
        if (part.type !== "tool-result") return true;
        const id = (part as unknown as ToolResultPart).toolCallId;
        return id ? expectedToolIds.has(id) : true;
      });
      if (allValid) {
        cleaned.push(msg);
        for (const part of parts) {
          if (part.type === "tool-result") {
            expectedToolIds.delete((part as unknown as ToolResultPart).toolCallId);
          }
        }
      } else {
        console.warn(
          "[validateMessageChain] Dropping orphaned tool message:",
          JSON.stringify(msg.content).slice(0, 200),
        );
      }
    } else {
      cleaned.push(msg);
    }
  }

  const dropped = messages.length - cleaned.length;
  if (dropped > 0) {
    console.warn(
      `[validateMessageChain] Dropped ${dropped} orphaned tool message(s) from chain of ${messages.length}`,
    );
  }

  return cleaned;
}

function extractContentParts(content: unknown): ContentPart[] {
  if (Array.isArray(content)) return content as ContentPart[];
  return [];
}
