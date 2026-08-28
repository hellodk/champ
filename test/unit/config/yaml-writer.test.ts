/**
 * TDD: YAML merge-writer for guided setup (ticket #118).
 * The wizard updates one provider block in .champ/config.yaml while
 * preserving every other hand-edited section.
 */
import { describe, it, expect } from "vitest";
import * as yamlJs from "js-yaml";
import {
  upsertProviderInYaml,
  providerExistsInYaml,
  type ProviderYamlPatch,
} from "@/config/yaml-writer";

const buildBlock = (providerId: string, overrides = {}): ProviderYamlPatch => ({
  providerId,
  baseUrl: "http://192.168.1.40:8000/v1",
  model: "code-model-7b",
  ...overrides,
});

describe("upsertProviderInYaml (#118)", () => {
  it("creates a fresh config when the file is empty", () => {
    const { yaml, created } = upsertProviderInYaml("", buildBlock("ollama"));
    const parsed = yamlJs.load(yaml) as Record<string, unknown>;
    expect(created).toBe(true);
    expect(parsed.providers).toEqual({
      ollama: {
        baseUrl: "http://192.168.1.40:8000/v1",
        model: "code-model-7b",
      },
    });
  });

  it("sets the active provider when asked", () => {
    const { yaml } = upsertProviderInYaml("", buildBlock("ollama"), {
      setActive: true,
    });
    const parsed = yamlJs.load(yaml) as Record<string, unknown>;
    expect(parsed.provider).toBe("ollama");
  });

  it("preserves unrelated sections when adding a provider", () => {
    const existing = `
provider: claude
providers:
  claude:
    model: claude-sonnet-4-20250514
autocomplete:
  enabled: true
  debounceMs: 300
agent:
  yoloMode: true
`;
    const { yaml } = upsertProviderInYaml(existing, buildBlock("llamacpp"));
    const parsed = yamlJs.load(yaml) as Record<string, unknown>;
    expect(parsed.autocomplete).toEqual({ enabled: true, debounceMs: 300 });
    expect(parsed.agent).toEqual({ yoloMode: true });
    expect((parsed.providers as Record<string, unknown>).claude).toEqual({
      model: "claude-sonnet-4-20250514",
    });
    expect(
      (parsed.providers as Record<string, unknown>).llamacpp,
    ).toMatchObject({ model: "code-model-7b" });
  });

  it("updates an existing provider block without touching others", () => {
    const existing = `
provider: ollama
providers:
  ollama:
    baseUrl: http://localhost:11434
    model: llama3.1
  claude:
    model: claude-sonnet-4-20250514
`;
    const { yaml } = upsertProviderInYaml(
      existing,
      {
        providerId: "ollama",
        baseUrl: "http://192.168.1.99:11434",
        model: "qwen3:8b",
      },
      { setActive: true },
    );
    const parsed = yamlJs.load(yaml) as {
      provider: string;
      providers: {
        ollama: { baseUrl: string; model: string };
        claude: unknown;
      };
    };
    expect(parsed.provider).toBe("ollama");
    expect(parsed.providers.ollama).toEqual({
      baseUrl: "http://192.168.1.99:11434",
      model: "qwen3:8b",
    });
    expect(parsed.providers.claude).toEqual({
      model: "claude-sonnet-4-20250514",
    });
  });

  it("writes the options and contextWindow block", () => {
    const { yaml } = upsertProviderInYaml(
      "",
      buildBlock("ollama", {
        contextWindow: 16384,
        options: { temperature: 0.25, topP: 0.95, seed: 42 },
      }),
    );
    const parsed = yamlJs.load(yaml) as {
      providers: {
        ollama: {
          contextWindow: number;
          options: { temperature: number; seed: number };
        };
      };
    };
    expect(parsed.providers.ollama.contextWindow).toBe(16384);
    expect(parsed.providers.ollama.options).toEqual({
      temperature: 0.25,
      topP: 0.95,
      seed: 42,
    });
  });

  it("merges into an existing block (old keys kept, new ones added)", () => {
    const existing = `
providers:
  ollama:
    baseUrl: http://localhost:11434
    model: llama3.1
`;
    const { yaml } = upsertProviderInYaml(existing, {
      providerId: "ollama",
      model: "qwen3:8b",
      options: { temperature: 0.2 },
    });
    const parsed = yamlJs.load(yaml) as {
      providers: { ollama: Record<string, unknown> };
    };
    // baseUrl untouched, model replaced, options added
    expect(parsed.providers.ollama.baseUrl).toBe("http://localhost:11434");
    expect(parsed.providers.ollama.model).toBe("qwen3:8b");
    expect(parsed.providers.ollama.options).toEqual({ temperature: 0.2 });
  });
});

describe("providerExistsInYaml (#118)", () => {
  it("detects an existing provider", () => {
    const existing = `
provider: ollama
providers:
  ollama:
    model: llama3.1
`;
    expect(providerExistsInYaml(existing, "ollama")).toBe(true);
    expect(providerExistsInYaml(existing, "llamacpp")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(providerExistsInYaml("", "ollama")).toBe(false);
    expect(providerExistsInYaml(undefined, "ollama")).toBe(false);
  });
});
