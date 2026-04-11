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
        let hint = "";
        if (response.status === 500) {
          hint =
            " — likely a context window overflow or the model crashed. Try 'New chat' to clear history.";
        } else if (response.status === 400) {
          hint = " — malformed request. Check the model name in your config.";
        } else if (response.status === 404) {
          hint = " — endpoint not found. Check the baseUrl in your config.";
        }
        yield {
          type: "error",
          error: `Request failed: ${response.status} ${response.statusText}${hint}`,
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
    if (options?.abortSignal?.aborted) {
      yield { type: "error", error: "Request aborted before send" };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }

    // Hit /v1/completions directly. This matters for completion-only
    // base models (e.g. Qwen2.5-Coder GGUFs) where /v1/chat/completions
    // wraps the prompt in a chat template the base model wasn't trained
    // on, producing weird output. The legacy /v1/completions endpoint
    // sends the prompt verbatim, which is what FIM-aware completion
    // models expect.
    const url = this.joinUrl("/completions");
    const body = {
      model: this.config.model,
      prompt,
      stream: true,
      temperature: options?.temperature ?? this.config.temperature,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      stop: options?.stop,
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: options?.abortSignal,
      });

      // Some servers don't expose /v1/completions; fall back to /v1/chat
      // so the autocomplete still produces something.
      if (response.status === 404) {
        yield* this.chat([{ role: "user", content: prompt }], {
          abortSignal: options?.abortSignal,
          temperature: options?.temperature,
          maxTokens: options?.maxTokens,
        });
        return;
      }

      if (!response.ok || !response.body) {
        yield {
          type: "error",
          error: `Completion request failed: ${response.status} ${response.statusText}`,
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

  /**
   * Query the /v1/models endpoint for available models.
   * Works with vLLM, llama.cpp, and any OpenAI-compatible server.
   */
  async listModels(): Promise<Array<{ id: string; name: string }>> {
    try {
      const headers: Record<string, string> = {};
      const apiKey = this.config.apiKey;
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const res = await fetch(this.joinUrl("/models"), { headers });
      if (!res.ok) return [];
      const data = (await res.json()) as {
        data?: Array<{ id: string }>;
      };
      return (data.data ?? []).map((m) => ({ id: m.id, name: m.id }));
    } catch {
      return [];
    }
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
                  // /v1/chat/completions shape:
                  delta?: { content?: string };
                  // /v1/completions shape:
                  text?: string;
                  finish_reason?: string | null;
                }>;
                usage?: { prompt_tokens?: number; completion_tokens?: number };
              };
              const choice = json.choices?.[0];
              // Handle both shapes so this parser works for chat and
              // legacy completions responses without branching at the
              // call site.
              const text = choice?.delta?.content ?? choice?.text;
              if (text) {
                yield { type: "text", text };
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
    // Trim to fit the context window — llama.cpp and small vLLM
    // instances return 500 Internal Server Error when exceeded.
    // Keep a generous budget for the response, trim from the start
    // (oldest user/assistant pairs) while preserving the system message
    // and the last few turns.
    const trimmed = this.trimForContext(messages);
    const result: Array<Record<string, unknown>> = [];
    for (const msg of trimmed) {
      const content = this.flattenContent(msg.content);
      // Skip empty-content messages (e.g. assistant turns that only
      // contained tool calls). Many OpenAI-compatible servers reject
      // them with 400/500.
      if (!content.trim()) continue;
      // Normalize 'tool' role to 'user' for broad compatibility —
      // llama.cpp and some vLLM builds don't accept 'tool' role.
      let role: string = msg.role;
      if (role === "tool") role = "user";
      if (role !== "system" && role !== "user" && role !== "assistant") {
        role = "user";
      }
      result.push({ role, content });
    }
    return result;
  }

  /**
   * Trim messages to fit within the context window. Keeps the system
   * message (if any) plus the most recent turns up to ~75% of the
   * context budget, leaving room for the response.
   */
  private trimForContext(messages: LLMMessage[]): LLMMessage[] {
    // Rough token estimate: 4 chars per token. Conservative.
    const estimate = (m: LLMMessage): number => {
      const content =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return Math.ceil(content.length / 4) + 10; // +10 for role/overhead
    };
    // Budget: 75% of model's contextWindow, or default 3000 tokens
    // if no contextWindow is known.
    const modelInfo = this.modelInfo();
    const ctxWindow = modelInfo.contextWindow || 4096;
    const budget = Math.floor(ctxWindow * 0.75);

    let totalTokens = 0;
    const kept: LLMMessage[] = [];
    // Always keep the system message if it's first.
    let startIdx = 0;
    if (messages[0]?.role === "system") {
      kept.push(messages[0]);
      totalTokens += estimate(messages[0]);
      startIdx = 1;
    }
    // Walk backwards from the newest message, keeping what fits.
    const recent: LLMMessage[] = [];
    for (let i = messages.length - 1; i >= startIdx; i--) {
      const tokens = estimate(messages[i]);
      if (totalTokens + tokens > budget) break;
      totalTokens += tokens;
      recent.unshift(messages[i]);
    }
    return [...kept, ...recent];
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
