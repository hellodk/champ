/**
 * TDD: setup wizard auth hardening.
 *
 * - providers with `auth: "none"` must never be prompted for an API key
 * - an existing stored key must not be overwritten with a fresh prompt
 */
import { describe, it, expect, vi } from "vitest";
import { runWizard, type WizardDeps } from "@/config/setup-wizard";

const deps = (overrides: Partial<WizardDeps> = {}): WizardDeps => ({
  providers: [{ id: "ollama", cloud: false, auth: "none" }],
  pickProvider: vi.fn(async () => "ollama"),
  inputBaseUrl: vi.fn(async () => "http://localhost:11434"),
  probeEndpoint: vi.fn(async () => ({ status: 401 })),
  hasStoredApiKey: vi.fn(async () => false),
  promptForApiKey: vi.fn(async () => "sk-new"),
  storeKey: vi.fn(async () => {}),
  fetchModels: vi.fn(async () => ["llama3.1"]),
  pickModel: vi.fn(async () => "llama3.1"),
  ...overrides,
});

describe("setup wizard auth hardening", () => {
  it("does not prompt for a key when the provider needs no auth", async () => {
    const promptForApiKey = vi.fn(async () => "sk-new");
    const outcome = await runWizard(deps({ promptForApiKey }));
    expect(outcome.status).toBe("ok");
    expect(promptForApiKey).not.toHaveBeenCalled();
  });

  it("does not prompt for a key when one is already stored", async () => {
    const promptForApiKey = vi.fn(async () => "sk-new");
    const outcome = await runWizard(
      deps({
        providers: [{ id: "openai", cloud: true, auth: "required" }],
        pickProvider: vi.fn(async () => "openai"),
        probeEndpoint: vi.fn(async () => ({ status: 401 })),
        hasStoredApiKey: vi.fn(async () => true),
        promptForApiKey,
      }),
    );
    expect(outcome.status).toBe("ok");
    expect(promptForApiKey).not.toHaveBeenCalled();
  });

  it("still prompts when auth is required and no key is stored", async () => {
    const promptForApiKey = vi.fn(async () => "sk-new");
    const outcome = await runWizard(
      deps({
        providers: [{ id: "openai", cloud: true, auth: "required" }],
        pickProvider: vi.fn(async () => "openai"),
        probeEndpoint: vi.fn(async () => ({ status: 401 })),
        hasStoredApiKey: vi.fn(async () => false),
        promptForApiKey,
      }),
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.apiKey).toBe("sk-new");
    expect(promptForApiKey).toHaveBeenCalledTimes(1);
  });
});
