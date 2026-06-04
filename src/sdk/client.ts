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

// src/sdk/client.ts
import { type Readable } from "node:stream";
import axios, { type AxiosInstance } from "axios";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import type { ChatOptions, ChatResponse, StreamChunk, ToolCall, RawUsage } from "@/sdk/types";
import { Usage } from "@/sdk/types";

export interface DeepSeekClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  axiosInstance?: AxiosInstance;
}

function replaceLoneSurrogates(value: string): string {
  let out = "";
  let last = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
      } else {
        out += value.slice(last, i);
        out += "�";
        last = i + 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += value.slice(last, i);
      out += "�";
      last = i + 1;
    }
  }
  if (last === 0) return value;
  return out + value.slice(last);
}

function sanitizeJsonTransport(value: unknown): unknown {
  if (typeof value === "string") return replaceLoneSurrogates(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonTransport(item));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = sanitizeJsonTransport(item);
  }
  return out;
}

function stringifyJsonTransport(value: unknown): string {
  return JSON.stringify(sanitizeJsonTransport(value));
}

function buildPayload(opts: ChatOptions, stream: boolean): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    stream,
  };
  if (stream) payload.stream_options = { include_usage: true };
  if (opts.tools?.length) payload.tools = opts.tools;
  if (opts.maxTokens !== undefined) payload.max_tokens = opts.maxTokens;
  if (opts.thinking) {
    payload.extra_body = { thinking: { type: opts.thinking } };
  }
  if (opts.reasoningEffort) {
    payload.reasoning_effort = opts.reasoningEffort;
  }
  return payload;
}

function isUsageObject(raw: unknown): raw is RawUsage {
  if (!raw || typeof raw !== "object") return false;
  const u = raw as Record<string, unknown>;
  return (
    typeof u.prompt_tokens === "number" ||
    typeof u.completion_tokens === "number" ||
    typeof u.total_tokens === "number" ||
    typeof u.prompt_cache_hit_tokens === "number" ||
    typeof u.prompt_cache_miss_tokens === "number" ||
    typeof u.prompt_eval_count === "number" ||
    typeof u.eval_count === "number"
  );
}

export class DeepSeekClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly _axios: AxiosInstance;

  constructor(opts: DeepSeekClientOptions) {
    const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "DEEPSEEK_API_KEY is not set. Put it in .env or pass apiKey to DeepSeekClient.",
      );
    }
    this.apiKey = apiKey;
    let url = opts.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
    while (url.endsWith("/")) url = url.slice(0, -1);
    this.baseUrl = url;
    this.timeoutMs = opts.timeoutMs ?? 660_000; // 11 min
    this._axios = opts.axiosInstance ?? axios.create({ timeout: this.timeoutMs });
  }

  private handleAxiosError(err: unknown): never {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status ?? 0;
      const body =
        typeof err.response?.data === "object"
          ? JSON.stringify(err.response.data)
          : (err.response?.data ?? err.message);
      throw new Error(`DeepSeek ${status}: ${body}`);
    }
    throw err;
  }

  async chat(opts: ChatOptions): Promise<ChatResponse> {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new Error(`DeepSeek request timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    const signal = opts.signal
      ? AbortSignal.any([opts.signal as AbortSignal, ctrl.signal])
      : ctrl.signal;

    try {
      const resp = await this._axios.post(
        `${this.baseUrl}/chat/completions`,
        stringifyJsonTransport(buildPayload(opts, false)),
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          signal,
        },
      );
      const data = resp.data as Record<string, unknown>;
      const choice =
        ((data.choices as Array<Record<string, unknown>>)?.[0]?.message as Record<
          string,
          unknown
        >) ?? {};
      return {
        content: (choice.content as string) ?? "",
        reasoningContent: (choice.reasoning_content as string) ?? null,
        toolCalls: (choice.tool_calls as ToolCall[]) ?? [],
        usage: Usage.fromApi((data.usage ?? data) as RawUsage),
      };
    } catch (err) {
      this.handleAxiosError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  async *stream(opts: ChatOptions): AsyncGenerator<StreamChunk> {
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new Error(`DeepSeek stream timed out after ${this.timeoutMs}ms`)),
      this.timeoutMs,
    );
    const signal = opts.signal
      ? AbortSignal.any([opts.signal as AbortSignal, ctrl.signal])
      : ctrl.signal;

    let stream: Readable;
    try {
      const resp = await this._axios.post(
        `${this.baseUrl}/chat/completions`,
        stringifyJsonTransport(buildPayload(opts, true)),
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          signal,
          responseType: "stream",
        },
      );
      stream = resp.data;
    } catch (err) {
      clearTimeout(timer);
      this.handleAxiosError(err);
    }

    const queue: StreamChunk[] = [];
    let done = false;
    const parser = createParser({
      onEvent: (ev: EventSourceMessage) => {
        if (!ev.data || ev.data === "[DONE]") {
          done = true;
          return;
        }
        try {
          const json = JSON.parse(ev.data) as Record<string, unknown>;
          const delta =
            ((json.choices as Array<Record<string, unknown>>)?.[0]?.delta as Record<
              string,
              unknown
            >) ?? {};
          const finishReason = (json.choices as Array<Record<string, unknown>>)?.[0]
            ?.finish_reason as string | undefined;
          const chunk: StreamChunk = { raw: json, finishReason };
          if (typeof delta.content === "string" && delta.content.length > 0) {
            chunk.contentDelta = delta.content;
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            chunk.reasoningDelta = delta.reasoning_content;
          }
          if (
            Array.isArray(delta.tool_calls) &&
            (delta.tool_calls as Array<Record<string, unknown>>).length > 0
          ) {
            const tc = (delta.tool_calls as Array<Record<string, unknown>>)[0]!;
            chunk.toolCallDelta = {
              index: (tc.index as number) ?? 0,
              id: tc.id as string | undefined,
              name: tc.function
                ? ((tc.function as Record<string, unknown>).name as string)
                : undefined,
              argumentsDelta: tc.function
                ? ((tc.function as Record<string, unknown>).arguments as string)
                : undefined,
            };
          }
          if (json.usage || isUsageObject(json)) {
            chunk.usage = Usage.fromApi((json.usage ?? json) as RawUsage);
          }
          queue.push(chunk);
        } catch {
          /* skip malformed sse frame */
        }
      },
    });

    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        parser.feed(decoder.decode(buf, { stream: true }));
        while (queue.length > 0) yield queue.shift()!;
        if (done) break;
      }
      while (queue.length > 0) yield queue.shift()!;
    } catch (readErr) {
      const cause = readErr instanceof Error ? readErr : new Error(String(readErr));
      throw Object.assign(new Error(`SSE body read failed: ${cause.message}`), {
        phase: "stream_body_read" as const,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
