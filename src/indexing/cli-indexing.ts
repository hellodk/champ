/**
 * Build an IndexingService for the headless CLI/TUI runtime.
 *
 * The extension discovers embedding models through SmartRouter at activation.
 * The CLI has no activation phase and its endpoints are already known from
 * `~/.champ/providers.json`, so we seed SmartRouter with those models instead
 * of issuing another discovery round trip. Indexing itself stays lazy: the
 * service is returned here but `initialize()` is only called when
 * `codebase_search` actually needs semantic results.
 */
import type { ChampConfig } from "../config/config-loader";
import type {
  DiscoveredModel as EndpointModel,
  Endpoint,
} from "../config/provider-model";
import { IndexingService } from "./indexing-service";
import { ProviderFactory, type SecretReader } from "../providers/factory";
import {
  SmartRouter,
  type DiscoveredModel,
  type ModelCapability,
} from "../providers/smart-router";

export interface CliIndexingOptions {
  workspaceRoot: string;
  config: ChampConfig;
  /** Endpoints from the canonical provider registry. */
  endpoints?: Endpoint[];
  /** Credential resolver used to build provider instances. */
  credentials?: SecretReader;
  /** Explicit embedding task assignment from the provider registry. */
  embeddingAssignment?: string;
  /** Injectable for tests; defaults to ProviderFactory. */
  providerFactory?: Pick<
    ProviderFactory,
    "createFromEndpoint" | "createFromChampConfig"
  >;
  /** Injectable for tests; defaults to IndexingService. */
  indexingServiceFactory?: (
    workspaceRoot: string,
    router: SmartRouter,
    config: ChampConfig,
  ) => IndexingService;
  /** Diagnostics go to stderr from the CLI. */
  logger?: (message: string) => void;
}

function toRouterModel(
  model: EndpointModel,
  providerName: string,
  providerType: string,
): DiscoveredModel {
  const capabilities = (model.capabilities ?? []).filter(
    (cap): cap is ModelCapability =>
      cap === "embedding" ||
      cap === "coding" ||
      cap === "general" ||
      cap === "instruct",
  );
  return {
    id: model.id,
    providerName,
    providerType,
    capabilities: capabilities.length > 0 ? capabilities : ["embedding"],
    speed: "medium",
    contextWindow: model.contextWindow ?? 8192,
    sizeHint: model.displayName ?? "",
    quantizationLevel: "",
    source: "discovered",
  };
}

/**
 * Return a CLI-backed indexing service, or null when no embedding model is
 * available. Construction performs no network I/O; only provider objects are
 * created from already-known configuration.
 */
export async function createCliIndexingService(
  options: CliIndexingOptions,
): Promise<IndexingService | null> {
  if (options.config.indexing?.enabled === false) return null;

  const log = options.logger ?? (() => undefined);
  const secrets: SecretReader = options.credentials ?? {
    get: async () => undefined,
  };
  const factory = options.providerFactory ?? new ProviderFactory();
  const router = new SmartRouter();
  const models: DiscoveredModel[] = [];
  const addModel = (model: DiscoveredModel) => {
    if (
      !models.some(
        (m) => m.id === model.id && m.providerName === model.providerName,
      )
    ) {
      models.push(model);
    }
  };

  for (const endpoint of options.endpoints ?? []) {
    if (!endpoint.enabled) continue;
    const candidates = endpoint.models.filter(
      (model) =>
        model.capabilities?.includes("embedding") ||
        model.id === options.embeddingAssignment,
    );
    if (candidates.length === 0) continue;

    try {
      const provider = await factory.createFromEndpoint(endpoint, {
        model: candidates[0].id,
        secretProvider: secrets,
      });
      router.registerProvider(
        endpoint.name,
        provider,
        endpoint.provider,
        endpoint.baseUrl,
      );
      for (const candidate of candidates) {
        addModel(toRouterModel(candidate, endpoint.name, endpoint.provider));
      }
    } catch (err) {
      log(
        `embedding endpoint "${endpoint.name}" unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const explicitModel = options.config.indexing?.embeddingModel;
  if (explicitModel && !models.some((m) => m.id === explicitModel)) {
    const providerName =
      options.config.indexing?.embeddingProvider ??
      options.config.provider ??
      "ollama";
    const providerEntry = options.config.providers?.[providerName] ?? {};
    const routerName = `${providerName}-embedding`;
    try {
      const provider = await factory.createFromChampConfig(
        {
          provider: providerName,
          providers: {
            [providerName]: { ...providerEntry, model: explicitModel },
          },
        },
        secrets,
      );
      router.registerProvider(
        routerName,
        provider,
        providerName,
        providerEntry.baseUrl,
      );
      addModel({
        id: explicitModel,
        providerName: routerName,
        providerType: providerName,
        capabilities: ["embedding"],
        speed: "medium",
        contextWindow: providerEntry.contextWindow ?? 8192,
        sizeHint: "",
        quantizationLevel: "",
        source: "discovered",
      });
    } catch (err) {
      log(
        `embedding model "${explicitModel}" unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (models.length === 0) return null;

  router.seedDiscoveredModels(models);
  if (options.embeddingAssignment) {
    router.setTaskModel("embedding", options.embeddingAssignment);
  }

  const createService =
    options.indexingServiceFactory ??
    ((root: string, r: SmartRouter, config: ChampConfig) =>
      new IndexingService(root, r, config));
  return createService(options.workspaceRoot, router, options.config);
}
