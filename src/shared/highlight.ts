import { highlight } from "cli-highlight";

export function highlightJson(text: string): string {
  let formatted = text;
  try {
    formatted = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // not valid JSON, try highlighting raw anyway
  }
  return highlight(formatted, { language: "json" });
}

export function highlightMarkdown(text: string): string {
  return highlight(text, { language: "markdown" });
}
