/**
 * CircuitBreaker: wraps an LLMProvider and opens the circuit after
 * consecutive failures, preventing calls to a known-failing endpoint.
 *
 * States:
 *   CLOSED   — normal operation, calls go through
 *   OPEN     — circuit tripped, calls fail immediately
 *   HALF_OPEN — one probe call allowed; if it succeeds, close circuit
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

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreaker implements LLMProvider {
  private state: CircuitState = "closed";
  private failures = 0;
  private lastFailureTime = 0;

  constructor(
    private readonly inner: LLMProvider,
    private readonly failureThreshold = 3, // consecutive failures to open
    private readonly recoveryTimeMs = 30_000, // ms before trying half-open
  ) {}

  get name(): string {
    return `circuit(${this.inner.name})`;
  }

  get config(): LLMProviderConfig {
    return this.inner.config;
  }

  getState(): CircuitState {
    return this.state;
  }

  async *chat(
    messages: LLMMessage[],
    options?: ChatOptions,
  ): AsyncIterable<StreamDelta> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime >= this.recoveryTimeMs) {
        this.state = "half-open";
      } else {
        throw new Error(
          `Circuit open for provider "${this.inner.name}" — cooling down after ${this.failures} failures`,
        );
      }
    }
    try {
      const gen = this.inner.chat(messages, options);
      const buffer: StreamDelta[] = [];
      for await (const delta of gen) {
        if (delta.type === "error")
          throw new Error(delta.error ?? "stream error");
        buffer.push(delta);
      }
      // Success — reset
      this.failures = 0;
      this.state = "closed";
      yield* buffer;
    } catch (err) {
      this.failures++;
      this.lastFailureTime = Date.now();
      if (this.failures >= this.failureThreshold) this.state = "open";
      throw err;
    }
  }

  async *complete(
    prompt: string,
    options?: CompleteOptions,
  ): AsyncIterable<StreamDelta> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime >= this.recoveryTimeMs) {
        this.state = "half-open";
      } else {
        throw new Error(
          `Circuit open for provider "${this.inner.name}" — cooling down after ${this.failures} failures`,
        );
      }
    }
    try {
      const gen = this.inner.complete(prompt, options);
      const buffer: StreamDelta[] = [];
      for await (const delta of gen) {
        if (delta.type === "error")
          throw new Error(delta.error ?? "stream error");
        buffer.push(delta);
      }
      // Success — reset
      this.failures = 0;
      this.state = "closed";
      yield* buffer;
    } catch (err) {
      this.failures++;
      this.lastFailureTime = Date.now();
      if (this.failures >= this.failureThreshold) this.state = "open";
      throw err;
    }
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
}
