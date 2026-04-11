/**
 * OllamaProvider: local LLM via Ollama.
 *
 * Ollama exposes two APIs: a native REST interface at /api/chat and
 * /api/generate, and an OpenAI-compatible interface at /v1/chat/completions.
 * This provider uses the native interface because it gives finer control
 * over streaming and model management.
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
  ToolCall,
} from "./types";

const DEFAULT_BASE_URL = "http://localhost:11434";

/**
 * Known models that support native tool calling in Ollama. For unknown
 * models, the prompt-based XML tool calling fallback should be used.
 */
/**
 * Models that support Ollama's native tool calling API (not just
 * text-based tool tokens). Qwen models use their own special token
 * format (<｜tool▁calls▁begin｜>) which our prompt-based parser
 * handles — they should NOT be in this list.
 */
const TOOL_CALLING_MODELS = new Set([
  "llama3.1",
  "llama3.1:8b",
  "llama3.1:70b",
  "llama3.2",
  "llama3.3",
  "mistral-nemo",
  "mistral-large",
  "command-r",
  "command-r-plus",
  "firefunction-v2",
]);

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  readonly config: LLMProviderConfig;

  constructor(config: LLMProviderConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
    };
  }

  supportsToolUse(): boolean {
    const baseModel = this.config.model.split(":")[0];
    return (
      TOOL_CALLING_MODELS.has(this.config.model) ||
      TOOL_CALLING_MODELS.has(baseModel)
    );
  }

  supportsStreaming(): boolean {
    return true;
  }

  countTokens(text: string): number {
    // Rough approximation for tokens. Ollama exposes /api/tokenize in some
    // versions, but hitting it per-call would be too expensive for context
    // decisions. Character-based estimate is accurate enough.
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
  }

  private detectedContextWindow: number | null = null;
  private contextDetectionPromise: Promise<void> | null = null;

  modelInfo(): ModelInfo {
    if (this.detectedContextWindow === null && !this.contextDetectionPromise) {
      this.contextDetectionPromise = this.detectContextWindow();
    }
    return {
      id: this.config.model,
      name: this.config.model,
      provider: "ollama",
      contextWindow: this.detectedContextWindow ?? 8192,
      maxOutputTokens: this.config.maxTokens,
      supportsToolUse: this.supportsToolUse(),
      supportsImages: false,
      supportsStreaming: true,
    };
  }

  /**
   * Query Ollama's /api/show endpoint for model metadata including
   * the context length. Returns something like:
   *   { model_info: { "llama.context_length": 32768, ... } }
   */
  private async detectContextWindow(): Promise<void> {
    try {
      const res = await fetch(`${this.config.baseUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: this.config.model }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          model_info?: Record<string, unknown>;
          parameters?: string;
        };
        // Look for *.context_length in model_info (key prefix varies:
        // llama.context_length, qwen2.context_length, etc.)
        if (data.model_info) {
          for (const [key, value] of Object.entries(data.model_info)) {
            if (key.endsWith(".context_length") && typeof value === "number") {
              this.detectedContextWindow = value;
              console.log(
                `Champ: detected Ollama context window ${value} from /api/show (${key})`,
              );
              return;
            }
          }
        }
      }
    } catch {
      // Fallback to default.
    }
    this.detectedContextWindow = 8192;
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

    const url = `${this.config.baseUrl}/api/chat`;
    const body = {
      model: this.config.model,
      messages: this.convertMessages(messages),
      stream: true,
      options: {
        temperature: options?.temperature ?? this.config.temperature,
        top_p: options?.topP ?? this.config.topP,
        num_predict: options?.maxTokens ?? this.config.maxTokens,
      },
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options?.abortSignal,
      });

      if (!response.ok || !response.body) {
        yield {
          type: "error",
          error: `Ollama request failed: ${response.status} ${response.statusText}`,
        };
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
        return;
      }

      yield* this.parseChatStream(response.body, options?.abortSignal);
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

    const url = `${this.config.baseUrl}/api/generate`;
    const body = {
      model: this.config.model,
      prompt,
      stream: true,
      options: {
        temperature: options?.temperature ?? this.config.temperature,
        num_predict: options?.maxTokens ?? this.config.maxTokens,
        stop: options?.stop,
      },
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options?.abortSignal,
      });

      if (!response.ok || !response.body) {
        yield {
          type: "error",
          error: `Ollama request failed: ${response.status} ${response.statusText}`,
        };
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
        return;
      }

      yield* this.parseGenerateStream(response.body, options?.abortSignal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: message };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    }
  }

  /**
   * Query Ollama's /api/tags endpoint for all locally available models.
   */
  async listModels(): Promise<Array<{ id: string; name: string }>> {
    try {
      const res = await fetch(`${this.config.baseUrl}/api/tags`);
      if (!res.ok) return [];
      const data = (await res.json()) as {
        models?: Array<{ name: string }>;
      };
      return (data.models ?? []).map((m) => ({ id: m.name, name: m.name }));
    } catch {
      return [];
    }
  }

  dispose(): void {
    // No resources to release; fetch is stateless.
  }

  private async *parseChatStream(
    body: ReadableStream<Uint8Array>,
    abortSignal?: AbortSignal,
  ): AsyncIterable<StreamDelta> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        if (abortSignal?.aborted) {
          yield { type: "error", error: "Request aborted" };
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const json = JSON.parse(trimmed) as {
              message?: {
                content?: string;
                tool_calls?: Array<{
                  function?: {
                    name: string;
                    arguments: Record<string, unknown>;
                  };
                }>;
              };
              prompt_eval_count?: number;
              eval_count?: number;
              done?: boolean;
            };

            if (json.message?.content) {
              yield { type: "text", text: json.message.content };
            }

            if (json.message?.tool_calls) {
              for (const call of json.message.tool_calls) {
                if (call.function) {
                  const toolCall: ToolCall = {
                    id: `call_${Math.random().toString(36).slice(2, 11)}`,
                    name: call.function.name,
                    arguments: call.function.arguments ?? {},
                  };
                  yield { type: "tool_call_start", toolCall };
                  yield { type: "tool_call_end", toolCallId: toolCall.id };
                }
              }
            }

            if (json.prompt_eval_count) inputTokens = json.prompt_eval_count;
            if (json.eval_count) outputTokens = json.eval_count;

            if (json.done) {
              yield { type: "done", usage: { inputTokens, outputTokens } };
              return;
            }
          } catch {
            // Skip malformed JSON lines.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: "done", usage: { inputTokens, outputTokens } };
  }

  private async *parseGenerateStream(
    body: ReadableStream<Uint8Array>,
    abortSignal?: AbortSignal,
  ): AsyncIterable<StreamDelta> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        if (abortSignal?.aborted) {
          yield { type: "error", error: "Request aborted" };
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const json = JSON.parse(trimmed) as {
              response?: string;
              prompt_eval_count?: number;
              eval_count?: number;
              done?: boolean;
            };

            if (json.response) {
              yield { type: "text", text: json.response };
            }

            if (json.prompt_eval_count) inputTokens = json.prompt_eval_count;
            if (json.eval_count) outputTokens = json.eval_count;

            if (json.done) {
              yield { type: "done", usage: { inputTokens, outputTokens } };
              return;
            }
          } catch {
            // Skip malformed JSON lines.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: "done", usage: { inputTokens, outputTokens } };
  }

  private convertMessages(messages: LLMMessage[]): Array<{
    role: string;
    content: string;
  }> {
    // Trim for context window first (Ollama returns 500 on overflow).
    const trimmed = this.trimForContext(messages);
    // Ollama's chat API only accepts system/user/assistant roles.
    // Map 'tool' role to 'user' and skip empty messages.
    const result: Array<{ role: string; content: string }> = [];
    for (const msg of trimmed) {
      const content = this.flattenContent(msg.content);
      if (!content.trim()) continue;
      let role: string = msg.role;
      if (role === "tool") role = "user";
      if (role !== "system" && role !== "user" && role !== "assistant") {
        role = "user";
      }
      result.push({ role, content });
    }
    return result;
  }

  private trimForContext(messages: LLMMessage[]): LLMMessage[] {
    const estimate = (m: LLMMessage): number => {
      const content =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return Math.ceil(content.length / 4) + 10;
    };
    const ctxWindow = this.modelInfo().contextWindow || 8192;
    const budget = Math.floor(ctxWindow * 0.75);

    let totalTokens = 0;
    const kept: LLMMessage[] = [];
    let startIdx = 0;
    if (messages[0]?.role === "system") {
      kept.push(messages[0]);
      totalTokens += estimate(messages[0]);
      startIdx = 1;
    }
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
