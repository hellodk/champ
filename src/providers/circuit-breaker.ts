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

    let iterator: AsyncIterator<StreamDelta> | undefined;
    try {
      // Lazy-probe: get the first token. If it throws or is an error delta,
      // count as a failure — avoids buffering the full stream before deciding.
      const iterable = this.inner.chat(messages, options);
      iterator = iterable[Symbol.asyncIterator]();
      const { value: firstDelta, done } = await iterator.next();

      if (done) {
        this.onSuccess();
        return;
      }

      if (firstDelta.type === "error") {
        iterator?.return?.();
        throw new Error(firstDelta.error ?? "stream error delta");
      }

      // First token is good — commit and stream the rest directly
      this.onSuccess();
      yield firstDelta;
      let next: IteratorResult<StreamDelta>;
      while (!(next = await iterator.next()).done) {
        yield next.value;
      }
    } catch (err) {
      iterator?.return?.();
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.failureThreshold) this.state = "open";
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

    let iterator: AsyncIterator<StreamDelta> | undefined;
    try {
      // Lazy-probe: get the first token. If it throws or is an error delta,
      // count as a failure — avoids buffering the full stream before deciding.
      const iterable = this.inner.complete(prompt, options);
      iterator = iterable[Symbol.asyncIterator]();
      const { value: firstDelta, done } = await iterator.next();

      if (done) {
        this.onSuccess();
        return;
      }

      if (firstDelta.type === "error") {
        iterator?.return?.();
        throw new Error(firstDelta.error ?? "stream error delta");
      }

      // First token is good — commit and stream the rest directly
      this.onSuccess();
      yield firstDelta;
      let next: IteratorResult<StreamDelta>;
      while (!(next = await iterator.next()).done) {
        yield next.value;
      }
    } catch (err) {
      iterator?.return?.();
      this.onFailure();
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
