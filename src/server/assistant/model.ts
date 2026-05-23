import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel, type LanguageModel } from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";

let assistantModelInstance: LanguageModel | null = null;
let assistantModelName: string | null = null;

function buildAssistantModel(): LanguageModel {
  const provider = process.env.ASSISTANT_PROVIDER || process.env.LLM_PROVIDER || "deepseek";
  const modelName = process.env.ASSISTANT_MODEL || process.env.LLM_MODEL || "deepseek-v4-flash";

  if (provider === "google" || provider === "gemini") {
    if (!process.env.GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY for assistant");
    const raw = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY })(
      process.env.GOOGLE_MODEL || "gemini-3.1-pro-preview"
    );
    return wrapLanguageModel({ model: raw, middleware: devToolsMiddleware() });
  }

  if (provider === "openrouter") {
    if (!process.env.OPENROUTER_API_KEY) throw new Error("Missing OPENROUTER_API_KEY for assistant");
    const raw = createOpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    })(process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.6");
    return wrapLanguageModel({ model: raw, middleware: devToolsMiddleware() });
  }

  // deepseek (default)
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("Missing DEEPSEEK_API_KEY for assistant");
  const raw = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY })(modelName);
  return wrapLanguageModel({ model: raw, middleware: devToolsMiddleware() });
}

export function getAssistantModel(): { model: LanguageModel; name: string } {
  if (!assistantModelInstance) {
    assistantModelInstance = buildAssistantModel();
    assistantModelName = process.env.ASSISTANT_MODEL || process.env.LLM_MODEL || "deepseek-v4-flash";
  }
  return { model: assistantModelInstance, name: assistantModelName };
}
