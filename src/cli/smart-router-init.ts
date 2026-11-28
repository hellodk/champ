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
import { createCanonicalRouteSource } from "../config/canonical-route-source";
import type { ModelTieBreak } from "../config/model-selection";
import type {
  Endpoint,
  ModelTarget,
  ProvidersDocument,
} from "../config/provider-model";
import type { RouteTask } from "../config/model-router";
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
  /** Persisted registry document. Absent means build an equivalent snapshot. */
  doc?: ProvidersDocument;
}

/**
 * Build the CLI router from the endpoint registry. Returns null when the
 * registry has no models worth routing to.
 */
export async function initializeCliRouter(
  input: CliRouterInitInput,
): Promise<SmartRouter | null> {
  const doc: ProvidersDocument = input.doc ?? {
    version: 1,
    endpoints: input.endpoints,
    assignments: input.assignments as ProvidersDocument["assignments"],
    routingMode: "auto",
  };
  const router = new SmartRouter();
  router.setTieBreak(input.tieBreak ?? "model-id");
  router.registerProvider(
    input.endpoint.name,
    input.primaryProvider,
    input.endpoint.provider,
    input.endpoint.baseUrl,
  );
  const providerByEndpoint = new Map<
    string,
    { provider: LLMProvider; name: string; type: string }
  >([
    [
      input.endpoint.id,
      {
        provider: input.primaryProvider,
        name: input.endpoint.name,
        type: input.endpoint.provider,
      },
    ],
  ]);

  const staticModels: DiscoveredModel[] = [];
  for (const ep of input.endpoints) {
    if (!ep.enabled) continue;

    if (ep.id !== input.endpoint.id) {
      try {
        const provider = await input.createProvider(ep, input.secretProvider);
        router.registerProvider(ep.name, provider, ep.provider, ep.baseUrl);
        providerByEndpoint.set(ep.id, {
          provider,
          name: ep.name,
          type: ep.provider,
        });
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

  const taskPins: Partial<Record<RouteTask, ModelTarget>> = {};
  if (!doc.selection?.pinned) {
    for (const task of ["coding", "chat", "completion", "embedding"] as const) {
      const assignment = input.assignments[task];
      if (!assignment?.model) continue;
      const endpoint = input.endpoints.find(
        (ep) => ep.id === assignment.endpointId,
      );
      if (!endpoint?.models.some((model) => model.id === assignment.model)) {
        continue;
      }
      taskPins[task] = {
        endpointId: endpoint.id,
        modelId: assignment.model,
      };
      // Keep the legacy picker in sync; canonical routing uses taskPins above.
      router.setTaskModel(task, assignment.model, endpoint.name);
    }
  }

  router.setCanonicalRouteSource(
    createCanonicalRouteSource({
      doc,
      taskPins,
      resolveLegacyModel: (endpointId, modelId) => {
        const endpoint = doc.endpoints.find((ep) => ep.id === endpointId);
        return (
          staticModels.find(
            (item) =>
              item.id === modelId && item.providerName === endpoint?.name,
          ) ?? null
        );
      },
      resolveProvider: (endpointId, modelId) => {
        const entry = providerByEndpoint.get(endpointId);
        if (!entry) return null;
        return {
          ...entry,
          provider: entry.provider.withModel?.(modelId) ?? entry.provider,
        };
      },
    }),
  );

  return router;
}
