/**
 * ProviderFactory: builds an LLMProvider from VS Code settings.
 *
 * Encapsulates the logic of reading `champ.*` configuration values
 * plus API keys from SecretStorage and instantiating the right
 * provider subclass. The extension activation code calls this once
 * at startup and whenever the user changes the active provider.
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
 * Narrow interface matching the subset of vscode.WorkspaceConfiguration
 * we actually use. Accepted as a parameter so tests can pass a plain
 * object without importing vscode.
 */
export interface ConfigReader {
  get<T>(section: string): T | undefined;
}

/**
 * Narrow interface matching vscode.SecretStorage. Tests provide a fake.
 * Uses PromiseLike so vscode.SecretStorage's Thenable return is
 * assignable without wrapping.
 */
export interface SecretReader {
  get(key: string): PromiseLike<string | undefined>;
}

/**
 * Config defaults applied when the user hasn't set the value.
 */
const DEFAULTS: Record<string, unknown> = {
  "claude.model": "claude-sonnet-4-20250514",
  "openai.model": "gpt-4o",
  "gemini.model": "gemini-2.0-flash",
  "ollama.baseUrl": "http://localhost:11434",
  "ollama.model": "llama3.1",
  "llamacpp.baseUrl": "http://localhost:8080/v1",
  "llamacpp.model": "default",
  "vllm.baseUrl": "http://localhost:8000/v1",
};

export class ProviderFactory {
  /**
   * Build a provider instance from the current configuration snapshot.
   *
   * @param config - VS Code configuration (or a fake in tests)
   * @param secrets - SecretStorage (or a fake in tests)
   */
  async createFromConfig(
    config: ConfigReader,
    secrets: SecretReader,
  ): Promise<LLMProvider> {
    const providerId = this.read<string>(config, "provider") ?? "claude";

    switch (providerId) {
      case "claude":
        return this.createClaude(config, secrets);
      case "openai":
        return this.createOpenAI(config, secrets);
      case "gemini":
        return this.createGemini(config, secrets);
      case "ollama":
        return this.createOllama(config);
      case "llamacpp":
        return this.createLlamaCpp(config);
      case "vllm":
        return this.createVLLM(config, secrets);
      case "openai-compatible":
        return this.createOpenAICompatible(config, secrets);
      default:
        throw new Error(`Unknown provider: "${providerId}"`);
    }
  }

  private read<T>(config: ConfigReader, section: string): T | undefined {
    const value = config.get<T>(section);
    if (value !== undefined && value !== null && value !== "") return value;
    return DEFAULTS[section] as T | undefined;
  }

  /**
   * Build a provider instance from a parsed ChampConfig (YAML-based).
   *
   * Unlike createFromConfig() which reads flat champ.* keys from VS
   * Code's settings.json, this path takes a structured ChampConfig
   * (typically loaded from .champ/config.yaml). API keys still come
   * from SecretStorage — never from YAML.
   */
  async createFromChampConfig(
    config: ChampConfig,
    secrets: SecretReader,
  ): Promise<LLMProvider> {
    const providerName = config.provider ?? "claude";
    const providerEntry = config.providers?.[providerName] ?? {};

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
          ...this.baseConfig("claude"),
          model: providerEntry.model ?? "claude-sonnet-4-20250514",
          apiKey: await getKey("champ.claude.apiKey", "ANTHROPIC_API_KEY"),
        });
      case "openai":
        return new OpenAIProvider({
          ...this.baseConfig("openai"),
          model: providerEntry.model ?? "gpt-4o",
          apiKey: await getKey("champ.openai.apiKey", "OPENAI_API_KEY"),
        });
      case "gemini":
        return new GeminiProvider({
          ...this.baseConfig("gemini"),
          model: providerEntry.model ?? "gemini-2.0-flash",
          apiKey: await getKey("champ.gemini.apiKey", "GEMINI_API_KEY"),
        });
      case "ollama":
        return new OllamaProvider({
          ...this.baseConfig("ollama"),
          model: providerEntry.model ?? "llama3.1",
          baseUrl: providerEntry.baseUrl ?? "http://localhost:11434",
        });
      case "llamacpp":
        return new LlamaCppProvider({
          ...this.baseConfig("llamacpp"),
          model: providerEntry.model ?? "default",
          baseUrl: providerEntry.baseUrl ?? "http://localhost:8080/v1",
        });
      case "vllm":
        return new VLLMProvider({
          ...this.baseConfig("vllm"),
          model: providerEntry.model ?? "",
          baseUrl: providerEntry.baseUrl ?? "http://localhost:8000/v1",
          apiKey: await getKey("champ.vllm.apiKey", "VLLM_API_KEY"),
        });
      case "openai-compatible":
        return new OpenAICompatibleProvider({
          ...this.baseConfig("openai-compatible"),
          model: providerEntry.model ?? "default",
          baseUrl: providerEntry.baseUrl ?? "",
          apiKey: await getKey(
            "champ.openaiCompatible.apiKey",
            "OPENAI_COMPATIBLE_API_KEY",
          ),
        });
      default: {
        const _exhaustive: never = providerName as never;
        throw new Error(`Unknown provider: "${_exhaustive as string}"`);
      }
    }
  }

  private baseConfig(provider: string): Omit<LLMProviderConfig, "model"> {
    return {
      provider,
      maxTokens: 4096,
      temperature: 0.7,
    };
  }

  private async createClaude(
    config: ConfigReader,
    secrets: SecretReader,
  ): Promise<LLMProvider> {
    const apiKey = await secrets.get("champ.claude.apiKey");
    return new ClaudeProvider({
      ...this.baseConfig("claude"),
      model:
        this.read<string>(config, "claude.model") ?? "claude-sonnet-4-20250514",
      apiKey,
    });
  }

  private async createOpenAI(
    config: ConfigReader,
    secrets: SecretReader,
  ): Promise<LLMProvider> {
    const apiKey = await secrets.get("champ.openai.apiKey");
    return new OpenAIProvider({
      ...this.baseConfig("openai"),
      model: this.read<string>(config, "openai.model") ?? "gpt-4o",
      apiKey,
    });
  }

  private async createGemini(
    config: ConfigReader,
    secrets: SecretReader,
  ): Promise<LLMProvider> {
    const apiKey = await secrets.get("champ.gemini.apiKey");
    return new GeminiProvider({
      ...this.baseConfig("gemini"),
      model: this.read<string>(config, "gemini.model") ?? "gemini-2.0-flash",
      apiKey,
    });
  }

  private createOllama(config: ConfigReader): LLMProvider {
    return new OllamaProvider({
      ...this.baseConfig("ollama"),
      model: this.read<string>(config, "ollama.model") ?? "llama3.1",
      baseUrl:
        this.read<string>(config, "ollama.baseUrl") ?? "http://localhost:11434",
    });
  }

  private createLlamaCpp(config: ConfigReader): LLMProvider {
    return new LlamaCppProvider({
      ...this.baseConfig("llamacpp"),
      model: this.read<string>(config, "llamacpp.model") ?? "default",
      baseUrl:
        this.read<string>(config, "llamacpp.baseUrl") ??
        "http://localhost:8080/v1",
    });
  }

  private async createVLLM(
    config: ConfigReader,
    secrets: SecretReader,
  ): Promise<LLMProvider> {
    const apiKey = await secrets.get("champ.vllm.apiKey");
    return new VLLMProvider({
      ...this.baseConfig("vllm"),
      model: this.read<string>(config, "vllm.model") ?? "",
      baseUrl:
        this.read<string>(config, "vllm.baseUrl") ?? "http://localhost:8000/v1",
      apiKey,
    });
  }

  private async createOpenAICompatible(
    config: ConfigReader,
    secrets: SecretReader,
  ): Promise<LLMProvider> {
    const apiKey = await secrets.get("champ.openaiCompatible.apiKey");
    return new OpenAICompatibleProvider({
      ...this.baseConfig("openai-compatible"),
      model: this.read<string>(config, "openaiCompatible.model") ?? "default",
      baseUrl: this.read<string>(config, "openaiCompatible.baseUrl") ?? "",
      apiKey,
    });
  }
}
