/**
 * OpenAIProvider: OpenAI API wrapper (GPT-4, GPT-4o, o1, etc.).
 *
 * Uses the official `openai` npm SDK with streaming chat completions.
 * Tool calls are accumulated across streaming deltas using the per-call
 * index provided by the API.
 */
import OpenAI from "openai";
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

/** Context windows for common OpenAI models. */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4-turbo": 128_000,
  "gpt-4": 8192,
  "gpt-3.5-turbo": 16_385,
  "o1-preview": 128_000,
  "o1-mini": 128_000,
  "o3-mini": 200_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  readonly config: LLMProviderConfig;
  private _client: OpenAI | undefined;

  constructor(config: LLMProviderConfig) {
    this.config = config;
    // Client construction is deferred — see ClaudeProvider for the same
    // rationale. The OpenAI SDK can also throw synchronously when no
    // apiKey is set.
  }

  private get client(): OpenAI {
    if (!this._client) {
      if (!this.config.apiKey) {
        throw new Error(
          "OpenAI API key is not configured. Set it via the SecretStorage key 'aidev.openai.apiKey'.",
        );
      }
      this._client = new OpenAI({
        apiKey: this.config.apiKey,
        baseURL: this.config.baseUrl,
        defaultHeaders: this.config.customHeaders,
      });
    }
    return this._client;
  }

  supportsToolUse(): boolean {
    return true;
  }

  supportsStreaming(): boolean {
    return true;
  }

  countTokens(text: string): number {
    if (!text) return 0;
    // OpenAI's BPE averages ~4 chars per token. Precise counting would
    // need tiktoken, but for context-fitting this estimate is good enough.
    return Math.max(1, Math.ceil(text.length / 4));
  }

  modelInfo(): ModelInfo {
    return {
      id: this.config.model,
      name: this.config.model,
      provider: "openai",
      contextWindow:
        MODEL_CONTEXT_WINDOWS[this.config.model] ?? DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: this.config.maxTokens,
      supportsToolUse: true,
      supportsImages: true,
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

    try {
      const openaiMessages = this.convertMessages(messages);
      const tools = options?.tools?.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters as unknown as Record<string, unknown>,
        },
      }));

      const stream = await this.client.chat.completions.create({
        model: this.config.model,
        messages: openaiMessages as never,
        stream: true,
        temperature: options?.temperature ?? this.config.temperature,
        max_tokens: options?.maxTokens ?? this.config.maxTokens,
        top_p: options?.topP ?? this.config.topP,
        tools: tools as never,
      });

      if (
        !stream ||
        typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] !==
          "function"
      ) {
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
        return;
      }

      // Tool calls arrive in pieces via delta.tool_calls; the `index` field
      // identifies which call each piece belongs to. Accumulate here and
      // emit tool_call_start once the name is known.
      const partialCalls = new Map<
        number,
        { id: string; name: string; argsJson: string; started: boolean }
      >();
      let inputTokens = 0;
      let outputTokens = 0;

      for await (const chunk of stream as AsyncIterable<
        Record<string, unknown>
      >) {
        if (options?.abortSignal?.aborted) {
          yield { type: "error", error: "Request aborted" };
          break;
        }

        const choices = chunk.choices as
          | Array<Record<string, unknown>>
          | undefined;
        const usage = chunk.usage as
          | { prompt_tokens?: number; completion_tokens?: number }
          | undefined;
        if (usage) {
          inputTokens = usage.prompt_tokens ?? inputTokens;
          outputTokens = usage.completion_tokens ?? outputTokens;
        }
        if (!choices || choices.length === 0) continue;

        const choice = choices[0];
        const delta = choice.delta as
          | { content?: string; tool_calls?: Array<Record<string, unknown>> }
          | undefined;

        if (delta?.content) {
          yield { type: "text", text: delta.content };
        }

        if (delta?.tool_calls) {
          for (const call of delta.tool_calls) {
            const index = (call.index as number) ?? 0;
            const partial = partialCalls.get(index) ?? {
              id: "",
              name: "",
              argsJson: "",
              started: false,
            };

            if (call.id) partial.id = call.id as string;
            const fn = call.function as
              | { name?: string; arguments?: string }
              | undefined;
            if (fn?.name) partial.name = fn.name;
            if (fn?.arguments) {
              partial.argsJson += fn.arguments;
              if (partial.started && partial.id) {
                yield {
                  type: "tool_call_delta",
                  toolCallId: partial.id,
                  argumentsDelta: fn.arguments,
                };
              }
            }

            if (!partial.started && partial.name && partial.id) {
              partial.started = true;
              yield {
                type: "tool_call_start",
                toolCall: { id: partial.id, name: partial.name, arguments: {} },
              };
            }

            partialCalls.set(index, partial);
          }
        }

        const finishReason = choice.finish_reason as string | null | undefined;
        if (finishReason) {
          // Emit tool_call_end for each completed tool call and final
          // arguments parsed from the accumulated JSON strings.
          for (const partial of partialCalls.values()) {
            if (partial.started) {
              yield { type: "tool_call_end", toolCallId: partial.id };
            }
          }
        }
      }

      yield { type: "done", usage: { inputTokens, outputTokens } };
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
    // OpenAI's chat endpoint is used for completions too; a plain user
    // message is sent with the prompt.
    yield* this.chat([{ role: "user", content: prompt }], {
      abortSignal: options?.abortSignal,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
    });
  }

  dispose(): void {
    // OpenAI SDK manages its own HTTP agent; nothing to release.
  }

  private convertMessages(
    messages: LLMMessage[],
  ): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        result.push({
          role: "system",
          content: this.flattenContent(msg.content),
        });
      } else if (msg.role === "tool") {
        result.push({
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: this.flattenContent(msg.content),
        });
      } else if (msg.role === "assistant") {
        const entry: Record<string, unknown> = {
          role: "assistant",
          content:
            typeof msg.content === "string"
              ? msg.content
              : this.flattenContent(msg.content),
        };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          entry.tool_calls = msg.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: {
              name: c.name,
              arguments: JSON.stringify(c.arguments),
            },
          }));
        }
        result.push(entry);
      } else {
        // user
        if (typeof msg.content === "string") {
          result.push({ role: "user", content: msg.content });
        } else {
          result.push({
            role: "user",
            content: msg.content.map((b) => this.convertContentBlock(b)),
          });
        }
      }
    }

    return result;
  }

  private convertContentBlock(block: ContentBlock): Record<string, unknown> {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    if (block.type === "image") {
      return {
        type: "image_url",
        image_url: { url: `data:${block.mimeType};base64,${block.imageData}` },
      };
    }
    if (block.type === "tool_result") {
      return { type: "text", text: block.content };
    }
    return { type: "text", text: "" };
  }

  private flattenContent(content: string | ContentBlock[]): string {
    if (typeof content === "string") return content;
    return content
      .map((b) => {
        if (b.type === "text") return b.text;
        if (b.type === "tool_result") return b.content;
        return "";
      })
      .join("");
  }
}
