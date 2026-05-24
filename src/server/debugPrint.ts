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

import chalk from "chalk";
import type { StepResult } from "ai";

type DebugScope = "GM" | "GM → Assistant" | "AUTO-PERSIST";

const DEBUG = process.env.DEBUG_PRINT_ALL_LLM_STEPS === "true";

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...(truncated)";
}

function formatToolCall(tc: {
  toolName: string;
  input: unknown;
}): string {
  const name = chalk.green(`→ ${tc.toolName}`);
  const input = truncate(JSON.stringify(tc.input), 500);
  return `    ${name}\n      ${chalk.dim(input)}`;
}

function formatToolResult(tr: {
  toolName: string;
  input: unknown;
  output: unknown;
}): string {
  const name = `    ← ${tr.toolName}`;
  const input = chalk.dim(`in:  ${truncate(JSON.stringify(tr.input), 300)}`);
  const output = chalk.dim(`out: ${truncate(JSON.stringify(tr.output), 500)}`);
  return `${name}\n      ${input}\n      ${output}`;
}

function printStep(scope: DebugScope, event: StepResult<any>): void {
  const lines: string[] = [];

  lines.push("");
  lines.push(chalk.bold.cyan(`━━━━━ ${scope} Step ${event.stepNumber} ━━━━━`));

  if (event.reasoningText) {
    lines.push("");
    lines.push(chalk.bold.yellow("[Reasoning]"));
    lines.push(chalk.dim(event.reasoningText.trimEnd()));
  }

  if (event.text) {
    lines.push("");
    lines.push(chalk.bold.white("[Text]"));
    lines.push(event.text.trimEnd());
  }

  if (event.toolCalls.length > 0) {
    lines.push("");
    lines.push(chalk.bold.yellow("[Tool Calls]"));
    for (const tc of event.toolCalls) {
      lines.push(formatToolCall(tc));
    }
  }

  if (event.toolResults.length > 0) {
    lines.push("");
    lines.push(chalk.bold.magenta("[Tool Results]"));
    for (const tr of event.toolResults) {
      lines.push(formatToolResult(tr));
    }
  }

  console.log(lines.join("\n"));
}

export function createDebugOnStepFinish(scope: DebugScope) {
  if (!DEBUG) return undefined;
  return (event: StepResult<any>) => {
    printStep(scope, event);
  };
}
