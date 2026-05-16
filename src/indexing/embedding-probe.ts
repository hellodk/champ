import {
  isOllamaReachable,
  isEmbeddingModelAvailable,
} from "../marketplace/mcp-marketplace-client";
import type { ChampConfig } from "../config/config-loader";

export type EmbeddingProbeResult =
  | { available: true; provider: "ollama" | "openai" }
  | {
      available: false;
      reason: "ollama-unreachable" | "model-not-found" | "openai-key-absent";
    };

export async function probeEmbeddingProvider(
  config: ChampConfig,
  getSecret: (name: string) => Promise<string | undefined>,
): Promise<EmbeddingProbeResult> {
  const indexingConfig = config.indexing;

  // IndexingConfig uses `embeddingProvider` for the provider name.
  if (indexingConfig?.embeddingProvider === "openai") {
    const key = await getSecret("champ.openaiApiKey");
    if (key && key.length > 0) {
      return { available: true, provider: "openai" };
    }
    return { available: false, reason: "openai-key-absent" };
  }

  // Default: probe local Ollama instance.
  // IndexingConfig doesn't have a baseUrl field, but we allow it as an
  // extension via the config object for future flexibility.
  const baseUrl =
    (indexingConfig as { baseUrl?: string } | undefined)?.baseUrl ??
    "http://localhost:11434";
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
