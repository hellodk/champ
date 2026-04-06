/**
 * TDD: Tests for LlamaCppProvider and VLLMProvider.
 * These are thin wrappers over OpenAICompatibleProvider with sensible defaults.
 */
import { describe, it, expect } from "vitest";
import { LlamaCppProvider } from "@/providers/llamacpp";
import { VLLMProvider } from "@/providers/vllm";

describe("LlamaCppProvider", () => {
  it("should default baseUrl to localhost:8080", () => {
    const provider = new LlamaCppProvider({
      provider: "llamacpp",
      model: "default",
      maxTokens: 2048,
      temperature: 0.7,
    });
    expect(provider.config.baseUrl).toContain("8080");
  });

  it('should have name "llamacpp"', () => {
    const provider = new LlamaCppProvider({
      provider: "llamacpp",
      model: "default",
      maxTokens: 2048,
      temperature: 0.7,
    });
    expect(provider.name).toBe("llamacpp");
  });

  it("should honor custom baseUrl", () => {
    const provider = new LlamaCppProvider({
      provider: "llamacpp",
      model: "default",
      baseUrl: "http://remote-host:1234/v1",
      maxTokens: 2048,
      temperature: 0.7,
    });
    expect(provider.config.baseUrl).toBe("http://remote-host:1234/v1");
  });

  it("should support streaming", () => {
    const provider = new LlamaCppProvider({
      provider: "llamacpp",
      model: "default",
      maxTokens: 2048,
      temperature: 0.7,
    });
    expect(provider.supportsStreaming()).toBe(true);
  });
});

describe("VLLMProvider", () => {
  it("should default baseUrl to localhost:8000", () => {
    const provider = new VLLMProvider({
      provider: "vllm",
      model: "meta-llama/Llama-3.1-8B",
      maxTokens: 4096,
      temperature: 0.7,
    });
    expect(provider.config.baseUrl).toContain("8000");
  });

  it('should have name "vllm"', () => {
    const provider = new VLLMProvider({
      provider: "vllm",
      model: "meta-llama/Llama-3.1-8B",
      maxTokens: 4096,
      temperature: 0.7,
    });
    expect(provider.name).toBe("vllm");
  });

  it("should honor custom baseUrl", () => {
    const provider = new VLLMProvider({
      provider: "vllm",
      model: "meta-llama/Llama-3.1-8B",
      baseUrl: "http://gpu-host:9000/v1",
      maxTokens: 4096,
      temperature: 0.7,
    });
    expect(provider.config.baseUrl).toBe("http://gpu-host:9000/v1");
  });
});
