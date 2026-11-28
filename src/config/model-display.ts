/** Shared, secret-free formatting for model metadata in all frontends. */
import { capabilityState } from "./model-router";
import type { DiscoveredModel } from "./provider-model";
import type { RuntimeState } from "./runtime-status";

export function modelEvidenceSummary(model: DiscoveredModel): string {
  const parts: string[] = [];
  for (const capability of [
    "chat",
    "tools",
    "embeddings",
    "images",
    "structuredOutput",
  ] as const) {
    if (capabilityState(model, capability) !== "yes") continue;
    const source =
      model.capabilityEvidence?.[capability]?.source ??
      (model.overrides?.capabilityOverrides?.[capability]
        ? "user"
        : model.capabilitySet?.[capability]
          ? "catalog"
          : "unknown");
    parts.push(`${capability}:${source}`);
  }
  return parts.length > 0 ? parts.join(",") : "none";
}

export function runtimeStatusSummary(
  runtime: RuntimeState,
  target: { endpointId: string; modelId: string },
): string {
  if (!runtime.isAvailable(target)) return "circuit-open";
  if (runtime.shouldAvoid(target)) return "avoid";
  if ((runtime.get(target)?.inFlight ?? 0) > 0) return "busy";
  return runtime.get(target)?.lastSuccessAt ? "ok" : "unknown";
}
