/**
 * FallbackProvider: wraps multiple LLMProviders and tries them in order.
 * If the primary provider fails (throws or emits an error delta), it
 * automatically retries with the next provider in the chain.
 */
import type {
  LLMProvider,
  LLMMessage,
  ChatOptions,
  StreamDelta,
  LLMProviderConfig,
  ModelInfo,
  CompleteOptions,
} from "./types";

export class FallbackProvider implements LLMProvider {
  constructor(
    private readonly providers: LLMProvider[],
    private readonly maxRetries: number = 1,
  ) {
    if (providers.length === 0)
      throw new Error("FallbackProvider requires at least one provider");
  }

  get name(): string {
    return `fallback(${this.providers.map((p) => p.name).join(",")})`;
  }

  get config(): LLMProviderConfig {
    return this.providers[0]!.config;
  }

  async *chat(
    messages: LLMMessage[],
    options?: ChatOptions,
  ): AsyncIterable<StreamDelta> {
    let lastError: Error | undefined;
    for (const provider of this.providers) {
      for (let attempt = 0; attempt < Math.max(1, this.maxRetries); attempt++) {
        try {
          let hasError = false;
          const gen = provider.chat(messages, options);
          const buffer: StreamDelta[] = [];
          for await (const delta of gen) {
            if (delta.type === "error") {
              hasError = true;
              lastError = new Error(delta.error ?? "provider error");
              break;
            }
            buffer.push(delta);
          }
          if (!hasError) {
            yield* buffer;
            return;
          }
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }
    throw lastError ?? new Error("All providers in fallback chain failed");
  }

  async *complete(
    prompt: string,
    options?: CompleteOptions,
  ): AsyncIterable<StreamDelta> {
    let lastError: Error | undefined;
    for (const provider of this.providers) {
      for (let attempt = 0; attempt < Math.max(1, this.maxRetries); attempt++) {
        try {
          let hasError = false;
          const gen = provider.complete(prompt, options);
          const buffer: StreamDelta[] = [];
          for await (const delta of gen) {
            if (delta.type === "error") {
              hasError = true;
              lastError = new Error(delta.error ?? "provider error");
              break;
            }
            buffer.push(delta);
          }
          if (!hasError) {
            yield* buffer;
            return;
          }
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
        }
      }
    }
    throw lastError ?? new Error("All providers in fallback chain failed");
  }

  supportsToolUse(): boolean {
    return this.providers[0]?.supportsToolUse() ?? false;
  }

  supportsStreaming(): boolean {
    return this.providers.every((p) => p.supportsStreaming());
  }

  countTokens(text: string): number {
    return this.providers[0]?.countTokens(text) ?? Math.ceil(text.length / 4);
  }

  modelInfo(): ModelInfo {
    return (
      this.providers[0]!.modelInfo() ?? {
        id: "unknown",
        name: "unknown",
        provider: "fallback",
        contextWindow: 4096,
        maxOutputTokens: 4096,
        supportsToolUse: false,
        supportsImages: false,
        supportsStreaming: false,
      }
    );
  }

  dispose(): void {
    for (const p of this.providers) p.dispose?.();
  }
}
