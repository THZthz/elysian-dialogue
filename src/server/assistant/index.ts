import { streamText, stepCountIs, type ModelMessage, NoSuchToolError } from "ai";
import { jsonrepair } from "jsonrepair";
import { getAssistantModel } from "@/server/assistant/model";
import { buildAssistantSystemPrompt } from "@/server/assistant/prompt";
import { loadAssistantMessages, saveAssistantMessages } from "@/server/assistant/messages";
import { queryWorld } from "@/server/llm/tools/queryWorld";
import { searchWorld } from "@/server/llm/tools/searchWorld";
import { editNode } from "@/server/llm/tools/editNode";
import { editRelationship } from "@/server/llm/tools/editRelationship";
import { editNote } from "@/server/llm/tools/editNote";
import { getContext } from "@/server/llm/tools/getContext";
import { manageSchema } from "@/server/llm/tools/manageSchema";
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

  const { model } = getAssistantModel();

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
            typeof toolCall.input === "string"
              ? toolCall.input
              : JSON.stringify(toolCall.input);
          const repaired = jsonrepair(inputStr);
          console.log(`[assistant] repaired ${toolCall.toolName} JSON`);
          return { ...toolCall, input: repaired };
        } catch {
          return null;
        }
      },
    });

    const response = await result.response;
    const responseText =
      response.messages
        .filter((m) => m.role === "assistant")
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : (m.content as any[])
                ?.map((part: any) => part.text ?? "")
                .join("") ?? "",
        )
        .join("\n")
        .trim();

    // Detect truncation: stepCountIs stops with finishReason "stop", so check step count
    const stepCount = (response as any).steps?.length ?? 0;
    const wasTruncated =
      response.finishReason === "length" || stepCount >= MAX_ASSISTANT_STEPS;

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
