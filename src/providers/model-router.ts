/**
 * ModelRouter: routes tasks to the appropriate LLM provider.
 *
 * Different tasks benefit from different models:
 *   - completion: fast, small, cheap — optimized for inline autocomplete
 *   - chat:       large, capable — used for agents and interactive chat
 *   - embedding:  embedding-specific model — used for codebase indexing
 *
 * The router holds one provider per task type and exposes a unified
 * getProvider(task) interface so the agent layer doesn't need to know
 * which provider to use for which job.
 */
import type { LLMProvider, ModelInfo } from "./types";

export type ModelTask = "completion" | "chat" | "embedding";

export interface ModelRouterConfig {
  completion: LLMProvider;
  chat: LLMProvider;
  embedding: LLMProvider;
}

export class ModelRouter {
  private providers: Map<ModelTask, LLMProvider>;

  constructor(config: ModelRouterConfig) {
    this.providers = new Map<ModelTask, LLMProvider>([
      ["completion", config.completion],
      ["chat", config.chat],
      ["embedding", config.embedding],
    ]);
  }

  /**
   * Get the provider for a given task type.
   */
  getProvider(task: ModelTask): LLMProvider {
    const provider = this.providers.get(task);
    if (!provider) {
      throw new Error(`No provider registered for task "${task}"`);
    }
    return provider;
  }

  /**
   * Replace the provider for a given task. Used when the user switches
   * the active chat model at runtime.
   */
  setProvider(task: ModelTask, provider: LLMProvider): void {
    this.providers.set(task, provider);
  }

  /**
   * Get model info for the active provider of a given task.
   */
  getActiveModelInfo(task: ModelTask): ModelInfo {
    return this.getProvider(task).modelInfo();
  }

  /**
   * List all currently-configured task -> provider mappings.
   */
  listRoutes(): Array<{ task: ModelTask; providerName: string }> {
    return Array.from(this.providers.entries()).map(([task, provider]) => ({
      task,
      providerName: provider.name,
    }));
  }
}
