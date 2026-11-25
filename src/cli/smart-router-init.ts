/**
 * Shared CLI SmartRouter initialization.
 *
 * The CLI endpoint registry already knows which models exist. `cli.ts` uses
 * this helper to turn that registry into both the static catalogue (for cloud
 * models without a queryable /models endpoint) and the routable discovered
 * model pool. Seeding both is required: `registerStaticModels()` alone only
 * feeds the picker, so `SmartRouter.select()` still sees an empty pool and
 * silently falls back to the provider's configured model.
 */
import type { ModelTieBreak } from "../config/model-selection";
import type { Endpoint } from "../config/provider-model";
import type { SecretReader } from "../providers/factory";
import type { LLMProvider } from "../providers/types";
import {
  SmartRouter,
  type DiscoveredModel,
  type ModelCapability,
} from "../providers/smart-router";

export interface CliRouterInitInput {
  endpoint: Endpoint;
  primaryProvider: LLMProvider;
  endpoints: Endpoint[];
  assignments: Partial<Record<string, { endpointId: string; model: string }>>;
  secretProvider: SecretReader;
  createProvider: (
    endpoint: Endpoint,
    secrets: SecretReader,
  ) => Promise<LLMProvider>;
  tieBreak?: ModelTieBreak;
}

/**
 * Build the CLI router from the endpoint registry. Returns null when the
 * registry has no models worth routing to.
 */
export async function initializeCliRouter(
  input: CliRouterInitInput,
): Promise<SmartRouter | null> {
  const router = new SmartRouter();
  router.setTieBreak(input.tieBreak ?? "model-id");
  router.registerProvider(
    input.endpoint.name,
    input.primaryProvider,
    input.endpoint.provider,
    input.endpoint.baseUrl,
  );

  const staticModels: DiscoveredModel[] = [];
  for (const ep of input.endpoints) {
    if (!ep.enabled) continue;

    if (ep.id !== input.endpoint.id) {
      try {
        const provider = await input.createProvider(ep, input.secretProvider);
        router.registerProvider(ep.name, provider, ep.provider, ep.baseUrl);
      } catch {
        continue;
      }
    }

    for (const model of ep.models) {
      staticModels.push({
        id: model.id,
        providerName: ep.name,
        providerType: ep.provider,
        capabilities: (model.capabilities ?? [
          "coding",
          "general",
        ]) as ModelCapability[],
        speed: "medium",
        contextWindow: model.contextWindow ?? ep.contextWindow ?? 8192,
        sizeHint: "",
        quantizationLevel: "",
        source: "discovered",
      });
    }
  }

  if (staticModels.length === 0) return null;

  // Keep the static catalogue for cloud models that cannot be discovered by
  // network scanning, then seed the same registry models into the pool that
  // SmartRouter.select() actually scores.
  router.registerStaticModels(staticModels);
  router.seedDiscoveredModels(staticModels);

  for (const task of ["coding", "chat"] as const) {
    const assignment = input.assignments[task];
    if (!assignment?.model) continue;
    // An endpoint id pins the override to a provider. Without it, duplicate
    // model ids on two endpoints would resolve to whichever was registered
    // first, silently routing a task to the wrong provider.
    const endpoint = input.endpoints.find(
      (ep) => ep.id === assignment.endpointId,
    );
    router.setTaskModel(task, assignment.model, endpoint?.name);
  }

  return router;
}
