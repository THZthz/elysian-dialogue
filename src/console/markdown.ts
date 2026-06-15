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

import MarkdownIt from "markdown-it-ts";
import type { Token } from "markdown-it-ts";
import chalk from "chalk";

const md = MarkdownIt({ experimental: { stream: true } });

/**
 * CommonMark: a trailing * or _ preceded by punctuation cannot close emphasis
 * unless followed by whitespace or punctuation (§6.2 right-flanking rule).
 * Append a space so the delimiter becomes valid, then trim it from output.
 */
function safeForEmphasisClose(text: string): string {
  return /[^\w\s][*_]$/.test(text) ? text + " " : text;
}

export function renderMarkdown(text: string): string {
  if (!text) return "";
  const tokens = md.parse(safeForEmphasisClose(text));
  return renderTokens(tokens);
}

export function createStreamRenderer() {
  return {
    render(text: string): string {
      if (!text) return "";
      const tokens = md.stream.parse(safeForEmphasisClose(text));
      return renderTokens(tokens);
    },
    reset() {
      md.stream.reset();
    },
  };
}

function renderTokens(tokens: Token[]): string {
  let output = "";
  let inHeading = false;
  let inBlockquote = false;
  let listDepth = 0;
  let ordered = false;
  let itemIndex = 0;

  for (const token of tokens) {
    switch (token.type) {
      case "inline": {
        let inlineOutput = renderInline(token.children ?? []);
        if (inHeading) inlineOutput = chalk.bold(inlineOutput);
        if (inBlockquote) inlineOutput = chalk.dim("│ ") + inlineOutput;
        output += inlineOutput;
        break;
      }
      case "heading_open":
        inHeading = true;
        break;
      case "heading_close":
        inHeading = false;
        output += "\n";
        break;
      case "paragraph_open":
        break;
      case "paragraph_close":
        output += "\n";
        break;
      case "blockquote_open":
        inBlockquote = true;
        break;
      case "blockquote_close":
        inBlockquote = false;
        break;
      case "bullet_list_open":
        listDepth++;
        break;
      case "bullet_list_close":
        listDepth--;
        break;
      case "ordered_list_open":
        ordered = true;
        itemIndex = 0;
        listDepth++;
        break;
      case "ordered_list_close":
        ordered = false;
        listDepth--;
        break;
      case "list_item_open": {
        itemIndex++;
        const indent = "  ".repeat(listDepth - 1);
        const marker = ordered ? `${itemIndex}. ` : "• ";
        output += indent + marker;
        break;
      }
      case "list_item_close":
        break;
      case "fence":
      case "code_block":
        output += chalk.dim(token.content.trimEnd()) + "\n";
        break;
      case "hr":
        output += chalk.dim("─".repeat(40)) + "\n";
        break;
    }
  }

  return output.trimEnd();
}

function renderInline(tokens: Token[]): string {
  let output = "";
  const formatStack: Array<(s: string) => string> = [];

  for (const token of tokens) {
    switch (token.type) {
      case "text":
        output += applyFormat(token.content, formatStack);
        break;
      case "code_inline":
        output += chalk.cyan(token.content);
        break;
      case "strong_open":
        formatStack.push(chalk.bold);
        break;
      case "strong_close":
        formatStack.pop();
        break;
      case "em_open":
        formatStack.push(chalk.italic);
        break;
      case "em_close":
        formatStack.pop();
        break;
      case "s_open":
        formatStack.push(chalk.strikethrough);
        break;
      case "s_close":
        formatStack.pop();
        break;
      case "softbreak":
      case "hardbreak":
        output += "\n";
        break;
      case "link_open":
      case "link_close":
        break;
      case "image":
        output += chalk.dim(`[${token.content || "image"}]`);
        break;
    }
  }

  return output;
}

function applyFormat(text: string, stack: Array<(s: string) => string>): string {
  let result = text;
  for (let i = stack.length - 1; i >= 0; i--) {
    result = stack[i](result);
  }
  return result;
}
