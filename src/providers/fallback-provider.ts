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
        // Lazy-probe: get the first token only. If the first token is an error
        // delta, skip remaining retries and move to the next provider. If the
        // iterator throws, retry (up to maxRetries) before moving on.
        let firstDelta: StreamDelta | undefined;
        let iterator: AsyncIterator<StreamDelta> | undefined;
        let probeError: Error | undefined;
        let errorDelta = false;

        try {
          const iterable = provider.chat(messages, options);
          iterator = iterable[Symbol.asyncIterator]();
          const { value, done } = await iterator.next();
          if (done) return; // empty stream = success
          firstDelta = value;
        } catch (err) {
          probeError = err instanceof Error ? err : new Error(String(err));
        }

        if (probeError) {
          iterator?.return?.();
          lastError = probeError;
          // thrown error → use up a retry, then try next provider
          continue;
        }

        if (firstDelta!.type === "error") {
          iterator?.return?.();
          lastError = new Error(firstDelta!.error ?? "provider error");
          errorDelta = true;
        }

        if (errorDelta) {
          break; // error delta → no point retrying this provider, move on
        }

        // Commit: first token is good — yield it and stream the rest directly
        try {
          yield firstDelta!;
          let next: IteratorResult<StreamDelta>;
          while (!(next = await iterator!.next()).done) {
            yield next.value;
          }
          return; // success
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          break; // mid-stream: partial content already yielded, skip to next provider
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
        // Lazy-probe: get the first token only. If the first token is an error
        // delta, skip remaining retries and move to the next provider. If the
        // iterator throws, retry (up to maxRetries) before moving on.
        let firstDelta: StreamDelta | undefined;
        let iterator: AsyncIterator<StreamDelta> | undefined;
        let probeError: Error | undefined;
        let errorDelta = false;

        try {
          const iterable = provider.complete(prompt, options);
          iterator = iterable[Symbol.asyncIterator]();
          const { value, done } = await iterator.next();
          if (done) return; // empty stream = success
          firstDelta = value;
        } catch (err) {
          probeError = err instanceof Error ? err : new Error(String(err));
        }

        if (probeError) {
          iterator?.return?.();
          lastError = probeError;
          // thrown error → use up a retry, then try next provider
          continue;
        }

        if (firstDelta!.type === "error") {
          iterator?.return?.();
          lastError = new Error(firstDelta!.error ?? "provider error");
          errorDelta = true;
        }

        if (errorDelta) {
          break; // error delta → no point retrying this provider, move on
        }

        // Commit: first token is good — yield it and stream the rest directly
        try {
          yield firstDelta!;
          let next: IteratorResult<StreamDelta>;
          while (!(next = await iterator!.next()).done) {
            yield next.value;
          }
          return; // success
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          break; // mid-stream: partial content already yielded, skip to next provider
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

  withModel(modelId: string): FallbackProvider {
    return new FallbackProvider(
      this.providers.map((p) => p.withModel(modelId)),
      this.maxRetries,
    );
  }
}
