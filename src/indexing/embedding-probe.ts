import {
  isOllamaReachable,
  isEmbeddingModelAvailable,
} from "../marketplace/mcp-marketplace-client";
import type { ChampConfig } from "../config/config-loader";

export type EmbeddingProbeResult =
  | { available: true; provider: "ollama" | "openai" }
  | {
      available: false;
      reason:
        | "ollama-unreachable"
        | "model-not-found"
        | "openai-key-absent"
        | "openai-unreachable";
    };

/** Normalise an endpoint so joining `/models` never produces a double slash. */
function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

export async function probeEmbeddingProvider(
  config: ChampConfig,
  getSecret: (name: string) => Promise<string | undefined>,
): Promise<EmbeddingProbeResult> {
  const indexingConfig = config.indexing;
  const provider = indexingConfig?.embeddingProvider ?? "ollama";

  if (
    provider === "openai" ||
    provider === "openai-compatible" ||
    provider === "vllm"
  ) {
    const apiKey =
      indexingConfig?.apiKey ??
      (provider === "openai"
        ? await getSecret("champ.openaiApiKey")
        : undefined);
    if (provider === "openai" && !apiKey) {
      return { available: false, reason: "openai-key-absent" };
    }
    const baseUrl = indexingConfig?.baseUrl;
    if (!baseUrl) {
      // Historic behaviour: OpenAI itself needs no reachability probe when no
      // explicit endpoint is configured.
      return provider === "openai"
        ? { available: true, provider: "openai" }
        : { available: false, reason: "openai-unreachable" };
    }
    try {
      const response = await fetch(modelsUrl(baseUrl), {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      if (!response.ok) {
        return { available: false, reason: "openai-unreachable" };
      }
      return { available: true, provider: "openai" };
    } catch {
      return { available: false, reason: "openai-unreachable" };
    }
  }

  // Ollama (default): probe the configured endpoint, falling back to localhost.
  const baseUrl = indexingConfig?.baseUrl ?? "http://localhost:11434";
  const reachable = await isOllamaReachable(baseUrl);
  if (!reachable) {
    return { available: false, reason: "ollama-unreachable" };
  }

  const modelName = indexingConfig?.embeddingModel;
  if (modelName) {
    const modelAvailable = await isEmbeddingModelAvailable(modelName, baseUrl);
    if (!modelAvailable) {
      return { available: false, reason: "model-not-found" };
    }
  }

  return { available: true, provider: "ollama" };
}
