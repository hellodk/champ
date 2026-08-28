/**
 * TDD: guided setup wizard flow controller (ticket #118).
 * Decision rules:
 *   - endpoint probe 401 → prompt for and store an API key
 *   - cloud provider with stored key → keep the current model, skip picking
 *   - otherwise pick from the auto-discovered model list
 */
import { describe, it, expect, vi } from "vitest";
import {
  runWizard,
  type WizardDeps,
  type WizardOutcome,
} from "@/config/setup-wizard";

const baseDeps = (overrides: Partial<WizardDeps> = {}): WizardDeps => ({
  providers: [
    { id: "claude", cloud: true },
    { id: "ollama", cloud: false },
  ],
  pickProvider: vi.fn(async () => "ollama"),
  inputBaseUrl: vi.fn(async () => "http://localhost:11434"),
  probeEndpoint: vi.fn(async () => ({ status: 200 })),
  hasStoredApiKey: vi.fn(async () => false),
  promptForApiKey: vi.fn(async () => "sk-test"),
  storeKey: vi.fn(async () => {}),
  fetchModels: vi.fn(async () => ["llama3.1", "qwen3:8b"]),
  pickModel: vi.fn(async () => "qwen3:8b"),
  ...overrides,
});

const run = async (deps: WizardDeps): Promise<WizardOutcome> => runWizard(deps);

describe("runWizard (#118)", () => {
  it("returns cancelled when no provider is picked", async () => {
    const outcome = await run(
      baseDeps({ pickProvider: vi.fn(async () => undefined) }),
    );
    expect(outcome.status).toBe("cancelled");
  });

  it("returns cancelled when baseUrl is not supplied", async () => {
    const outcome = await run(
      baseDeps({ inputBaseUrl: vi.fn(async () => undefined) }),
    );
    expect(outcome.status).toBe("cancelled");
  });

  it("prompts for and stores a key when the probe returns 401", async () => {
    const storeKey = vi.fn(async () => {});
    const outcome = await run(
      baseDeps({
        probeEndpoint: vi.fn(async () => ({ status: 401 })),
        storeKey,
      }),
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.apiKey).toBe("sk-test");
    expect(storeKey).toHaveBeenCalledWith("ollama", "sk-test");
  });

  it("does NOT prompt for a key when the probe succeeds", async () => {
    const promptForApiKey = vi.fn(async () => "sk-test");
    const outcome = await run(baseDeps({ promptForApiKey }));
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(promptForApiKey).not.toHaveBeenCalled();
    expect(outcome.apiKey).toBeUndefined();
  });

  it("auto-keeps the configured model for a cloud provider with a stored key", async () => {
    const fetchModels = vi.fn(async () => ["claude-sonnet-4-20250514"]);
    const pickModel = vi.fn(async () => "gpt-4o");
    const outcome = await run(
      baseDeps({
        pickProvider: vi.fn(async () => "claude"),
        hasStoredApiKey: vi.fn(async () => true),
        fetchModels,
        pickModel,
      }),
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(fetchModels).not.toHaveBeenCalled();
    expect(pickModel).not.toHaveBeenCalled();
    expect(outcome.model).toBeUndefined();
  });

  it("picks from discovered models for a self-hosted provider", async () => {
    const outcome = await run(baseDeps());
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.model).toBe("qwen3:8b");
    expect(outcome.baseUrl).toBe("http://localhost:11434");
  });

  it("auto-selects the only discovered model", async () => {
    const pickModel = vi.fn(async () => "qwen3:8b");
    const outcome = await run(
      baseDeps({
        fetchModels: vi.fn(async () => ["qwen3:8b"]),
        pickModel,
      }),
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(pickModel).not.toHaveBeenCalled();
    expect(outcome.model).toBe("qwen3:8b");
  });

  it("requests a key for a cloud provider without one whenever the probe 401s", async () => {
    const outcome = await run(
      baseDeps({
        pickProvider: vi.fn(async () => "claude"),
        hasStoredApiKey: vi.fn(async () => false),
        probeEndpoint: vi.fn(async () => ({ status: 401 })),
      }),
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.apiKey).toBe("sk-test");
  });
});
