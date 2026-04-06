/**
 * AidevInlineCompletionProvider: ghost-text inline autocomplete.
 *
 * Uses a small, fast local model (e.g. Qwen2.5-Coder-1.5B via Ollama) to
 * produce single-line or multi-line completions as the user types. The
 * LLM's complete() method is called with a Fill-In-the-Middle style
 * prompt, and the first non-empty suggestion is returned as ghost text.
 *
 * Rapid keystrokes are coalesced via in-flight debouncing: when a new
 * request arrives while a previous one is pending, the previous request
 * is aborted so only the latest prefix reaches the LLM.
 */
import type { LLMProvider } from "../providers/types";

/**
 * Metadata about the editor state at the point where the completion
 * is being requested.
 */
export interface CompletionContext {
  filePath: string;
  language: string;
  lineNumber: number;
  /** Optional suffix (text after the cursor) for FIM-style completion. */
  suffix?: string;
}

/**
 * A single inline completion suggestion.
 */
export interface InlineCompletion {
  text: string;
  /** 0.0 to 1.0 confidence score (if the model provides one). */
  confidence?: number;
}

/**
 * Stop sequences that end a completion early. We stop at newlines that
 * introduce unrelated code so the suggestion doesn't sprawl.
 */
const DEFAULT_STOP: string[] = ["\n\n", "```"];

/**
 * A single pending request that may be superseded before it executes.
 * When a newer request arrives, we mark the pending one as superseded
 * so it resolves to [] without ever calling the LLM — that's how we
 * coalesce rapid keystrokes into a single LLM call.
 */
interface PendingRequest {
  prefix: string;
  context: CompletionContext;
  externalAbort?: AbortSignal;
  resolve: (value: InlineCompletion[]) => void;
  superseded: boolean;
}

export class AidevInlineCompletionProvider {
  /** The most recent pending request, awaiting a microtask to fire. */
  private pending: PendingRequest | null = null;
  /** Whether a microtask has already been scheduled for the pending request. */
  private microtaskScheduled = false;
  /** Currently running LLM call, so we can abort it when a new request arrives. */
  private runningController: AbortController | null = null;
  private llm: LLMProvider;

  constructor(llm: LLMProvider) {
    this.llm = llm;
  }

  /**
   * Hot-swap the active LLM provider. Used when the user changes the
   * provider setting at runtime.
   */
  setProvider(llm: LLMProvider): void {
    this.cancel();
    this.llm = llm;
  }

  /**
   * Provide completions for the given prefix.
   *
   * Multiple rapid calls are coalesced: when synchronous calls arrive
   * before the first one has started, only the last one's prefix reaches
   * the LLM. Earlier calls resolve to [].
   *
   * @param prefix - Text before the cursor
   * @param context - Editor metadata (file path, language, line)
   * @param externalAbort - Caller-provided abort signal (e.g. from VS Code)
   */
  provideCompletions(
    prefix: string,
    context: CompletionContext,
    externalAbort?: AbortSignal,
  ): Promise<InlineCompletion[]> {
    // Respect external cancellation immediately.
    if (externalAbort?.aborted) {
      return Promise.resolve([]);
    }

    // Abort any running LLM call so we don't waste tokens on stale prefixes.
    if (this.runningController) {
      this.runningController.abort();
      this.runningController = null;
    }

    // Mark any pending-but-not-yet-fired request as superseded. It will
    // resolve to [] when its microtask runs.
    if (this.pending) {
      this.pending.superseded = true;
      this.pending.resolve([]);
    }

    return new Promise<InlineCompletion[]>((resolve) => {
      this.pending = {
        prefix,
        context,
        externalAbort,
        resolve,
        superseded: false,
      };

      if (!this.microtaskScheduled) {
        this.microtaskScheduled = true;
        queueMicrotask(() => this.flushPending());
      }
    });
  }

  /**
   * Cancel any in-flight completion. Called by the editor when the
   * cursor moves or the user starts typing again.
   */
  cancel(): void {
    if (this.runningController) {
      this.runningController.abort();
      this.runningController = null;
    }
    if (this.pending) {
      this.pending.superseded = true;
      this.pending.resolve([]);
      this.pending = null;
    }
  }

  private async flushPending(): Promise<void> {
    this.microtaskScheduled = false;
    const request = this.pending;
    this.pending = null;

    // The pending request may have been superseded after scheduling.
    if (!request || request.superseded) {
      return;
    }

    const result = await this.runCompletion(
      request.prefix,
      request.context,
      request.externalAbort,
    );
    request.resolve(result);
  }

  private async runCompletion(
    prefix: string,
    context: CompletionContext,
    externalAbort?: AbortSignal,
  ): Promise<InlineCompletion[]> {
    if (externalAbort?.aborted) return [];

    const controller = new AbortController();
    if (externalAbort) {
      if (externalAbort.aborted) {
        controller.abort();
      } else {
        externalAbort.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
      }
    }
    this.runningController = controller;

    try {
      const prompt = this.buildPrompt(prefix, context);
      let text = "";

      for await (const delta of this.llm.complete(prompt, {
        abortSignal: controller.signal,
        temperature: 0.2,
        maxTokens: 256,
        stop: DEFAULT_STOP,
      })) {
        if (controller.signal.aborted) return [];

        if (delta.type === "text" && delta.text) {
          text += delta.text;
        } else if (delta.type === "error") {
          return [];
        } else if (delta.type === "done") {
          break;
        }
      }

      const cleaned = this.cleanSuggestion(text);
      return cleaned ? [{ text: cleaned }] : [];
    } catch {
      return [];
    } finally {
      if (this.runningController === controller) {
        this.runningController = null;
      }
    }
  }

  /**
   * Build a Fill-In-the-Middle prompt for the small model. Most
   * code-focused local models recognize the FIM tokens
   * `<|fim_prefix|>...<|fim_suffix|>...<|fim_middle|>` (Qwen2.5-Coder,
   * DeepSeek-Coder, StarCoder). Models without FIM still get useful
   * output since the prefix is placed first.
   */
  private buildPrompt(prefix: string, context: CompletionContext): string {
    const suffix = context.suffix ?? "";
    const language = context.language || "text";
    const filePath = context.filePath;

    return `<|fim_prefix|>// Language: ${language}
// File: ${filePath}
${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
  }

  /**
   * Strip common FIM end tokens and trim whitespace from model output.
   */
  private cleanSuggestion(text: string): string {
    if (!text) return "";
    return text
      .replace(/<\|fim_middle\|>/g, "")
      .replace(/<\|fim_suffix\|>.*$/s, "")
      .replace(/<\|fim_prefix\|>/g, "")
      .replace(/<\|endoftext\|>/g, "")
      .replace(/<\|im_end\|>/g, "")
      .replace(/<\|eot_id\|>/g, "")
      .trimEnd();
  }
}
