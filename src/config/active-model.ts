/**
 * Active model selection shared by the CLI and VS Code extension.
 *
 * Both interfaces persist the user's choice as a `default` assignment in the
 * endpoint registry. This keeps `~/.champ/config.yaml` as a legacy migration
 * source instead of a second, competing source of truth.
 */
import { catalogEntry } from "./provider-catalog";
import type { Endpoint } from "./provider-model";

export interface ActiveModelRegistry {
  list(): Promise<Endpoint[]>;
  setAssignment(
    task: "default",
    endpointId: string,
    model: string,
  ): Promise<void>;
}

export interface ActiveModelResult {
  ok: boolean;
  endpointId?: string;
  model?: string;
  reason?: string;
}

/** Resolve and persist the active endpoint/model pair. */
export async function selectActiveModel(
  registry: ActiveModelRegistry,
  providerName: string,
  modelName?: string | null,
): Promise<ActiveModelResult> {
  const endpoints = await registry.list();
  const needle = providerName.trim().toLowerCase();
  const match =
    endpoints.find((ep) => ep.id.toLowerCase() === needle) ??
    endpoints.find((ep) => ep.name.toLowerCase() === needle) ??
    endpoints.find((ep) => ep.provider.toLowerCase() === needle);

  if (!match) {
    return {
      ok: false,
      reason: `no endpoint in providers.json matches "${providerName}"`,
    };
  }

  const model =
    modelName?.trim() ||
    match.models[0]?.id ||
    catalogEntry(match.provider).defaultModel ||
    "default";

  await registry.setAssignment("default", match.id, model);
  return { ok: true, endpointId: match.id, model };
}

/**
 * Make an endpoint for `providerName` the effective default. `config.yaml`
 * alone is not consulted by the CLI once the registry has assignments, so
 * `champ config set provider` must re-point the registry too (issue #187).
 */
export async function selectProviderAsDefault(
  registry: ActiveModelRegistry,
  providerName: string,
): Promise<{ endpointId: string; model: string }> {
  const endpoints = await registry.list();
  const needle = providerName.trim().toLowerCase();
  const match =
    endpoints.find((ep) => ep.id.toLowerCase() === needle) ??
    endpoints.find((ep) => ep.name.toLowerCase() === needle) ??
    endpoints.find((ep) => ep.provider.toLowerCase() === needle);

  if (!match) {
    throw new Error(`no endpoint in providers.json matches "${providerName}"`);
  }
  const model =
    match.models[0]?.id ??
    catalogEntry(match.provider).defaultModel ??
    "default";
  await registry.setAssignment("default", match.id, model);
  return { endpointId: match.id, model };
}
