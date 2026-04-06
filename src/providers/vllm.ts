/**
 * VLLMProvider: vLLM inference server wrapper.
 *
 * vLLM exposes an OpenAI-compatible API, so this is a thin wrapper over
 * OpenAICompatibleProvider. vLLM defaults to port 8000.
 */
import { OpenAICompatibleProvider } from "./openai-compatible";
import type { LLMProviderConfig } from "./types";

const DEFAULT_BASE_URL = "http://localhost:8000/v1";

export class VLLMProvider extends OpenAICompatibleProvider {
  constructor(config: LLMProviderConfig) {
    super(
      {
        ...config,
        baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      },
      "vllm",
    );
  }
}
