/**
 * TDD: Tests for ProviderFactory.
 * Reads VS Code config + secret storage, returns an LLMProvider.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProviderFactory } from "@/providers/factory";

/**
 * Minimal fake for vscode.WorkspaceConfiguration and SecretStorage so
 * tests don't depend on the extension host.
 */
function createFakeConfig(values: Record<string, unknown>) {
  return {
    get: vi.fn((key: string) => values[key]),
    has: vi.fn((key: string) => key in values),
    update: vi.fn(),
    inspect: vi.fn(),
  };
}

function createFakeSecrets(values: Record<string, string>) {
  return {
    get: vi.fn(async (key: string) => values[key]),
    store: vi.fn(),
    delete: vi.fn(),
  };
}

describe("ProviderFactory", () => {
  let factory: ProviderFactory;

  beforeEach(() => {
    factory = new ProviderFactory();
  });

  it("creates a ClaudeProvider from config", async () => {
    const config = createFakeConfig({
      provider: "claude",
      "claude.model": "claude-sonnet-4-20250514",
    }) as never;
    const secrets = createFakeSecrets({
      "aidev.claude.apiKey": "test-key",
    }) as never;

    const provider = await factory.createFromConfig(config, secrets);
    expect(provider.name).toBe("claude");
    expect(provider.config.model).toBe("claude-sonnet-4-20250514");
  });

  it("creates an OpenAIProvider from config", async () => {
    const config = createFakeConfig({
      provider: "openai",
      "openai.model": "gpt-4o",
    }) as never;
    const secrets = createFakeSecrets({
      "aidev.openai.apiKey": "sk-test",
    }) as never;

    const provider = await factory.createFromConfig(config, secrets);
    expect(provider.name).toBe("openai");
    expect(provider.config.model).toBe("gpt-4o");
  });

  it("creates a GeminiProvider from config", async () => {
    const config = createFakeConfig({
      provider: "gemini",
      "gemini.model": "gemini-2.0-flash",
    }) as never;
    const secrets = createFakeSecrets({
      "aidev.gemini.apiKey": "key",
    }) as never;

    const provider = await factory.createFromConfig(config, secrets);
    expect(provider.name).toBe("gemini");
  });

  it("creates an OllamaProvider without API key", async () => {
    const config = createFakeConfig({
      provider: "ollama",
      "ollama.baseUrl": "http://localhost:11434",
      "ollama.model": "llama3.1",
    }) as never;
    const secrets = createFakeSecrets({}) as never;

    const provider = await factory.createFromConfig(config, secrets);
    expect(provider.name).toBe("ollama");
    expect(provider.config.baseUrl).toBe("http://localhost:11434");
  });

  it("creates a LlamaCppProvider", async () => {
    const config = createFakeConfig({
      provider: "llamacpp",
      "llamacpp.baseUrl": "http://localhost:8080/v1",
      "llamacpp.model": "default",
    }) as never;
    const secrets = createFakeSecrets({}) as never;

    const provider = await factory.createFromConfig(config, secrets);
    expect(provider.name).toBe("llamacpp");
  });

  it("creates a VLLMProvider", async () => {
    const config = createFakeConfig({
      provider: "vllm",
      "vllm.baseUrl": "http://localhost:8000/v1",
      "vllm.model": "meta-llama/Llama-3.1-8B",
    }) as never;
    const secrets = createFakeSecrets({}) as never;

    const provider = await factory.createFromConfig(config, secrets);
    expect(provider.name).toBe("vllm");
  });

  it("creates an openai-compatible provider", async () => {
    const config = createFakeConfig({
      provider: "openai-compatible",
      "openaiCompatible.baseUrl": "http://custom-server:9000/v1",
      "openaiCompatible.model": "my-model",
    }) as never;
    const secrets = createFakeSecrets({
      "aidev.openaiCompatible.apiKey": "key",
    }) as never;

    const provider = await factory.createFromConfig(config, secrets);
    expect(provider.name).toBe("openai-compatible");
  });

  it("throws for unknown provider", async () => {
    const config = createFakeConfig({ provider: "nonsense" }) as never;
    const secrets = createFakeSecrets({}) as never;

    await expect(factory.createFromConfig(config, secrets)).rejects.toThrow();
  });
});
