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
// Pass 0: stampMissingIds — stamp IDs on tool_calls that lack them.
//         DeepSeek 400s on tool_calls without `id`.
// ---------------------------------------------------------------------------

let _stampSeq = 0;

function stampMissingIds(messages: ChatMessage[]): {
  messages: ChatMessage[];
  healed: number;
} {
  let healed = 0;
  const out = messages.map((m) => {
    if (
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0
    ) {
      const stamped = m.tool_calls.map((tc) => {
        if (!tc.id) {
          healed++;
          return { ...tc, id: `z-ext-${Date.now()}-${_stampSeq++}` };
        }
        return tc;
      });
      return { ...m, tool_calls: stamped };
    }
    return m;
  });
  return { messages: out, healed };
}

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
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const hasResponse = out.some(
        (m, j) =>
          j > i && m.role === "tool" && msg.tool_calls!.some((tc) => tc.id === m.tool_call_id),
      );
      if (!hasResponse) {
        out.splice(i, 1);
        healed++;
      }
    }
  }

  // Drop orphan tool responses with no matching assistant.
  // DeepSeek 400s on tool messages without a prior assistant.tool_calls.
  const out2 = out.filter((m, i) => {
    if (m.role !== "tool" || !m.tool_call_id) return true;
    return out.some(
      (prev, j) =>
        j < i &&
        prev.role === "assistant" &&
        Array.isArray(prev.tool_calls) &&
        prev.tool_calls!.some((tc) => tc.id === m.tool_call_id),
    );
  });
  if (out2.length < out.length) healed += out.length - out2.length;
  return { messages: out2, healed };
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
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > MAX_RESULT_CHARS) {
      healed++;
      tokensSaved += Math.ceil((m.content.length - MAX_RESULT_CHARS) / 4);
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
    if (m.role === "assistant" && m.reasoning_content === undefined) {
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

/** Strip hallucinated DSML / function_calls markup from model prose content.
 *  Thinking-mode models may emit `<function_calls>` or `<|DSML|function_calls>`
 *  markup even when tools are undefined. */
const DSML_REGEX =
  /<\|?DSML\|?\s*function_calls>[\s\S]*?<\/\|?DSML\|?\s*function_calls>/gi;
const FUNC_CALLS_REGEX = /<function_calls>[\s\S]*?<\/function_calls>/gi;
// Full-width "｜" is the form R1 emits in practice.
const FULLWIDTH_DSML_REGEX =
  /<｜DSML｜function_calls>[\s\S]*?<\/?｜DSML｜function_calls>/g;
const LONE_OPEN_REGEX = /<｜DSML｜[\s\S]*$/g;

export function stripHallucinatedToolMarkup(content: string): string {
  return content
    .replace(FULLWIDTH_DSML_REGEX, "")
    .replace(DSML_REGEX, "")
    .replace(FUNC_CALLS_REGEX, "")
    .replace(LONE_OPEN_REGEX, "")
    .trim();
}

export function healMessages(messages: ChatMessage[], opts: HealingOptions = {}): HealingResult {
  let result: HealingResult = {
    messages: [...messages],
    healedCount: 0,
    tokensSaved: 0,
  };

  const pass0 = stampMissingIds(result.messages);
  result.messages = pass0.messages;
  result.healedCount += pass0.healed;

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
