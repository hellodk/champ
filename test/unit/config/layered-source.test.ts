/**
 * TDD: config resolution (single user-level source, #126).
 *
 * Contract since #126:
 * - `~/.champ/config.yaml` is the SINGLE source of configuration. No
 *   workspace-level `.champ/config.yaml` is ever consulted.
 * - A workspace file, even when present, is ignored entirely.
 * - origins maps every top-level key of the final config to the layer
 *   that supplied it ("user-yaml" | "default").
 */
import { describe, it, expect } from "vitest";
import { ConfigLoader, resolveLayered } from "@/config/config-loader";

const USER_YAML = `
provider: llamacpp
providers:
  llamacpp:
    baseUrl: http://192.168.1.24:21434/v1
    model: default
`;

describe("resolveLayered (#126 single user config)", () => {
  it("user yaml is used when present", () => {
    const r = resolveLayered({
      userText: USER_YAML,
      source: "user-yaml",
    });
    expect(r.usedSource).toBe("user-yaml");
    expect(r.config?.provider).toBe("llamacpp");
    expect(r.conflict).toBe(false);
  });

  it("null config when no user yaml at all (no workspace fallback)", () => {
    const r = resolveLayered({
      userText: null,
      source: "auto",
    });
    expect(r.usedSource).toBe("default");
    expect(r.config).toBeNull();
  });

  it("origins attribute each top-level key to its layer", () => {
    const r = resolveLayered({
      userText: USER_YAML,
      source: "user-yaml",
    });
    // provider + providers come from the user yaml; defaults filled the rest
    expect(r.origins["provider"]).toBe("user-yaml");
    expect(r.origins["providers"]).toBe("user-yaml");
    expect(r.origins["autocomplete"]).toBe("default");
  });

  it("invalid YAML in the user layer surfaces as error, not silent skip", () => {
    expect(() =>
      resolveLayered({
        userText: "provider: [broken",
        source: "user-yaml",
      }),
    ).toThrow(/Invalid YAML/);
  });
});
