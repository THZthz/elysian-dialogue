// src/sdk/bridge.ts
// Converts Vercel AI SDK tool() output (Zod-based) into our SDK's
// ToolSpec format (OpenAI-compatible JSON Schema).
//
// Zod v4 provides a built-in toJSONSchema() method on every schema,
// which handles all type conversions, constraint mappings, required
// field detection, and wrapper unwrapping (optional/nullable/default).

import type { ToolSpec } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VercelToolLike {
  name?: string;
  title?: string;
  description?: string;
  /** The Zod schema (or JSON Schema object) for the tool's parameters. */
  parameters?: unknown;
  execute?: (...args: any[]) => any;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a value looks like a Zod v4 schema (has the toJSONSchema method).
 */
function isZodSchema(value: unknown): value is { toJSONSchema: (params?: Record<string, unknown>) => Record<string, unknown> } {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).toJSONSchema === "function"
  );
}

/**
 * Check whether a value looks like a pre-built JSON Schema object.
 */
function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return obj.type === "object" && obj.properties != null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a Vercel AI SDK tool (or tool-like object with a Zod schema) into
 * an OpenAI-compatible ToolSpec suitable for DeepSeek's API.
 *
 * - Extracts the tool name from `.name` (primary) or `.title` (fallback).
 * - Converts Zod v4 schemas to JSON Schema via the built-in `toJSONSchema()`
 *   method, which handles all Zod types, constraints, and wrapper unwrapping.
 * - Accepts pre-built JSON Schema objects as-is.
 */
export function vercelToolToSpec(tool: VercelToolLike): ToolSpec {
  const name = tool.name || tool.title || "unnamed";
  const description = tool.description ?? "";
  let parameters: Record<string, unknown> = {
    type: "object",
    properties: {},
  };

  const params = tool.parameters;

  if (isZodSchema(params)) {
    // Zod v4 — use the built-in toJSONSchema(). io defaults to "output",
    // which marks .default() fields as non-required (the model may omit them).
    const jsonSchema = params.toJSONSchema() as Record<string, unknown>;
    if (jsonSchema && typeof jsonSchema === "object") {
      // Strip Zod-internal properties that aren't part of standard JSON Schema.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { "~standard": _std, _prefault: _pf, ...clean } = jsonSchema;
      parameters = clean;
    }
  } else if (isJsonSchemaObject(params)) {
    // Already a JSON Schema object — use as-is.
    parameters = params;
  }

  return {
    type: "function",
    function: {
      name,
      description,
      parameters,
    },
  };
}
