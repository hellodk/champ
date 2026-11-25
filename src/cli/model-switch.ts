/**
 * Shared live model switching for the CLI's RPC and TUI front ends (issue #178).
 *
 * Both front ends must persist the choice, rebuild the provider from the
 * selected endpoint/model, and swap it into the running controller before the
 * next turn. Keeping that in one helper prevents the TUI from silently
 * reporting a model the agent is not using.
 */
import type { AgentController } from "../agent/agent-controller";
import {
  selectActiveModel,
  type ActiveModelRegistry,
} from "../config/active-model";
import type { ChampConfig } from "../config/config-loader";
import type { CredentialRef, Endpoint } from "../config/provider-model";
import type { LLMProvider } from "../providers/types";
import { ProviderFactory } from "../providers/factory";

export type CredentialReader = {
  get(ref: CredentialRef): Promise<string | undefined>;
};

export interface ModelSwitchParams {
  /** Endpoint id/name/provider. Omit to use the startup selection. */
  provider?: string;
  model: string;
}

export interface ModelSwitchDeps {
  registry: ActiveModelRegistry;
  credentials: CredentialReader;
  config: ChampConfig;
  registryChoice: {
    endpoint: Endpoint;
    credentials: CredentialReader;
  } | null;
  flags: { apiKey?: string };
  factory: Pick<
    ProviderFactory,
    "createFromEndpoint" | "createFromChampConfig"
  >;
}

export interface ModelSwitchTarget {
  setProvider(provider: LLMProvider): void;
}

function secretReader(
  deps: ModelSwitchDeps,
  endpoint: Endpoint,
  credentials: CredentialReader,
) {
  return {
    get: async (key: string): Promise<string | undefined> => {
      if (deps.flags.apiKey) return deps.flags.apiKey;
      if (endpoint.credential) {
        const direct = await credentials.get(endpoint.credential);
        if (direct !== undefined) return direct;
      }
      return credentials.get({ kind: "keyring", id: key });
    },
  };
}

/**
 * Build and install the provider for a model selection. The controller is
 * touched only after the rebuild succeeds, so a failed build leaves the old
 * model active.
 */
export async function switchLiveModel(
  deps: ModelSwitchDeps,
  target: ModelSwitchTarget,
  params: ModelSwitchParams,
): Promise<{ model: string; provider: string }> {
  let nextProvider: LLMProvider;

  if (params.provider) {
    const selected = await selectActiveModel(
      deps.registry,
      params.provider,
      params.model,
    );
    if (!selected.ok || !selected.endpointId || !selected.model) {
      throw new Error(selected.reason ?? "model selection failed");
    }
    const endpoint = (await deps.registry.list()).find(
      (ep) => ep.id === selected.endpointId,
    );
    if (!endpoint) throw new Error(`endpoint ${selected.endpointId} not found`);
    nextProvider = await deps.factory.createFromEndpoint(endpoint, {
      model: selected.model,
      secretProvider: secretReader(deps, endpoint, deps.credentials),
    });
  } else if (deps.registryChoice) {
    const { endpoint, credentials } = deps.registryChoice;
    nextProvider = await deps.factory.createFromEndpoint(endpoint, {
      model: params.model,
      secretProvider: secretReader(deps, endpoint, credentials),
    });
  } else {
    const name = deps.config.provider;
    if (!name) throw new Error("no provider configured for set_model");
    const entry = deps.config.providers?.[name] ?? {};
    nextProvider = await deps.factory.createFromChampConfig(
      {
        ...deps.config,
        provider: name,
        providers: {
          ...deps.config.providers,
          [name]: { ...entry, model: params.model },
        },
      },
      { get: async () => undefined },
    );
  }

  target.setProvider(nextProvider);
  return { model: nextProvider.config.model, provider: nextProvider.name };
}

/** `/status` must describe the live controller, not the startup provider. */
export function formatLiveStatus(
  controller: AgentController,
  mode: string,
  session: string,
): string {
  return `mode=${mode} model=${controller.getProvider().config.model ?? "unknown"} session=${session}`;
}
