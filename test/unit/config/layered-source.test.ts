/**
 * TDD: layered config resolution with explicit single source (#115).
 *
 * Contract:
 * - champ.configSource picks THE one active source; others are ignored
 *   and reported via ignoredSources.
 * - auto preserves historical precedence exactly:
 *   workspace yaml > user yaml > (caller's settings fallback)
 * - origins maps every top-level key of the final config to the layer
 *   that supplied it ("workspace-yaml" | "user-yaml" | "default").
 */
import { describe, it, expect } from "vitest";
import { ConfigLoader, resolveLayered } from "@/config/config-loader";

const WS_YAML = `
provider: openai-compatible
providers:
  openai-compatible:
    baseUrl: http://192.168.1.5:8000/v1
    model: mlx-community--Qwen3.5-4B-MLX-4bit
    apiKey: dummy
    supportsTools: true
`;
const USER_YAML = `
provider: llamacpp
providers:
  llamacpp:
    baseUrl: http://192.168.1.24:21434/v1
    model: default
`;

describe("resolveLayered (#115)", () => {
  it("auto: workspace beats user when both exist, flags conflict", () => {
    const r = resolveLayered({
      workspaceText: WS_YAML,
      userText: USER_YAML,
      source: "auto",
    });
    expect(r.usedSource).toBe("workspace-yaml");
    expect(r.config?.provider).toBe("openai-compatible");
    expect(r.conflict).toBe(true);
  });

  it("auto: user used when workspace absent", () => {
    const r = resolveLayered({
      workspaceText: null,
      userText: USER_YAML,
      source: "auto",
    });
    expect(r.usedSource).toBe("user-yaml");
    expect(r.config?.provider).toBe("llamacpp");
    expect(r.conflict).toBe(false);
  });

  it("auto: null config when no yaml at all (settings fallback)", () => {
    const r = resolveLayered({
      workspaceText: null,
      userText: null,
      source: "auto",
    });
    expect(r.usedSource).toBe("settings");
    expect(r.config).toBeNull();
  });

  it("explicit workspace-yaml ignores user file entirely", () => {
    const r = resolveLayered({
      workspaceText: WS_YAML,
      userText: USER_YAML,
      source: "workspace-yaml",
    });
    expect(r.usedSource).toBe("workspace-yaml");
    expect(r.config?.provider).toBe("openai-compatible");
    expect(r.conflict).toBe(false);
    expect(r.ignoredSources).toContain("user-yaml");
  });

  it("explicit user-yaml ignores workspace file", () => {
    const r = resolveLayered({
      workspaceText: WS_YAML,
      userText: USER_YAML,
      source: "user-yaml",
    });
    expect(r.usedSource).toBe("user-yaml");
    expect(r.config?.provider).toBe("llamacpp");
    expect(r.ignoredSources).toContain("workspace-yaml");
  });

  it("explicit settings skips all yaml files", () => {
    const r = resolveLayered({
      workspaceText: WS_YAML,
      userText: USER_YAML,
      source: "settings",
    });
    expect(r.usedSource).toBe("settings");
    expect(r.config).toBeNull();
    expect(r.ignoredSources).toEqual(
      expect.arrayContaining(["workspace-yaml", "user-yaml"]),
    );
  });

  it("origins attribute each top-level key to its layer", () => {
    const r = resolveLayered({
      workspaceText: WS_YAML,
      userText: USER_YAML,
      source: "auto",
    });
    // provider + providers come from workspace; defaults filled the rest
    expect(r.origins["provider"]).toBe("workspace-yaml");
    expect(r.origins["providers"]).toBe("workspace-yaml");
    expect(r.origins["autocomplete"]).toBe("default");
  });

  it("invalid YAML in chosen layer surfaces as error, not silent skip", () => {
    expect(() =>
      resolveLayered({
        workspaceText: "provider: [broken",
        userText: USER_YAML,
        source: "workspace-yaml",
      }),
    ).toThrow(/Invalid YAML/);
  });
});
