/**
 * TDD: Tests for ProviderFactory (YAML-only since #118).
 * Reads a ChampConfig + secret storage, returns an LLMProvider.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ProviderFactory } from "@/providers/factory";

/**
 * Minimal fake for vscode.SecretStorage so tests don't depend on the
 * extension host.
 */
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

  describe("createFromChampConfig (YAML path)", () => {
    it("creates a llamacpp provider from a parsed ChampConfig", async () => {
      const provider = await factory.createFromChampConfig(
        {
          provider: "llamacpp",
          providers: {
            llamacpp: {
              baseUrl: "http://192.168.1.24:21434/v1",
              model: "Qwen2.5-Coder-7B-Instruct.gguf",
            },
          },
        },
        createFakeSecrets({}) as never,
      );
      expect(provider.name).toBe("llamacpp");
      expect(provider.config.baseUrl).toBe("http://192.168.1.24:21434/v1");
      expect(provider.config.model).toBe("Qwen2.5-Coder-7B-Instruct.gguf");
    });

    it("creates a claude provider with the api key from SecretStorage", async () => {
      const provider = await factory.createFromChampConfig(
        {
          provider: "claude",
          providers: { claude: { model: "claude-sonnet-4-20250514" } },
        },
        createFakeSecrets({ "champ.claude.apiKey": "sk-ant-test" }) as never,
      );
      expect(provider.name).toBe("claude");
      expect(provider.config.apiKey).toBe("sk-ant-test");
    });

    it("falls back to per-provider defaults when fields are unset", async () => {
      const provider = await factory.createFromChampConfig(
        { provider: "ollama", providers: { ollama: {} } },
        createFakeSecrets({}) as never,
      );
      expect(provider.name).toBe("ollama");
      expect(provider.config.baseUrl).toBe("http://localhost:11434");
      expect(provider.config.model).toBe("llama3.1");
    });

    it("defaults to claude when no provider is specified", async () => {
      const provider = await factory.createFromChampConfig(
        {},
        createFakeSecrets({ "champ.claude.apiKey": "k" }) as never,
      );
      expect(provider.name).toBe("claude");
    });

    it("works for every supported provider name", async () => {
      const cases = [
        { name: "claude", entry: { model: "claude-sonnet-4-20250514" } },
        { name: "openai", entry: { model: "gpt-4o" } },
        { name: "gemini", entry: { model: "gemini-2.0-flash" } },
        {
          name: "ollama",
          entry: { baseUrl: "http://localhost:11434", model: "llama3.1" },
        },
        {
          name: "llamacpp",
          entry: { baseUrl: "http://localhost:8080/v1", model: "default" },
        },
        {
          name: "vllm",
          entry: { baseUrl: "http://localhost:8000/v1", model: "x" },
        },
        {
          name: "openai-compatible",
          entry: { baseUrl: "http://localhost:9000/v1", model: "x" },
        },
      ] as const;

      for (const c of cases) {
        const provider = await factory.createFromChampConfig(
          { provider: c.name, providers: { [c.name]: c.entry } },
          createFakeSecrets({
            "champ.claude.apiKey": "k",
            "champ.openai.apiKey": "k",
            "champ.gemini.apiKey": "k",
          }) as never,
        );
        expect(provider.name).toBe(c.name);
      }
    });
  });
});
