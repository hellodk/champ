/**
 * TDD: supportsTools opt-in for OpenAI-compatible providers.
 *
 * Contract: OpenAICompatibleProvider.supportsToolUse() defaults to false,
 * but an explicit `supportsTools: true` in the provider config enables the
 * native OpenAI tools path — required for spec-compliant servers whose
 * models are not in champ's hardcoded capability lists.
 */
import { describe, it, expect } from "vitest";
import { OpenAICompatibleProvider } from "@/providers/openai-compatible";
import { ConfigLoader } from "@/config/config-loader";

const base = {
  provider: "openai-compatible",
  baseUrl: "http://localhost:8000/v1",
  model: "m",
  maxTokens: 100,
  temperature: 0,
};

describe("supportsTools opt-in", () => {
  it("defaults to false (safe behaviour for unknown servers)", () => {
    const p = new OpenAICompatibleProvider({ ...base });
    expect(p.supportsToolUse()).toBe(false);
  });

  it("returns true when config.supportsTools is true", () => {
    const p = new OpenAICompatibleProvider({
      ...base,
      supportsTools: true,
    });
    expect(p.supportsToolUse()).toBe(true);
  });

  it("parses supportsTools from YAML and survives validate+merge+defaults", () => {
    const yaml = `
provider: openai-compatible
providers:
  openai-compatible:
    baseUrl: http://192.168.1.5:8000/v1
    model: default
    apiKey: dummy
    supportsTools: true
`;
    const parsed = ConfigLoader.parseYaml(yaml);
    expect(parsed.providers?.["openai-compatible"]?.supportsTools).toBe(true);

    const merged = ConfigLoader.merge({}, parsed);
    expect(merged.providers?.["openai-compatible"]?.supportsTools).toBe(true);
  });

  it("rejects a non-boolean supportsTools", () => {
    const yaml = `
providers:
  openai-compatible:
    baseUrl: http://x/v1
    model: m
    supportsTools: "yes"
`;
    expect(() => ConfigLoader.parseYaml(yaml)).toThrow(/supportsTools/);
  });
});
