/**
 * Bridge between the canonical ModelRouter and the existing SmartRouter
 * facade. The source reads a persisted snapshot; it never runs discovery and
 * never scores by model name.
 */
import {
  ModelRouter,
  capabilityState,
  type RouteDecision,
  type RouteDecisionInput,
  type RouteTask,
} from "./model-router";
import type { FailureClass } from "./runtime-status";
import type {
  DiscoveredModel,
  ModelTarget,
  ProvidersDocument,
} from "./provider-model";
import type {
  CanonicalRouteSource as SmartRouteSource,
  DiscoveredModel as LegacyModel,
  ModelCapability,
  ModelSpeed,
  RouteResult,
} from "../providers/smart-router";
import type { LLMProvider } from "../providers/types";

export interface ResolvedCanonicalProvider {
  provider: LLMProvider;
  name: string;
  type: string;
}

export interface CanonicalRouteSourceOptions {
  /** A snapshot, or a getter for a snapshot that is refreshed on config change. */
  doc: ProvidersDocument | (() => ProvidersDocument | null);
  router?: ModelRouter;
  resolveProvider: (
    endpointId: string,
    modelId: string,
  ) => ResolvedCanonicalProvider | null;
  /** Explicit task assignments, used only when no exact pinned selection exists. */
  taskPins?: Partial<Record<RouteTask, ModelTarget>>;
  /** Reuse the facade's existing model object when available. */
  resolveLegacyModel?: (
    endpointId: string,
    modelId: string,
  ) => LegacyModel | null;
}

export interface CanonicalSelectInput {
  task: RouteTask;
  sessionKey?: string;
  requestId?: string;
}

function readDoc(
  doc: ProvidersDocument | (() => ProvidersDocument | null),
): ProvidersDocument | null {
  return typeof doc === "function" ? doc() : doc;
}

function legacyCapabilities(model: DiscoveredModel): ModelCapability[] {
  const result: ModelCapability[] = [];
  if (capabilityState(model, "embeddings") === "yes") {
    result.push("embedding");
    return result;
  }
  if (capabilityState(model, "chat") === "yes") result.push("general");
  const labels = model.capabilities ?? [];
  if (
    labels.some((label) =>
      ["coding", "code", "tool_calling", "tools"].includes(
        label.trim().toLowerCase(),
      ),
    )
  ) {
    if (!result.includes("coding")) result.push("coding");
  }
  return result;
}

function legacySpeed(model: DiscoveredModel): ModelSpeed {
  if (model.speedHint === "fast" || model.speedHint === "slow") {
    return model.speedHint;
  }
  return "medium";
}

export function createCanonicalRouteSource(
  options: CanonicalRouteSourceOptions,
): SmartRouteSource & { getLastDecision(): RouteDecision | null } {
  const router = options.router ?? new ModelRouter();
  let lastDecision: RouteDecision | null = null;
  return {
    select(input: CanonicalSelectInput): RouteResult | null {
      const doc = readDoc(options.doc);
      lastDecision = null;
      if (!doc) return null;
      const pin = options.taskPins?.[input.task];
      // An explicit task assignment may name an endpoint outside the default
      // SmartRoute scope. That is a user override, not silent cross-endpoint
      // routing, so the scope is narrowed to the assigned endpoint.
      const effectiveDoc: ProvidersDocument = pin
        ? {
            ...doc,
            selection: {
              scope: { kind: "endpoint", endpointId: pin.endpointId },
              preference: doc.selection?.preference ?? "balanced",
              pinned: pin,
            },
          }
        : doc;
      const decisionInput: RouteDecisionInput = { ...input, doc: effectiveDoc };
      const decision = router.decide(decisionInput);
      lastDecision = decision;
      if (!decision.target) return null;

      const endpoint = doc.endpoints.find(
        (ep) => ep.id === decision.target!.endpointId,
      );
      const model = endpoint?.models.find(
        (item) => item.id === decision.target!.modelId,
      );
      if (!endpoint || !model) return null;

      const resolved = options.resolveProvider(endpoint.id, model.id);
      if (!resolved) return null;

      const legacy: LegacyModel = options.resolveLegacyModel?.(
        endpoint.id,
        model.id,
      ) ?? {
        id: model.id,
        providerName: resolved.name,
        providerType: resolved.type,
        capabilities: legacyCapabilities(model),
        speed: legacySpeed(model),
        // 0 is an explicit sentinel for "not known"; never fabricate 8192.
        contextWindow:
          model.overrides?.contextWindow ??
          model.contextWindow ??
          endpoint.contextWindow ??
          0,
        sizeHint: "",
        quantizationLevel: "",
        source: "discovered",
      };
      return {
        model: legacy,
        provider: resolved.provider,
        reason: pin
          ? `routing.${input.task} override: ${decision.reason}`
          : decision.reason,
        decision,
      };
    },
    safeAlternatives(
      decision: RouteDecision,
      failed: ModelTarget,
      error: FailureClass,
    ): ModelTarget[] {
      return router.safeAlternatives(decision, failed, error);
    },
    resolveTarget(target: ModelTarget): RouteResult | null {
      const doc = readDoc(options.doc);
      if (!doc) return null;
      const endpoint = doc.endpoints.find((ep) => ep.id === target.endpointId);
      const model = endpoint?.models.find((item) => item.id === target.modelId);
      if (!endpoint || !model) return null;
      const resolved = options.resolveProvider(endpoint.id, model.id);
      if (!resolved) return null;
      const legacy: LegacyModel = options.resolveLegacyModel?.(
        endpoint.id,
        model.id,
      ) ?? {
        id: model.id,
        providerName: resolved.name,
        providerType: resolved.type,
        capabilities: legacyCapabilities(model),
        speed: legacySpeed(model),
        contextWindow:
          model.overrides?.contextWindow ??
          model.contextWindow ??
          endpoint.contextWindow ??
          0,
        sizeHint: "",
        quantizationLevel: "",
        source: "discovered",
      };
      return {
        model: legacy,
        provider: resolved.provider,
        reason: `failover to ${endpoint.id}/${model.id}`,
      };
    },
    getLastDecision(): RouteDecision | null {
      return lastDecision;
    },
  };
}
