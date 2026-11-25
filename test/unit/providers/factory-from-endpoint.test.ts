import { describe, expect, it, vi } from "vitest";
import type { Endpoint, ProviderKind } from "@/config/provider-model";
import { ClaudeProvider } from "@/providers/claude";
import { ProviderFactory, type SecretReader } from "@/providers/factory";
import { GeminiProvider } from "@/providers/gemini";
import { LlamaCppProvider } from "@/providers/llamacpp";
import { OllamaProvider } from "@/providers/ollama";
import { OpenAIProvider } from "@/providers/openai";
import { OpenAICompatibleProvider } from "@/providers/openai-compatible";
import { VLLMProvider } from "@/providers/vllm";

describe("ProviderFactory.createFromEndpoint", () => {
  const cases: Array<{
    kind: ProviderKind;
    ctor: new (...args: never[]) => unknown;
  }> = [
    { kind: "claude", ctor: ClaudeProvider },
    { kind: "openai", ctor: OpenAIProvider },
    { kind: "gemini", ctor: GeminiProvider },
    { kind: "ollama", ctor: OllamaProvider },
    { kind: "llamacpp", ctor: LlamaCppProvider },
    { kind: "vllm", ctor: VLLMProvider },
    { kind: "openai-compatible", ctor: OpenAICompatibleProvider },
  ];

  it.each(cases)(
    "maps provider kind $kind to the expected provider class",
    async ({ kind, ctor }) => {
      const factory = new ProviderFactory();
      const endpoint: Endpoint = {
        id: `ep_${kind}`,
        name: `Test ${kind}`,
        provider: kind,
        baseUrl: kind === "claude" ? undefined : "http://localhost:9999/v1",
        credential: { kind: "keyring", id: `ep_${kind}` },
        enabled: true,
        isDefault: true,
        models: [{ id: "test-model" }],
      };
      const secretProvider: SecretReader = {
        get: vi.fn(async (key: string) =>
          key === `ep_${kind}` ? "sk-secret" : undefined,
        ),
      };

      const provider = await factory.createFromEndpoint(endpoint, {
        model: "test-model",
        secretProvider,
      });

      expect(provider).toBeInstanceOf(ctor);
      expect(provider.config.model).toBe("test-model");
    },
  );

  it("supplies the secret via SecretReader without storing it on the endpoint object", async () => {
    const factory = new ProviderFactory();
    const endpoint: Endpoint = {
      id: "ep_custom_cred",
      name: "Custom Protected",
      provider: "openai-compatible",
      baseUrl: "http://localhost:8080/v1",
      credential: { kind: "keyring", id: "ep_custom_cred" },
      enabled: true,
      isDefault: true,
      models: [{ id: "qwen2.5-coder" }],
    };
    const secretProvider: SecretReader = {
      get: vi.fn(async (key: string) =>
        key === "ep_custom_cred" ? "sk-via-reader" : undefined,
      ),
    };

    const provider = await factory.createFromEndpoint(endpoint, {
      model: "qwen2.5-coder",
      secretProvider,
    });

    expect(secretProvider.get).toHaveBeenCalledWith("ep_custom_cred");
    expect(provider.config.apiKey).toBe("sk-via-reader");
    expect(
      (endpoint as unknown as Record<string, unknown>).apiKey,
    ).toBeUndefined();
  });

  it("threads contextWindow and supportsTools through to the built provider", async () => {
    const factory = new ProviderFactory();
    const endpoint: Endpoint = {
      id: "ep_opts",
      name: "Tools + Window",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      credential: null,
      enabled: true,
      isDefault: true,
      supportsTools: true,
      contextWindow: 16384,
      models: [{ id: "qwen" }],
    };
    const secretProvider: SecretReader = {
      get: async () => undefined,
    };

    const fromEndpoint = await factory.createFromEndpoint(endpoint, {
      model: "qwen",
      secretProvider,
    });
    expect(fromEndpoint.supportsToolUse()).toBe(true);
    expect(fromEndpoint.config.contextWindow).toBe(16384);

    const overridden = await factory.createFromEndpoint(endpoint, {
      model: "qwen",
      secretProvider,
      contextWindow: 32768,
    });
    expect(overridden.config.contextWindow).toBe(32768);
  });

  it("threads endpoint.maxTokens through to the built provider", async () => {
    const factory = new ProviderFactory();
    const endpoint: Endpoint = {
      id: "ep_tokens",
      name: "Token budget",
      provider: "vllm",
      baseUrl: "http://localhost:8000/v1",
      credential: null,
      enabled: true,
      isDefault: true,
      contextWindow: 8192,
      maxTokens: 2048,
      models: [{ id: "qwen" }],
    };

    const provider = await factory.createFromEndpoint(endpoint, {
      model: "qwen",
      secretProvider: { get: async () => undefined },
    });
    expect(provider.config.maxTokens).toBe(2048);
  });

  it("never passes literal 'default' to cloud providers when endpoint models are empty", async () => {
    const factory = new ProviderFactory();
    const secretProvider: SecretReader = { get: async () => "sk-test" };

    const claude = await factory.createFromEndpoint(
      {
        id: "ep_c",
        name: "Claude",
        provider: "claude",
        credential: null,
        enabled: true,
        isDefault: true,
        models: [],
      },
      { model: "default", secretProvider },
    );
    expect(claude.config.model).toBe("claude-sonnet-4-20250514");

    const gemini = await factory.createFromEndpoint(
      {
        id: "ep_g",
        name: "Gemini",
        provider: "gemini",
        credential: null,
        enabled: true,
        isDefault: false,
        models: [],
      },
      { model: "", secretProvider },
    );
    expect(gemini.config.model).toBe("gemini-2.0-flash");
  });
});
