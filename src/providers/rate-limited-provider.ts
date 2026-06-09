/**
 * RateLimitedProvider: wraps an LLMProvider with rate limiting.
 * On rate limit exceeded, emits an error delta instead of throwing.
 */
import type {
  LLMProvider,
  LLMMessage,
  ChatOptions,
  CompleteOptions,
  StreamDelta,
  LLMProviderConfig,
  ModelInfo,
} from "./types";
import {
  RateLimiter,
  RateLimitError,
  type RateLimitConfig,
} from "./rate-limiter";

export class RateLimitedProvider implements LLMProvider {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly inner: LLMProvider,
    config: RateLimitConfig,
  ) {
    this.limiter = new RateLimiter(config);
  }

  get name(): string {
    return this.inner.name;
  }

  get config(): LLMProviderConfig {
    return this.inner.config;
  }

  setWarningCallback(cb: (used: number, limit: number) => void): void {
    this.limiter.onWarning = cb;
  }

  getStats() {
    return this.limiter.getStats();
  }

  async *chat(
    messages: LLMMessage[],
    options?: ChatOptions,
  ): AsyncIterable<StreamDelta> {
    try {
      await this.limiter.acquire();
    } catch (err) {
      if (err instanceof RateLimitError) {
        yield { type: "error", error: `⚠️ ${err.message}` };
        return;
      }
      throw err;
    }
    yield* this.inner.chat(messages, options);
  }

  async *complete(
    prompt: string,
    options?: CompleteOptions,
  ): AsyncIterable<StreamDelta> {
    try {
      await this.limiter.acquire();
    } catch (err) {
      if (err instanceof RateLimitError) {
        yield { type: "error", error: `⚠️ ${err.message}` };
        return;
      }
      throw err;
    }
    yield* this.inner.complete(prompt, options);
  }

  supportsToolUse(): boolean {
    return this.inner.supportsToolUse();
  }

  supportsStreaming(): boolean {
    return this.inner.supportsStreaming();
  }

  countTokens(text: string): number {
    return this.inner.countTokens(text);
  }

  modelInfo(): ModelInfo {
    return this.inner.modelInfo();
  }

  dispose(): void {
    this.inner.dispose?.();
  }

  withModel(modelId: string): LLMProvider {
    return new RateLimitedProvider(this.inner.withModel(modelId), {
      requestsPerMinute:
        this.limiter.getStats().limit === Infinity
          ? undefined
          : this.limiter.getStats().limit,
    });
  }
}
