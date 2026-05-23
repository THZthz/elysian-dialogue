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

import { streamText, stepCountIs, type ModelMessage, NoSuchToolError } from "ai";
import { jsonrepair } from "jsonrepair";
import { getModel } from "@/server/model";
import { buildAssistantSystemPrompt } from "@/server/assistant/prompt";
import { loadAssistantMessages, saveAssistantMessages } from "@/server/assistant/messages";
import { queryWorld } from "@/server/tools/queryWorld";
import { searchWorld } from "@/server/tools/searchWorld";
import { editNode } from "@/server/tools/editNode";
import { editRelationship } from "@/server/tools/editRelationship";
import { editNote } from "@/server/tools/editNote";
import { getContext } from "@/server/tools/getContext";
import { manageSchema } from "@/server/tools/manageSchema";
import { TOOL_NAMES } from "@/shared/constants";

export interface AssistantContext {
  recentConversation: string;
  gmToolCalls: string[];
  turnNumber: number;
}

const MAX_ASSISTANT_STEPS = 8;

const assistantTools = {
  queryWorld,
  searchWorld,
  editNode,
  editRelationship,
  editNote,
  getContext,
  manageSchema,
};

export async function delegateToAssistant(
  request: string,
  context: AssistantContext,
): Promise<string> {
  const systemPrompt = buildAssistantSystemPrompt();

  // Build context for enrichment (defensive against missing fields)
  const recentConv = context?.recentConversation || "(none)";
  const gmCalls = context?.gmToolCalls ?? [];
  const contextBlock = [
    "## Recent Conversation",
    recentConv,
    "",
    "## GM's Activity This Turn",
    gmCalls.length > 0 ? gmCalls.join(", ") : "(no tool calls yet)",
    "",
    "## GM's Request",
    request,
    "",
    "Execute the request. After answering, add a brief OBSERVATIONS section if you notice anything relevant to the GM.",
  ].join("\n");

  // Load previous assistant messages for stateful continuity
  let previousMessages: ModelMessage[] = [];
  try {
    previousMessages = await loadAssistantMessages();
  } catch (err) {
    console.error("[assistant] Failed to load message history:", err);
  }

  const { model } = getModel("assistant");

  try {
    const result = streamText({
      model,
      system: systemPrompt,
      messages: [...previousMessages, { role: "user" as const, content: contextBlock }],
      tools: assistantTools,
      stopWhen: [stepCountIs(MAX_ASSISTANT_STEPS)],
      experimental_repairToolCall: async ({ toolCall, error }) => {
        if (NoSuchToolError.isInstance(error)) return null;
        try {
          const inputStr =
            typeof toolCall.input === "string" ? toolCall.input : JSON.stringify(toolCall.input);
          const repaired = jsonrepair(inputStr);
          console.log(`[assistant] repaired ${toolCall.toolName} JSON`);
          return { ...toolCall, input: repaired };
        } catch {
          return null;
        }
      },
    });

    const response = await result.response;
    const responseText = response.messages
      .filter((m) => m.role === "assistant")
      .map((m) =>
        typeof m.content === "string"
          ? m.content
          : ((m.content as any[])?.map((part: any) => part.text ?? "").join("") ?? ""),
      )
      .join("\n")
      .trim();

    // Detect truncation: stepCountIs(8) stops with finishReason "stop", so check step count
    const stepCount = (response as any).steps?.length ?? 0;
    const wasTruncated = stepCount >= MAX_ASSISTANT_STEPS;

    const finalText = wasTruncated
      ? (responseText || "(no output)") + "\n\n[Assistant was truncated — result may be incomplete]"
      : responseText || "(no output)";

    // Save only new messages (delta), not the full history re-loaded above
    try {
      const prevCount = previousMessages.length;
      const newMessages = (response.messages as ModelMessage[]).slice(prevCount);
      await saveAssistantMessages(newMessages, context.turnNumber);
    } catch (err) {
      console.error("[assistant] Failed to save message history:", err);
    }

    return finalText;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[assistant] delegateToAssistant failed:", message);
    return `ERROR: Assistant failed: ${message}. The GM can retry or proceed without this information.`;
  }
}

export async function autoPersist(
  turnState: import("@/server/turnState").TurnStateMachine,
  turnNumber: number,
): Promise<void> {
  const systemPrompt = buildAssistantSystemPrompt();
  const dialogueParams = turnState.getDialogueParams();
  const toolCalls = turnState.getToolCallsForAssistant(true);

  const toolCallsText = toolCalls
    .map((tc) => {
      if (tc.params && Object.keys(tc.params).length > 0) {
        return `- ${tc.name}:\n    ${JSON.stringify(tc.params, null, 2).replace(/\n/g, "\n    ")}`;
      }
      return `- ${tc.name}`;
    })
    .join("\n");

  let dialogueText = "(no dialogue output)";
  if (dialogueParams) {
    const parts: string[] = [];
    if (dialogueParams.messages && dialogueParams.messages.length > 0) {
      parts.push("Messages:");
      for (const msg of dialogueParams.messages) {
        parts.push(`  - [${msg.speaker}] (${msg.type}): ${msg.text}`);
      }
    }
    if (dialogueParams.options && dialogueParams.options.length > 0) {
      parts.push("Options:");
      for (const opt of dialogueParams.options) {
        parts.push(
          `  - ${opt.text}${opt.check ? ` [${opt.check.skill} check, difficulty ${opt.check.difficulty}]` : ""}`,
        );
      }
    }
    dialogueText = parts.join("\n");
  }

  const persistPrompt = [
    `## TURN ${turnNumber} — AUTO PERSIST`,
    "",
    "## GM's Activity This Turn",
    toolCallsText || "(no tool calls)",
    "",
    "## Dialogue Output",
    dialogueText,
    "",
    "## Instructions",
    "Review the GM's dialogue and tool calls above. Identify and persist world state changes:",
    "- Location changes (entities moved between places)",
    "- Item movements (objects picked up, dropped, transferred)",
    "- Disposition shifts (character attitudes toward the player or each other)",
    "- Plot triggers and status changes (flags set, branches activated)",
    "- Time-sensitive events that should be recorded",
    "",
    "Inspect current state with your tools, then create, update, or delete as needed.",
    "Confirm what you persisted at the end.",
  ].join("\n");

  let previousMessages: ModelMessage[] = [];
  try {
    previousMessages = await loadAssistantMessages();
  } catch (err) {
    console.error("[autoPersist] Failed to load message history:", err);
  }

  const { model } = getModel("assistant");

  const result = streamText({
    model,
    system: systemPrompt,
    messages: [...previousMessages, { role: "user" as const, content: persistPrompt }],
    tools: assistantTools,
    stopWhen: [stepCountIs(MAX_ASSISTANT_STEPS)],
    experimental_repairToolCall: async ({ toolCall, error }) => {
      if (NoSuchToolError.isInstance(error)) return null;
      try {
        const inputStr =
          typeof toolCall.input === "string" ? toolCall.input : JSON.stringify(toolCall.input);
        const repaired = jsonrepair(inputStr);
        console.log(`[autoPersist] repaired ${toolCall.toolName} JSON`);
        return { ...toolCall, input: repaired };
      } catch {
        return null;
      }
    },
  });

  const response = await result.response;

  try {
    const prevCount = previousMessages.length;
    const newMessages = (response.messages as ModelMessage[]).slice(prevCount);
    await saveAssistantMessages(newMessages, turnNumber);
  } catch (err) {
    console.error("[autoPersist] Failed to save message history:", err);
  }
}
