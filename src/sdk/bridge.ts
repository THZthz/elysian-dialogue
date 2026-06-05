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

// src/sdk/bridge.ts
// Converts internal Tool definitions (Zod-based) into our SDK's
// ToolSpec format (OpenAI-compatible JSON Schema).
//
// Zod v4 provides a built-in toJSONSchema() method on every schema,
// which handles all type conversions, constraint mappings, required
// field detection, and wrapper unwrapping (optional/nullable/default).

import type { z } from "zod";
import type { ToolSpec } from "@/sdk/types";

export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  execute: (args: z.infer<S>) => Promise<string>;
}

/**
 * Convert a Tool (with a Zod v4 schema) into an OpenAI-compatible
 * ToolSpec suitable for DeepSeek's API.
 */
export function toolToSpec(tool: Tool): ToolSpec {
  if (!tool?.schema || typeof tool.schema.toJSONSchema !== "function") {
    throw new Error(`toolToSpec: missing or invalid schema on tool "${tool?.name ?? "?"}"`);
  }
  const jsonSchema = tool.schema.toJSONSchema() as Record<string, unknown>;
  // Strip Zod-internal properties that aren't part of standard JSON Schema.

  const { "~standard": _std, _prefault: _pf, ...parameters } = jsonSchema;

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: parameters as Record<string, unknown>,
    },
  };
}
