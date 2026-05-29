// src/sdk/healing.ts
// Message healing pipeline — sanitises conversation history before sending to DeepSeek.
// DeepSeek 400s on unpaired tool_calls / tool messages, missing thinking headers, etc.
import type { ChatMessage } from "./types.js";

export interface HealingOptions {
  /** Set to a thinking-capable model name to preserve/stamp reasoning_content.
   *  Set to null to strip droppable reasoning from non-thinking turns. */
  thinkingModeModel?: string | null;
}

export interface HealingResult {
  messages: ChatMessage[];
  healedCount: number;
  tokensSaved: number;
}

const MAX_RESULT_CHARS = 80_000;

// ---------------------------------------------------------------------------
// Pass 1: healPairs — drop dangling tool_calls without matching tool responses;
//         inject synthetic assistants before orphan tool responses.
// ---------------------------------------------------------------------------

function healPairs(messages: ChatMessage[]): {
  messages: ChatMessage[];
  healed: number;
} {
  let healed = 0;
  const out = [...messages];

  // Drop assistant messages with tool_calls that have no follow-up tool response.
  for (let i = out.length - 1; i >= 0; i--) {
    const msg = out[i]!;
    if (
      msg.role === "assistant" &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.length > 0
    ) {
      const hasResponse = out.some(
        (m, j) =>
          j > i &&
          m.role === "tool" &&
          msg.tool_calls!.some((tc) => tc.id === m.tool_call_id),
      );
      if (!hasResponse) {
        out.splice(i, 1);
        healed++;
      }
    }
  }

  // Inject synthetic assistant entries before orphan tool responses.
  for (let i = 0; i < out.length; i++) {
    const msg = out[i]!;
    if (msg.role === "tool" && msg.tool_call_id) {
      const hasPrior = out.some(
        (m, j) =>
          j < i &&
          m.role === "assistant" &&
          Array.isArray(m.tool_calls) &&
          m.tool_calls!.some((tc) => tc.id === msg.tool_call_id),
      );
      if (!hasPrior) {
        out.splice(i, 0, {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: msg.tool_call_id,
              type: "function" as const,
              function: {
                name: msg.name ?? "unknown",
                arguments: "{}",
              },
            },
          ],
        });
        healed++;
        i++; // skip the injected message
      }
    }
  }

  return { messages: out, healed };
}

// ---------------------------------------------------------------------------
// Pass 2: shrinkOversizedToolResults — truncate tool results > MAX_RESULT_CHARS
// ---------------------------------------------------------------------------

function shrinkOversizedToolResults(messages: ChatMessage[]): {
  messages: ChatMessage[];
  healed: number;
  tokensSaved: number;
} {
  let healed = 0;
  let tokensSaved = 0;
  const out = messages.map((m) => {
    if (
      m.role === "tool" &&
      typeof m.content === "string" &&
      m.content.length > MAX_RESULT_CHARS
    ) {
      healed++;
      tokensSaved += Math.ceil(
        (m.content.length - MAX_RESULT_CHARS) / 4,
      );
      return {
        ...m,
        content: m.content.slice(0, MAX_RESULT_CHARS) + "\n\n[truncated]",
      };
    }
    return m;
  });
  return { messages: out, healed, tokensSaved };
}

// ---------------------------------------------------------------------------
// Pass 3: stampMissingReasoning — add empty reasoning_content to ALL
//         assistant messages in thinking mode (DeepSeek requires it on
//         every assistant message, not just those with tool_calls).
// ---------------------------------------------------------------------------

function stampMissingReasoning(
  messages: ChatMessage[],
  opts: HealingOptions,
): { messages: ChatMessage[]; healed: number } {
  if (!opts.thinkingModeModel) return { messages, healed: 0 };
  let healed = 0;
  const out = messages.map((m) => {
    if (
      m.role === "assistant" &&
      m.reasoning_content === undefined
    ) {
      healed++;
      return { ...m, reasoning_content: "" };
    }
    return m;
  });
  return { messages: out, healed };
}

// ---------------------------------------------------------------------------
// Pass 4: stripDroppableReasoning — remove reasoning_content in non-thinking
//         mode to avoid prefix-cache churn from stale reasoning.
// ---------------------------------------------------------------------------

function stripDroppableReasoning(
  messages: ChatMessage[],
  opts: HealingOptions,
): { messages: ChatMessage[]; healed: number } {
  if (opts.thinkingModeModel) return { messages, healed: 0 };
  let healed = 0;
  const out = messages.map((m) => {
    if (
      m.role === "assistant" &&
      typeof m.reasoning_content === "string" &&
      m.reasoning_content.length > 0
    ) {
      healed++;
      const { reasoning_content: _, ...rest } = m as ChatMessage & {
        reasoning_content?: string;
      };
      return rest as ChatMessage;
    }
    return m;
  });
  return { messages: out, healed };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function healMessages(
  messages: ChatMessage[],
  opts: HealingOptions = {},
): HealingResult {
  let result: HealingResult = {
    messages: [...messages],
    healedCount: 0,
    tokensSaved: 0,
  };

  const pass1 = healPairs(result.messages);
  result.messages = pass1.messages;
  result.healedCount += pass1.healed;

  const pass2 = shrinkOversizedToolResults(result.messages);
  result.messages = pass2.messages;
  result.healedCount += pass2.healed;
  result.tokensSaved += pass2.tokensSaved;

  const pass3 = stampMissingReasoning(result.messages, opts);
  result.messages = pass3.messages;
  result.healedCount += pass3.healed;

  const pass4 = stripDroppableReasoning(result.messages, opts);
  result.messages = pass4.messages;
  result.healedCount += pass4.healed;

  return result;
}
