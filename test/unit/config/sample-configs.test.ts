/**
 * TDD: Tests for the 5 built-in sample configurations used by the
 * onboarding flow. Each sample must parse cleanly and resolve to a
 * valid active provider.
 */
import { describe, it, expect } from "vitest";
import { SAMPLE_CONFIGS, type SampleConfig } from "@/config/sample-configs";
import { ConfigLoader } from "@/config/config-loader";

describe("Sample Configs (onboarding templates)", () => {
  it("ships exactly 5 sample configs", () => {
    expect(SAMPLE_CONFIGS).toHaveLength(5);
  });

  it("every sample has id, label, description, and yaml", () => {
    for (const cfg of SAMPLE_CONFIGS) {
      expect(typeof cfg.id).toBe("string");
      expect(cfg.id.length).toBeGreaterThan(0);
      expect(typeof cfg.label).toBe("string");
      expect(cfg.label.length).toBeGreaterThan(0);
      expect(typeof cfg.description).toBe("string");
      expect(cfg.description.length).toBeGreaterThan(0);
      expect(typeof cfg.yaml).toBe("string");
      expect(cfg.yaml.length).toBeGreaterThan(0);
    }
  });

  it("every yaml parses cleanly via ConfigLoader", () => {
    for (const cfg of SAMPLE_CONFIGS) {
      expect(() => ConfigLoader.parseYaml(cfg.yaml)).not.toThrow();
    }
  });

  it("every yaml resolves to a valid active provider config", () => {
    for (const cfg of SAMPLE_CONFIGS) {
      const parsed = ConfigLoader.parseYaml(cfg.yaml);
      const withDefaults = ConfigLoader.withDefaults(parsed);
      expect(() =>
        ConfigLoader.activeProviderConfig(withDefaults),
      ).not.toThrow();
      const active = ConfigLoader.activeProviderConfig(withDefaults);
      expect(active.name).toBeTruthy();
    }
  });

  it("ollama-basic uses ollama provider", () => {
    const cfg = SAMPLE_CONFIGS.find((c) => c.id === "ollama-basic");
    expect(cfg).toBeDefined();
    const parsed = ConfigLoader.parseYaml(cfg!.yaml);
    expect(parsed.provider).toBe("ollama");
  });

  it("cloud-hybrid uses claude as chat + ollama as autocomplete", () => {
    const cfg = SAMPLE_CONFIGS.find((c) => c.id === "cloud-hybrid");
    expect(cfg).toBeDefined();
    const parsed = ConfigLoader.parseYaml(cfg!.yaml);
    expect(parsed.provider).toBe("claude");
    expect(parsed.autocomplete?.provider).toBe("ollama");
  });
});
