/**
 * ProviderFactory: builds an LLMProvider from the YAML ChampConfig.
 *
 * Since #118 YAML is the only source of truth. API keys come from
 * SecretStorage (cloud) or the YAML `apiKey` field (self-hosted).
 */
import type { LLMProvider, LLMProviderConfig } from "./types";
import { ClaudeProvider } from "./claude";
import { OpenAIProvider } from "./openai";
import { GeminiProvider } from "./gemini";
import { OllamaProvider } from "./ollama";
import { LlamaCppProvider } from "./llamacpp";
import { VLLMProvider } from "./vllm";
import { OpenAICompatibleProvider } from "./openai-compatible";
import type { ChampConfig } from "../config/config-loader";

/**
 * Narrow interface matching vscode.SecretStorage. Tests provide a fake.
 * Uses PromiseLike so vscode.SecretStorage's Thenable return is
 * assignable without wrapping.
 */
export interface SecretReader {
  get(key: string): PromiseLike<string | undefined>;
}

export class ProviderFactory {
  /**
   * Build a provider instance from a parsed ChampConfig (YAML-based).
   *
   * This path takes a structured ChampConfig (typically loaded from
   * .champ/config.yaml). API keys come from SecretStorage or env vars
   * — never from YAML for cloud providers.
   */
  async createFromChampConfig(
    config: ChampConfig,
    secrets: SecretReader,
  ): Promise<LLMProvider> {
    const providerName = config.provider ?? "claude";
    const providerEntry = config.providers?.[providerName] ?? {};

    // Shared config members threaded into every provider's baseConfig (#121).
    const baseExtras: Partial<Omit<LLMProviderConfig, "provider" | "model">> = {
      contextWindow: providerEntry.contextWindow,
      options: providerEntry.options,
      structuredOutput: providerEntry.structuredOutput,
      cachePrompt: providerEntry.cachePrompt,
    };

    // Helper: try SecretStorage first, then environment variable.
    const getKey = async (
      secretKey: string,
      envVar: string,
    ): Promise<string | undefined> => {
      const fromSecrets = await secrets.get(secretKey);
      if (fromSecrets) return fromSecrets;
      return process.env[envVar] || undefined;
    };

    switch (providerName) {
      case "claude":
        return new ClaudeProvider({
          ...this.baseConfig("claude", baseExtras),
          model: providerEntry.model ?? "claude-sonnet-4-20250514",
          apiKey: await getKey("champ.claude.apiKey", "ANTHROPIC_API_KEY"),
        });
      case "openai":
        return new OpenAIProvider({
          ...this.baseConfig("openai", baseExtras),
          model: providerEntry.model ?? "gpt-4o",
          apiKey: await getKey("champ.openai.apiKey", "OPENAI_API_KEY"),
        });
      case "gemini":
        return new GeminiProvider({
          ...this.baseConfig("gemini", baseExtras),
          model: providerEntry.model ?? "gemini-2.0-flash",
          apiKey: await getKey("champ.gemini.apiKey", "GEMINI_API_KEY"),
        });
      case "ollama":
        return new OllamaProvider({
          ...this.baseConfig("ollama", baseExtras),
          model: providerEntry.model ?? "llama3.1",
          baseUrl: providerEntry.baseUrl ?? "http://localhost:11434",
          // apiKey from YAML (operator-issued) takes precedence over SecretStorage
          apiKey:
            providerEntry.apiKey ??
            (await getKey("champ.ollama.apiKey", "OLLAMA_API_KEY")),
        });
      case "llamacpp":
        return new LlamaCppProvider({
          ...this.baseConfig("llamacpp", baseExtras),
          model: providerEntry.model ?? "default",
          baseUrl: providerEntry.baseUrl ?? "http://localhost:8080/v1",
          apiKey:
            providerEntry.apiKey ??
            (await getKey("champ.llamacpp.apiKey", "LLAMACPP_API_KEY")),
          supportsTools: providerEntry.supportsTools,
        });
      case "vllm":
        return new VLLMProvider({
          ...this.baseConfig("vllm", baseExtras),
          model: providerEntry.model ?? "",
          baseUrl: providerEntry.baseUrl ?? "http://localhost:8000/v1",
          apiKey:
            providerEntry.apiKey ??
            (await getKey("champ.vllm.apiKey", "VLLM_API_KEY")),
          supportsTools: providerEntry.supportsTools,
        });
      case "openai-compatible":
        return new OpenAICompatibleProvider({
          ...this.baseConfig("openai-compatible", baseExtras),
          model: providerEntry.model ?? "default",
          baseUrl: providerEntry.baseUrl ?? "",
          apiKey:
            providerEntry.apiKey ??
            (await getKey(
              "champ.openaiCompatible.apiKey",
              "OPENAI_COMPATIBLE_API_KEY",
            )),
          supportsTools: providerEntry.supportsTools,
        });
      default: {
        const _exhaustive: never = providerName as never;
        throw new Error(`Unknown provider: "${_exhaustive as string}"`);
      }
    }
  }

  private baseConfig(
    provider: string,
    extras: Partial<Omit<LLMProviderConfig, "provider" | "model">> = {},
  ): Omit<LLMProviderConfig, "model"> {
    return {
      provider,
      maxTokens: 4096,
      temperature: 0.7,
      ...extras,
    };
  }
}
