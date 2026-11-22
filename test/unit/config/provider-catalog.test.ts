import { describe, expect, it } from "vitest";
import { VALID_PROVIDERS } from "@/config/config-loader";
import { catalogEntry, PROVIDER_CATALOG } from "@/config/provider-catalog";

describe("PROVIDER_CATALOG", () => {
  it("contains exactly seven entries matching VALID_PROVIDERS", () => {
    expect(PROVIDER_CATALOG).toHaveLength(7);
    expect(PROVIDER_CATALOG.map((e) => e.kind).sort()).toEqual(
      [...VALID_PROVIDERS].sort(),
    );
  });

  it("exposes MLX and LM Studio as labels on openai-compatible, not new kinds", () => {
    const compat = catalogEntry("openai-compatible");
    expect(compat.label).toMatch(/MLX/i);
    expect(compat.label).toMatch(/LM Studio/i);
    expect(
      PROVIDER_CATALOG.find((e) => (e.kind as string) === "mlx"),
    ).toBeUndefined();
    expect(
      PROVIDER_CATALOG.find((e) => (e.kind as string) === "lmstudio"),
    ).toBeUndefined();
  });

  it("uses generic loopback defaults for every non-cloud provider and no LAN addresses", () => {
    for (const entry of PROVIDER_CATALOG) {
      if (!entry.cloud) {
        expect(entry.defaultBaseUrl).toBeDefined();
        expect(entry.defaultBaseUrl).toMatch(/^http:\/\/localhost:\d+/);
      }
      if (entry.defaultBaseUrl) {
        expect(entry.defaultBaseUrl).not.toMatch(
          /192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\./,
        );
      }
    }
  });

  it("keeps auth, discovery, and tool flags consistent with ProviderFactory capabilities", () => {
    expect(catalogEntry("claude")).toMatchObject({
      cloud: true,
      auth: "required",
      discovery: "none",
      supportsTools: true,
      supportsStreaming: true,
    });
    expect(catalogEntry("openai")).toMatchObject({
      cloud: true,
      auth: "required",
      discovery: "openai-models",
      supportsTools: true,
      supportsEmbeddings: true,
    });
    expect(catalogEntry("gemini")).toMatchObject({
      cloud: true,
      auth: "required",
      discovery: "none",
      supportsTools: true,
    });
    expect(catalogEntry("ollama")).toMatchObject({
      cloud: false,
      auth: "optional",
      discovery: "ollama-tags",
      supportsEmbeddings: true,
    });
    expect(catalogEntry("llamacpp")).toMatchObject({
      cloud: false,
      auth: "optional",
      discovery: "openai-models",
      supportsTools: false,
    });
    expect(catalogEntry("vllm")).toMatchObject({
      cloud: false,
      auth: "optional",
      discovery: "openai-models",
      supportsTools: false,
      supportsEmbeddings: true,
    });
    expect(catalogEntry("openai-compatible")).toMatchObject({
      cloud: false,
      auth: "optional",
      discovery: "openai-models",
      supportsTools: false,
      supportsEmbeddings: true,
    });
  });
});
