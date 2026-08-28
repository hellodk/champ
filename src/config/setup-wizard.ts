/**
 * Guided provider setup wizard flow controller (ticket #118).
 *
 * Pure orchestration over injected dependencies so the decision logic is
 * unit-testable without the VS Code UI. The command handler in extension.ts
 * supplies real prompts, fetch, model discovery, and SecretStorage.
 */

export interface WizardProviderOption {
  id: string;
  /** Cloud providers keep their configured model when a key is stored. */
  cloud: boolean;
}

export interface WizardOutcomeCancelled {
  status: "cancelled";
}

export interface WizardOutcomeOk {
  status: "ok";
  providerId: string;
  baseUrl: string;
  /** undefined = keep the configured model. */
  model?: string;
  /** Set when a fresh key was captured and stored. */
  apiKey?: string;
  keyStored: boolean;
}

export type WizardOutcome = WizardOutcomeCancelled | WizardOutcomeOk;

export interface WizardDeps {
  providers: WizardProviderOption[];
  pickProvider(options: WizardProviderOption[]): Promise<string | undefined>;
  inputBaseUrl(providerId: string): Promise<string | undefined>;
  probeEndpoint(
    providerId: string,
    baseUrl: string,
  ): Promise<{ status: number } | { status: undefined; ok: boolean }>;
  hasStoredApiKey(providerId: string): Promise<boolean>;
  promptForApiKey(providerId: string): Promise<string | undefined>;
  storeKey(providerId: string, apiKey: string): Promise<void>;
  fetchModels(providerId: string, baseUrl: string): Promise<string[]>;
  pickModel(models: string[]): Promise<string | undefined>;
}

export async function runWizard(deps: WizardDeps): Promise<WizardOutcome> {
  const providerId = await deps.pickProvider(deps.providers);
  if (!providerId) return { status: "cancelled" };

  const baseUrl = await deps.inputBaseUrl(providerId);
  if (!baseUrl) return { status: "cancelled" };

  const provider = deps.providers.find((p) => p.id === providerId);
  const cloud = Boolean(provider?.cloud);

  const probe = await deps.probeEndpoint(providerId, baseUrl);
  const probeStatus =
    "status" in probe && typeof probe.status === "number"
      ? probe.status
      : probe.ok
        ? 200
        : 0;

  const outcome: WizardOutcomeOk = {
    status: "ok",
    providerId,
    baseUrl,
    keyStored: false,
  };

  if (probeStatus === 401 || probeStatus === 403) {
    const apiKey = await deps.promptForApiKey(providerId);
    if (!apiKey) return { status: "cancelled" };
    await deps.storeKey(providerId, apiKey);
    outcome.apiKey = apiKey;
    outcome.keyStored = true;
  }

  // Cloud + stored key → keep the configured model, skip discovery picking.
  if (cloud) {
    const hasKey =
      outcome.keyStored || (await deps.hasStoredApiKey(providerId));
    if (hasKey) return outcome;
  }

  const models = await deps.fetchModels(providerId, baseUrl);
  if (models.length === 0) {
    // No listable model — leave model untouched so the operator's yaml model
    // (or the provider default) applies.
    return outcome;
  }
  if (models.length === 1) {
    outcome.model = models[0];
    return outcome;
  }
  const picked = await deps.pickModel(models);
  if (picked) outcome.model = picked;
  return outcome;
}
