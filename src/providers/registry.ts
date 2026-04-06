/**
 * ProviderRegistry: central registry for LLM providers.
 *
 * The extension host registers one instance per configured provider
 * (Claude, Ollama, etc.) at activation time, and the agent layer looks
 * them up by name.
 */
import type { LLMProvider } from "./types";

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();

  /**
   * Register a provider. If a provider with the same name already exists,
   * it is disposed and replaced.
   */
  register(provider: LLMProvider): void {
    const existing = this.providers.get(provider.name);
    if (existing) {
      existing.dispose();
    }
    this.providers.set(provider.name, provider);
  }

  /**
   * Retrieve a provider by name. Throws if not registered.
   */
  get(name: string): LLMProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider "${name}" is not registered`);
    }
    return provider;
  }

  /**
   * Whether a provider with the given name is registered.
   */
  has(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * List all registered providers.
   */
  list(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Unregister and dispose a provider.
   */
  unregister(name: string): void {
    const provider = this.providers.get(name);
    if (provider) {
      provider.dispose();
      this.providers.delete(name);
    }
  }

  /**
   * Dispose and clear all providers. Called during extension deactivation.
   */
  disposeAll(): void {
    for (const provider of this.providers.values()) {
      provider.dispose();
    }
    this.providers.clear();
  }
}
