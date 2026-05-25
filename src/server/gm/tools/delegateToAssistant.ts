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

import { tool } from "ai";
import { z } from "zod";
import { wrapSafe } from "@/server/shared/toolUtils";
import { delegateToAssistant, type AssistantContext } from "@/server/assistant";
import { TOOL_NAMES } from "@/shared/constants";

export function createDelegateToAssistantTool(contextFactory: () => AssistantContext) {
  return {
    delegateToAssistant: tool({
      title: TOOL_NAMES.DELEGATE_TO_ASSISTANT,
      description: `
## Brief
Delegate database operations to your assistant. Describe what you need in natural language and the assistant will execute using its database tools (queryWorld, searchWorld, editNode, editRelationship, editNote, getContext, manageSchema). The assistant may also return observations about world state you should know.

## When to Use
- Reading world state: finding characters, locations, objects, dispositions
- Writing world state: moving entities, changing dispositions, creating/destroying objects
- Managing schema: registering new node or relationship types
- Getting context: scene dumps, entity briefs, schema info
- Any Cypher query you need executed

## When NOT to Use
- For notes and plots — use editNote, editPlot, and searchWorld directly (you have those tools).
- For dialogue — use generateDialogueStep.
- For advancing time — use advanceTime.
`.trim(),
      inputSchema: z.object({
        request: z
          .string()
          .describe(
            "Natural language request describing what to query, create, update, or delete in the database. Be specific: name the entities, relationships, or information you need.",
          ),
      }),
      execute: wrapSafe(async (args) => {
        const context = contextFactory();
        return delegateToAssistant(args.request, context);
      }, TOOL_NAMES.DELEGATE_TO_ASSISTANT),
    }),
  };
}
