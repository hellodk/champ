/**
 * Canonical routing authority for all Champ frontends.
 *
 * Routing is two-stage and deliberately explainable:
 * 1. Hard eligibility filters (scope, enabled state, explicit capability
 *    proof, known context limits, runtime circuit state).
 * 2. Deterministic ranking over eligible targets using only evidence and
 *    explicit user preference. Unknown capability stays unknown; names are
 *    never used as evidence.
 */
import { catalogEntry } from "./provider-catalog";
import type {
  CapabilityState,
  DiscoveredModel,
  Endpoint,
  ModelCapabilitySet,
  ModelTarget,
  ProvidersDocument,
  RouteScope,
  RoutingPreference,
} from "./provider-model";
import { RuntimeState, type FailureClass } from "./runtime-status";

export type RouteTask =
  | "default"
  | "coding"
  | "chat"
  | "completion"
  | "embedding"
  | "review";

export type TieBreak = "model-id" | "first" | "last";

export interface RouteDecisionInput {
  task: RouteTask;
  doc: ProvidersDocument;
  sessionKey?: string;
  requestId?: string;
  requiredCapabilities?: string[];
  contextTokens?: number;
  preference?: RoutingPreference;
  tieBreak?: TieBreak;
  /** Explicit per-task user override; wins over persisted selection.pinned. */
  pinnedOverride?: ModelTarget | null;
}

export interface RouteExclusion {
  target: ModelTarget;
  reason: string;
}

export interface RouteCandidate {
  target: ModelTarget;
  endpoint: Endpoint;
  model: DiscoveredModel;
  score: number;
  reasons: string[];
}

export interface RouteDecision {
  target: ModelTarget | null;
  scope: "endpoint" | "pool" | "global";
  scopeKey: string;
  pinned: boolean;
  source: "pinned" | "session-affinity" | "selection" | "none";
  reason: string;
  preference: RoutingPreference;
  /** Effective failover policy; disabled unless explicitly enabled in config. */
  failover: { enabled: boolean; maxAttempts: number };
  requestId?: string;
  sessionKey?: string;
  candidates: ModelTarget[];
  excluded: RouteExclusion[];
  alternatives: ModelTarget[];
}

interface ScopedEndpoints {
  scope: RouteScope;
  endpoints: Endpoint[];
  excluded: RouteExclusion[];
}

interface SessionBinding {
  target: ModelTarget;
  scopeKey: string;
}

function targetKey(target: ModelTarget): string {
  return `${target.endpointId}\u0000${target.modelId}`;
}

function sameTarget(a: ModelTarget | null, b: ModelTarget | null): boolean {
  return !!a && !!b && a.endpointId === b.endpointId && a.modelId === b.modelId;
}

function isCloud(endpoint: Endpoint): boolean {
  return catalogEntry(endpoint.provider).cloud;
}

/** Explicit capability state only; legacy labels are treated as user evidence. */
export function capabilityState(
  model: DiscoveredModel,
  capability: keyof ModelCapabilitySet,
): CapabilityState {
  const override = model.overrides?.capabilityOverrides?.[capability];
  if (override) return override;
  const explicit = model.capabilitySet?.[capability];
  if (explicit) return explicit;

  const labels = model.capabilities ?? [];
  const lower = capability.toLowerCase();
  const aliases: Record<keyof ModelCapabilitySet, string[]> = {
    chat: ["chat", "general", "instruct"],
    tools: ["tools", "tool_calling", "tool-use"],
    embeddings: ["embedding", "embeddings"],
    images: ["images", "vision", "multimodal"],
    structuredOutput: ["structured-output", "structured_output", "json"],
  };
  if (labels.some((label) => aliasMatches(label, aliases[capability]))) {
    return "yes";
  }
  // An explicit "no" in the legacy list is meaningful; absence is not.
  if (
    labels.some((label) =>
      aliasMatches(label, [`no-${lower}`, `${lower}-no`, `not-${lower}`]),
    )
  ) {
    return "no";
  }
  return "unknown";
}

function aliasMatches(label: string, aliases: readonly string[]): boolean {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  return aliases.some((alias) => normalized === alias);
}

function contextWindowFor(
  model: DiscoveredModel,
  endpoint: Endpoint,
): number | undefined {
  return (
    model.overrides?.contextWindow ??
    model.contextWindow ??
    endpoint.contextWindow
  );
}

function scopeKeyFor(scope: RouteScope, pinned: ModelTarget | null): string {
  return JSON.stringify({ scope, pinned });
}

function scopeEndpoints(doc: ProvidersDocument): ScopedEndpoints {
  const enabled = doc.endpoints.filter((ep) => ep.enabled);
  const excluded: RouteExclusion[] = [];
  const selection = doc.selection;
  const scope: RouteScope =
    selection?.scope ??
    (() => {
      const fallback = enabled.find((ep) => ep.isDefault) ?? enabled[0];
      return fallback
        ? { kind: "endpoint", endpointId: fallback.id }
        : { kind: "global", allowCloud: false };
    })();

  let endpoints: Endpoint[];
  if (scope.kind === "endpoint") {
    const scoped = doc.endpoints.find((ep) => ep.id === scope.endpointId);
    if (scoped && !scoped.enabled) {
      excluded.push({
        target: { endpointId: scoped.id, modelId: "*" },
        reason: "endpoint is disabled",
      });
    }
    endpoints = scoped?.enabled ? [scoped] : [];
  } else if (scope.kind === "pool") {
    const pool = doc.pools?.find((item) => item.id === scope.poolId);
    const ids = new Set(pool?.endpointIds ?? []);
    endpoints = [];
    for (const ep of doc.endpoints) {
      if (!ids.has(ep.id)) continue;
      if (!ep.enabled) {
        excluded.push({
          target: { endpointId: ep.id, modelId: "*" },
          reason: "pool member endpoint is disabled",
        });
        continue;
      }
      endpoints.push(ep);
    }
    if (!pool) {
      excluded.push({
        target: { endpointId: scope.poolId, modelId: "*" },
        reason: "routing pool does not exist",
      });
    }
  } else {
    endpoints = enabled;
    if (!scope.allowCloud) {
      for (const ep of endpoints) {
        if (isCloud(ep)) {
          excluded.push({
            target: { endpointId: ep.id, modelId: "*" },
            reason: "cloud endpoint not allowed by routing scope",
          });
        }
      }
      endpoints = endpoints.filter((ep) => !isCloud(ep));
    }
  }
  return { scope, endpoints, excluded };
}

function compareCandidates(
  a: RouteCandidate,
  b: RouteCandidate,
  tieBreak: TieBreak,
): number {
  if (b.score !== a.score) return b.score - a.score;
  const aKey = targetKey(a.target);
  const bKey = targetKey(b.target);
  if (tieBreak === "first") return 0;
  if (tieBreak === "last") return bKey < aKey ? -1 : bKey > aKey ? 1 : 0;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

function scoreCandidate(
  input: RouteDecisionInput,
  endpoint: Endpoint,
  model: DiscoveredModel,
  preference: RoutingPreference,
  stickyEndpointId: string | undefined,
  runtime?: RuntimeState,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const add = (value: number, reason: string) => {
    score += value;
    if (value !== 0) reasons.push(reason);
  };

  if (input.task === "embedding") {
    add(40, "embedding task with explicit embedding capability");
  } else if (capabilityState(model, "chat") === "yes") {
    add(10, "explicit chat capability");
  }

  if (input.task === "coding" || input.task === "review") {
    if (
      model.capabilities?.some((label) =>
        aliasMatches(label, ["coding", "code"]),
      )
    ) {
      add(20, "explicit coding capability");
    }
    if (capabilityState(model, "tools") === "yes") {
      add(5, "explicit tool capability");
    }
  } else if (input.task === "completion") {
    if (model.speedHint === "fast") add(15, "explicit fast speed hint");
    if (model.speedHint === "slow") add(-10, "explicit slow speed hint");
  }

  if (model.qualityHint !== undefined) {
    const weight =
      preference === "quality" ? 0.1 : preference === "fast" ? 0.02 : 0.05;
    add(model.qualityHint * weight, "explicit quality hint");
  }
  if (model.speedHint === "fast") {
    add(
      preference === "fast" ? 40 : preference === "balanced" ? 8 : 0,
      "explicit fast speed hint",
    );
  } else if (model.speedHint === "slow") {
    add(preference === "fast" ? -20 : -5, "explicit slow speed hint");
  }

  const window = contextWindowFor(model, endpoint);
  if (window !== undefined) {
    const weight =
      preference === "quality" ? 0.002 : preference === "fast" ? 0.0005 : 0.001;
    add(Math.min(20, window * weight), "known context window");
  }

  if (model.latencyMs !== undefined) {
    add(Math.max(0, 30 - model.latencyMs / 100), "measured latency");
  }
  if (model.ttftMs !== undefined) {
    add(Math.max(0, 20 - model.ttftMs / 100), "measured TTFT");
  }

  const inputCost = model.costPerMillionInputUsd;
  const outputCost = model.costPerMillionOutputUsd;
  if (inputCost !== undefined || outputCost !== undefined) {
    const knownCost = (inputCost ?? 0) + (outputCost ?? 0);
    const weight = preference === "quality" ? 0.1 : 0.5;
    add(-knownCost * weight, "known cost");
  }

  if (runtime) {
    const status = runtime.get({ endpointId: endpoint.id, modelId: model.id });
    if (status) {
      add(-status.inFlight * (preference === "fast" ? 10 : 3), "current load");
      add(-status.consecutiveFailures * 2, "recent failure history");
      add(Math.min(5, status.totalSuccesses * 0.5), "recent success history");
    }
  }

  if (stickyEndpointId && endpoint.id === stickyEndpointId) {
    add(20, "same endpoint as previous session target");
  }

  return { score, reasons };
}

function excludedForModel(
  endpoint: Endpoint,
  model: DiscoveredModel,
  input: RouteDecisionInput,
  runtime?: RuntimeState,
): string | undefined {
  const target = { endpointId: endpoint.id, modelId: model.id };
  if (runtime && !runtime.isAvailable(target)) {
    return "runtime circuit is open for this target";
  }
  if (runtime?.shouldAvoid(target)) {
    return "target was recently unavailable; retry suppressed";
  }
  const embeddings = capabilityState(model, "embeddings");
  if (input.task === "embedding") {
    if (embeddings !== "yes")
      return "embedding task requires explicit embedding capability";
  } else {
    if (embeddings === "yes")
      return "embedding-only model excluded from generation task";
    if (capabilityState(model, "chat") === "no") {
      return "model explicitly does not support chat";
    }
  }

  const required = input.requiredCapabilities ?? [];
  for (const rawCap of required) {
    const cap = rawCap === "tool_calling" ? "tools" : rawCap;
    if (
      !(
        cap in
        { chat: 1, tools: 1, embeddings: 1, images: 1, structuredOutput: 1 }
      )
    ) {
      continue;
    }
    if (capabilityState(model, cap as keyof ModelCapabilitySet) !== "yes") {
      return `required capability ${cap} is not proven`;
    }
  }

  if (input.contextTokens !== undefined) {
    const window = contextWindowFor(model, endpoint);
    if (window !== undefined && window < input.contextTokens) {
      return `known context window ${window} is below required ${input.contextTokens}`;
    }
  }
  return undefined;
}

export class ModelRouter {
  private readonly sessions = new Map<string, SessionBinding>();
  private readonly runtime?: RuntimeState;

  constructor(runtimeOrOptions?: RuntimeState | { runtime?: RuntimeState }) {
    this.runtime =
      runtimeOrOptions instanceof RuntimeState
        ? runtimeOrOptions
        : (runtimeOrOptions as { runtime?: RuntimeState } | undefined)?.runtime;
  }

  decide(input: RouteDecisionInput): RouteDecision {
    const scoped = scopeEndpoints(input.doc);
    const selection = input.doc.selection;
    const preference = input.preference ?? selection?.preference ?? "balanced";
    const pinned =
      input.pinnedOverride !== undefined
        ? input.pinnedOverride
        : (selection?.pinned ?? null);
    const scopeKey = scopeKeyFor(scoped.scope, pinned);
    const excluded: RouteExclusion[] = [...scoped.excluded];
    const emptyDecision = (
      source: RouteDecision["source"],
      reason: string,
      target: ModelTarget | null = null,
      candidates: RouteCandidate[] = [],
    ): RouteDecision => ({
      target,
      scope: scoped.scope.kind,
      scopeKey,
      pinned: pinned !== null,
      source,
      reason,
      preference,
      failover: {
        enabled: selection?.failover?.enabled === true,
        maxAttempts: Math.max(
          1,
          Math.min(3, selection?.failover?.maxAttempts ?? 1),
        ),
      },
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.sessionKey !== undefined
        ? { sessionKey: input.sessionKey }
        : {}),
      candidates: candidates.map((c) => c.target),
      excluded,
      alternatives: [],
    });

    if (pinned) {
      const endpoint = scoped.endpoints.find(
        (ep) => ep.id === pinned.endpointId,
      );
      const model = endpoint?.models.find((m) => m.id === pinned.modelId);
      if (endpoint && model) {
        return emptyDecision(
          "pinned",
          "pinned endpoint/model pair selected exactly",
          pinned,
        );
      }
      excluded.push({
        target: pinned,
        reason: "pinned endpoint/model pair is not available in this scope",
      });
      return emptyDecision("none", "pinned target unavailable", null);
    }

    const candidates: RouteCandidate[] = [];
    for (const endpoint of scoped.endpoints) {
      for (const model of endpoint.models) {
        const target = { endpointId: endpoint.id, modelId: model.id };
        const reason = excludedForModel(endpoint, model, input, this.runtime);
        if (reason) {
          excluded.push({ target, reason });
          continue;
        }
        candidates.push({
          target,
          endpoint,
          model,
          score: 0,
          reasons: [],
        });
      }
    }
    if (candidates.length === 0) {
      return emptyDecision("none", "no eligible target in routing scope");
    }

    const previous = input.sessionKey
      ? this.sessions.get(input.sessionKey)
      : undefined;
    const sameScope = previous?.scopeKey === scopeKey;
    const stickyTarget = sameScope ? previous?.target : undefined;

    if (stickyTarget && !this.runtime?.shouldAvoid(stickyTarget)) {
      const sticky = candidates.find((c) => sameTarget(c.target, stickyTarget));
      if (sticky) {
        return emptyDecision(
          "session-affinity",
          "session affinity keeps the active endpoint/model target",
          sticky.target,
          candidates,
        );
      }
    }

    const stickyEndpointId = stickyTarget?.endpointId;
    const tieBreak = input.tieBreak ?? "model-id";
    for (const candidate of candidates) {
      const scored = scoreCandidate(
        input,
        candidate.endpoint,
        candidate.model,
        preference,
        stickyEndpointId,
        this.runtime,
      );
      candidate.score = scored.score;
      candidate.reasons = scored.reasons;
    }
    const ranked = [...candidates].sort((a, b) =>
      compareCandidates(a, b, tieBreak),
    );
    const selected = ranked[0];

    if (input.sessionKey) {
      this.sessions.set(input.sessionKey, {
        target: selected.target,
        scopeKey,
      });
    }

    const decision = emptyDecision(
      "selection",
      `${preference} ranking selected ${targetKey(selected.target)}${
        selected.reasons.length > 0 ? ` (${selected.reasons.join("; ")})` : ""
      }`,
      selected.target,
      ranked,
    );
    return {
      ...decision,
      candidates: ranked.map((c) => c.target),
      alternatives: ranked
        .filter((c) => !sameTarget(c.target, selected.target))
        .map((c) => c.target),
    };
  }

  /**
   * Safe failover within the decision's original scope. Auth and model-not-
   * found failures are terminal: replaying them cannot succeed. Pinned and
   * session-pinned decisions never failover implicitly.
   */
  /** All safe alternatives, in ranked order, for a retryable failure. */
  safeAlternatives(
    decision: RouteDecision,
    failed: ModelTarget,
    error: FailureClass,
  ): ModelTarget[] {
    if (
      !decision.failover.enabled ||
      decision.pinned ||
      decision.source === "session-affinity" ||
      !decision.target
    ) {
      return [];
    }
    if (!sameTarget(decision.target, failed)) return [];
    if (error === "auth" || error === "model_not_found") return [];
    return decision.alternatives.slice(0, decision.failover.maxAttempts);
  }

  nextAlternative(
    decision: RouteDecision,
    failed: ModelTarget,
    error: FailureClass,
  ): ModelTarget | null {
    return this.safeAlternatives(decision, failed, error)[0] ?? null;
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  dispose(): void {
    this.sessions.clear();
  }
}
