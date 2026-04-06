/**
 * LlamaCppProvider: local llama.cpp server wrapper.
 *
 * llama.cpp's `llama-server` exposes an OpenAI-compatible API at
 * /v1/chat/completions, so this is a thin wrapper over
 * OpenAICompatibleProvider with a sensible default URL (port 8080 is
 * the llama.cpp server default).
 */
import { OpenAICompatibleProvider } from "./openai-compatible";
import type { LLMProviderConfig } from "./types";

const DEFAULT_BASE_URL = "http://localhost:8080/v1";

export class LlamaCppProvider extends OpenAICompatibleProvider {
  constructor(config: LLMProviderConfig) {
    super(
      {
        ...config,
        baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      },
      "llamacpp",
    );
  }
}
