/**
 * ClaudeProvider: Anthropic Claude API wrapper.
 *
 * Streams chat and completion responses, supports native tool use and image
 * content blocks. Wraps the official @anthropic-ai/sdk.
 */
import Anthropic from "@anthropic-ai/sdk";
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

/** Default context window sizes for known Claude models. */
const CLAUDE_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-sonnet-4-20250514": 200_000,
  "claude-opus-4-20250514": 200_000,
  "claude-3-5-sonnet-20241022": 200_000,
  "claude-3-5-haiku-20241022": 200_000,
  "claude-3-opus-20240229": 200_000,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;

export class ClaudeProvider implements LLMProvider {
  readonly name = "claude";
  readonly config: LLMProviderConfig;
  private _client: Anthropic | undefined;

  constructor(config: LLMProviderConfig) {
    this.config = config;
    // Client construction is deferred until first use. The Anthropic SDK
    // throws synchronously if no apiKey is provided, and we don't want
    // that to crash extension activation when the user has Claude as the
    // default provider but is actually configuring something else.
  }

  /**
   * Lazy-initialized Anthropic client. Throws a clear error if the API
   * key is missing — but only when the provider is actually called,
   * never during construction.
   */
  private get client(): Anthropic {
    if (!this._client) {
      if (!this.config.apiKey) {
        throw new Error(
          "Claude API key is not configured. Set it via the command palette: 'AIDev: Set Claude API Key', or store it under the SecretStorage key 'aidev.claude.apiKey'.",
        );
      }
      this._client = new Anthropic({
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
    // Approximation: ~4 characters per token for English text.
    // The Anthropic SDK offers an exact counter via the API, but for
    // context-fitting decisions this estimate is accurate enough and avoids
    // network round-trips. Replace with SDK tokenizer if precision is needed.
    if (!text) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
  }

  modelInfo(): ModelInfo {
    return {
      id: this.config.model,
      name: this.config.model,
      provider: "claude",
      contextWindow:
        CLAUDE_CONTEXT_WINDOWS[this.config.model] ?? DEFAULT_CONTEXT_WINDOW,
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
    // Early abort check
    if (options?.abortSignal?.aborted) {
      yield { type: "error", error: "Request aborted before send" };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }

    try {
      const { system, claudeMessages } = this.convertMessages(messages);
      const claudeTools = options?.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as unknown as Record<string, unknown>,
      }));

      const stream = await this.client.messages.create({
        model: this.config.model,
        max_tokens: options?.maxTokens ?? this.config.maxTokens,
        temperature: options?.temperature ?? this.config.temperature,
        top_p: options?.topP ?? this.config.topP,
        system: system || undefined,
        messages: claudeMessages as never,
        tools: claudeTools as never,
        stream: true,
      });

      // Guard against mocked/undefined responses in test environments.
      if (
        !stream ||
        typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] !==
          "function"
      ) {
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
        return;
      }

      let inputTokens = 0;
      let outputTokens = 0;
      const partialToolCalls = new Map<
        number,
        { id: string; name: string; argsJson: string }
      >();

      for await (const event of stream as AsyncIterable<
        Record<string, unknown>
      >) {
        if (options?.abortSignal?.aborted) {
          yield { type: "error", error: "Request aborted" };
          break;
        }

        const eventType = event.type as string | undefined;

        if (eventType === "message_start") {
          const msg = event.message as
            | { usage?: { input_tokens?: number } }
            | undefined;
          if (msg?.usage?.input_tokens) inputTokens = msg.usage.input_tokens;
        } else if (eventType === "content_block_start") {
          const block = event.content_block as
            | { type: string; id?: string; name?: string }
            | undefined;
          const index = (event.index as number) ?? 0;
          if (block?.type === "tool_use" && block.id && block.name) {
            partialToolCalls.set(index, {
              id: block.id,
              name: block.name,
              argsJson: "",
            });
            yield {
              type: "tool_call_start",
              toolCall: { id: block.id, name: block.name, arguments: {} },
            };
          }
        } else if (eventType === "content_block_delta") {
          const delta = event.delta as
            | { type: string; text?: string; partial_json?: string }
            | undefined;
          const index = (event.index as number) ?? 0;
          if (delta?.type === "text_delta" && delta.text !== undefined) {
            yield { type: "text", text: delta.text };
          } else if (
            delta?.type === "input_json_delta" &&
            delta.partial_json !== undefined
          ) {
            const partial = partialToolCalls.get(index);
            if (partial) {
              partial.argsJson += delta.partial_json;
              yield {
                type: "tool_call_delta",
                toolCallId: partial.id,
                argumentsDelta: delta.partial_json,
              };
            }
          }
        } else if (eventType === "content_block_stop") {
          const index = (event.index as number) ?? 0;
          const partial = partialToolCalls.get(index);
          if (partial) {
            yield { type: "tool_call_end", toolCallId: partial.id };
          }
        } else if (eventType === "message_delta") {
          const usage = event.usage as { output_tokens?: number } | undefined;
          if (usage?.output_tokens) outputTokens = usage.output_tokens;
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
    // Claude doesn't have a dedicated completion endpoint; fall back to chat
    // with a single user message. The caller (autocomplete provider) wraps
    // the prompt appropriately for FIM.
    yield* this.chat([{ role: "user", content: prompt }], {
      abortSignal: options?.abortSignal,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
    });
  }

  dispose(): void {
    // The Anthropic SDK manages its own HTTP agent; nothing to release.
  }

  /**
   * Convert unified LLMMessage[] into Claude's expected format.
   * Claude uses a separate `system` parameter (not a message role).
   */
  private convertMessages(messages: LLMMessage[]): {
    system: string;
    claudeMessages: Array<{ role: "user" | "assistant"; content: unknown }>;
  } {
    let system = "";
    const claudeMessages: Array<{
      role: "user" | "assistant";
      content: unknown;
    }> = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        const text =
          typeof msg.content === "string"
            ? msg.content
            : msg.content
                .map((b) => (b.type === "text" ? b.text : ""))
                .join("");
        system = system ? `${system}\n\n${text}` : text;
        continue;
      }

      if (msg.role === "tool") {
        // Tool results are attached to the next user turn in Claude's format.
        claudeMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.toolCallId,
              content: typeof msg.content === "string" ? msg.content : "",
            },
          ],
        });
        continue;
      }

      if (msg.role === "assistant") {
        const blocks: unknown[] = [];
        if (typeof msg.content === "string") {
          if (msg.content) blocks.push({ type: "text", text: msg.content });
        } else {
          for (const block of msg.content) {
            blocks.push(this.convertContentBlock(block));
          }
        }
        if (msg.toolCalls) {
          for (const call of msg.toolCalls) {
            blocks.push({
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: call.arguments,
            });
          }
        }
        claudeMessages.push({ role: "assistant", content: blocks });
        continue;
      }

      // role === 'user'
      if (typeof msg.content === "string") {
        claudeMessages.push({ role: "user", content: msg.content });
      } else {
        claudeMessages.push({
          role: "user",
          content: msg.content.map((b) => this.convertContentBlock(b)),
        });
      }
    }

    return { system, claudeMessages };
  }

  private convertContentBlock(block: ContentBlock): unknown {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    if (block.type === "image") {
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.mimeType,
          data: block.imageData,
        },
      };
    }
    if (block.type === "tool_use") {
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    }
    if (block.type === "tool_result") {
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
    }
    return { type: "text", text: "" };
  }
}
