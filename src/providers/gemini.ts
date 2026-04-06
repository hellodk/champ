/**
 * GeminiProvider: Google Gemini API wrapper.
 *
 * Uses @google/generative-ai SDK. Gemini's streaming produces chunks
 * of candidates with text parts and optional function_call parts for
 * tool use.
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
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

const GEMINI_CONTEXT_WINDOWS: Record<string, number> = {
  "gemini-2.0-flash": 1_048_576,
  "gemini-2.0-flash-exp": 1_048_576,
  "gemini-1.5-pro": 2_097_152,
  "gemini-1.5-flash": 1_048_576,
};

const DEFAULT_CONTEXT_WINDOW = 1_048_576;

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly config: LLMProviderConfig;
  private _client: GoogleGenerativeAI | undefined;

  constructor(config: LLMProviderConfig) {
    this.config = config;
    // Client construction is deferred — see ClaudeProvider for the same
    // rationale.
  }

  private get client(): GoogleGenerativeAI {
    if (!this._client) {
      if (!this.config.apiKey) {
        throw new Error(
          "Gemini API key is not configured. Set it via the SecretStorage key 'aidev.gemini.apiKey'.",
        );
      }
      this._client = new GoogleGenerativeAI(this.config.apiKey);
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
    // Gemini's tokenizer is similar to other BPE models; ~4 chars/token.
    return Math.max(1, Math.ceil(text.length / 4));
  }

  modelInfo(): ModelInfo {
    return {
      id: this.config.model,
      name: this.config.model,
      provider: "gemini",
      contextWindow:
        GEMINI_CONTEXT_WINDOWS[this.config.model] ?? DEFAULT_CONTEXT_WINDOW,
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
      const tools = options?.tools
        ? [
            {
              functionDeclarations: options.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters as unknown as Record<string, unknown>,
              })),
            },
          ]
        : undefined;

      const model = this.client.getGenerativeModel({
        model: this.config.model,
        tools: tools as never,
        generationConfig: {
          temperature: options?.temperature ?? this.config.temperature,
          topP: options?.topP ?? this.config.topP,
          maxOutputTokens: options?.maxTokens ?? this.config.maxTokens,
        },
      });

      const { systemInstruction, contents } = this.convertMessages(messages);
      const request = systemInstruction
        ? { contents, systemInstruction }
        : { contents };

      const result = await model.generateContentStream(request as never);

      if (!result || !result.stream) {
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
        return;
      }

      let inputTokens = 0;
      let outputTokens = 0;

      for await (const chunk of result.stream as AsyncIterable<
        Record<string, unknown>
      >) {
        if (options?.abortSignal?.aborted) {
          yield { type: "error", error: "Request aborted" };
          break;
        }

        // Each chunk has a `candidates` array with content parts.
        const candidates = chunk.candidates as
          | Array<{ content?: { parts?: Array<Record<string, unknown>> } }>
          | undefined;
        const parts = candidates?.[0]?.content?.parts ?? [];

        for (const part of parts) {
          if (typeof part.text === "string" && part.text) {
            yield { type: "text", text: part.text };
          }
          const fnCall = part.functionCall as
            | { name: string; args: Record<string, unknown> }
            | undefined;
          if (fnCall) {
            const id = `call_${Math.random().toString(36).slice(2, 11)}`;
            yield {
              type: "tool_call_start",
              toolCall: { id, name: fnCall.name, arguments: fnCall.args ?? {} },
            };
            yield { type: "tool_call_end", toolCallId: id };
          }
        }

        const usageMeta = chunk.usageMetadata as
          | { promptTokenCount?: number; candidatesTokenCount?: number }
          | undefined;
        if (usageMeta) {
          inputTokens = usageMeta.promptTokenCount ?? inputTokens;
          outputTokens = usageMeta.candidatesTokenCount ?? outputTokens;
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
    yield* this.chat([{ role: "user", content: prompt }], {
      abortSignal: options?.abortSignal,
      temperature: options?.temperature,
      maxTokens: options?.maxTokens,
    });
  }

  dispose(): void {
    // GoogleGenerativeAI client has no explicit cleanup.
  }

  private convertMessages(messages: LLMMessage[]): {
    systemInstruction?: { parts: Array<{ text: string }> };
    contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  } {
    let systemText = "";
    const contents: Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }> = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        const text = this.flattenContent(msg.content);
        systemText = systemText ? `${systemText}\n\n${text}` : text;
        continue;
      }

      // Gemini uses "user" and "model" as role names.
      const role = msg.role === "assistant" ? "model" : "user";

      if (msg.role === "tool") {
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: msg.toolCallId ?? "tool",
                response: { content: this.flattenContent(msg.content) },
              },
            },
          ],
        });
        continue;
      }

      const parts: Array<Record<string, unknown>> = [];
      if (typeof msg.content === "string") {
        if (msg.content) parts.push({ text: msg.content });
      } else {
        for (const block of msg.content) {
          parts.push(this.convertContentBlock(block));
        }
      }
      if (msg.toolCalls) {
        for (const call of msg.toolCalls) {
          parts.push({
            functionCall: { name: call.name, args: call.arguments },
          });
        }
      }
      contents.push({ role, parts });
    }

    return {
      systemInstruction: systemText
        ? { parts: [{ text: systemText }] }
        : undefined,
      contents,
    };
  }

  private convertContentBlock(block: ContentBlock): Record<string, unknown> {
    if (block.type === "text") {
      return { text: block.text };
    }
    if (block.type === "image") {
      return {
        inlineData: {
          mimeType: block.mimeType,
          data: block.imageData,
        },
      };
    }
    if (block.type === "tool_result") {
      return { text: block.content };
    }
    return { text: "" };
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
