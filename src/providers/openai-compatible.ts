/**
 * OpenAICompatibleProvider: generic SSE-based OpenAI-compatible client.
 *
 * Works with any server exposing /v1/chat/completions in OpenAI's
 * streaming format: vLLM, llama.cpp server, text-generation-webui,
 * LM Studio, etc. Unlike OpenAIProvider (which uses the SDK), this
 * provider uses bare fetch so it has no dependency on the SDK's
 * configuration validation, making it more forgiving of non-standard
 * servers.
 */
import type {
  LLMProvider,
  LLMProviderConfig,
  LLMMessage,
  ChatOptions,
  CompleteOptions,
  StreamDelta,
  ModelInfo,
  ContentBlock,
} from "./types";

const DEFAULT_CONTEXT_WINDOW = 8192;

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly config: LLMProviderConfig;

  constructor(config: LLMProviderConfig, nameOverride?: string) {
    this.name = nameOverride ?? config.provider ?? "openai-compatible";
    this.config = config;
  }

  supportsToolUse(): boolean {
    // Many OpenAI-compatible servers claim tool support but implement it
    // inconsistently. Default to false; callers that know their server
    // supports tools can override by constructing with a custom config.
    return false;
  }

  supportsStreaming(): boolean {
    return true;
  }

  countTokens(text: string): number {
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
  }

  modelInfo(): ModelInfo {
    return {
      id: this.config.model,
      name: this.config.model,
      provider: this.name,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: this.config.maxTokens,
      supportsToolUse: this.supportsToolUse(),
      supportsImages: false,
      supportsStreaming: true,
    };
  }

  async *chat(
    messages: LLMMessage[],
    options?: ChatOptions,
  ): AsyncIterable<StreamDelta> {
    if (options?.abortSignal?.aborted) {
      yield { type: "error", error: "Request aborted before send" };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }

    const url = this.joinUrl("/chat/completions");
    const body = {
      model: this.config.model,
      messages: this.convertMessages(messages),
      stream: true,
      temperature: options?.temperature ?? this.config.temperature,
      top_p: options?.topP ?? this.config.topP,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      tools: options?.tools?.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: options?.abortSignal,
      });

      if (!response.ok || !response.body) {
        yield {
          type: "error",
          error: `Request failed: ${response.status} ${response.statusText}`,
        };
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
        return;
      }

      yield* this.parseSseStream(response.body, options?.abortSignal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: message };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    }
  }

  async *complete(
    prompt: string,
    options?: CompleteOptions,
  ): AsyncIterable<StreamDelta> {
    yield* this.chat([{ role: "user", content: prompt }], {
      abortSignal: options?.abortSignal,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
    });
  }

  dispose(): void {
    // Stateless fetch; nothing to release.
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.config.customHeaders ?? {}),
    };
    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  private joinUrl(path: string): string {
    const base = (this.config.baseUrl ?? "").replace(/\/+$/, "");
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${base}${suffix}`;
  }

  private async *parseSseStream(
    body: ReadableStream<Uint8Array>,
    abortSignal?: AbortSignal,
  ): AsyncIterable<StreamDelta> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let done = false;

    try {
      while (!done) {
        if (abortSignal?.aborted) {
          yield { type: "error", error: "Request aborted" };
          break;
        }

        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by blank lines.
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          const lines = event.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") {
              done = true;
              break;
            }
            try {
              const json = JSON.parse(payload) as {
                choices?: Array<{
                  delta?: { content?: string };
                  finish_reason?: string | null;
                }>;
                usage?: { prompt_tokens?: number; completion_tokens?: number };
              };
              const delta = json.choices?.[0]?.delta;
              if (delta?.content) {
                yield { type: "text", text: delta.content };
              }
              if (json.usage) {
                inputTokens = json.usage.prompt_tokens ?? inputTokens;
                outputTokens = json.usage.completion_tokens ?? outputTokens;
              }
            } catch {
              // Skip malformed SSE payloads.
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: "done", usage: { inputTokens, outputTokens } };
  }

  private convertMessages(
    messages: LLMMessage[],
  ): Array<Record<string, unknown>> {
    return messages.map((msg) => {
      if (msg.role === "tool") {
        return {
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: this.flattenContent(msg.content),
        };
      }
      return {
        role: msg.role,
        content: this.flattenContent(msg.content),
      };
    });
  }

  private flattenContent(content: string | ContentBlock[]): string {
    if (typeof content === "string") return content;
    return content
      .map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "tool_result") return block.content;
        return "";
      })
      .join("");
  }
}
