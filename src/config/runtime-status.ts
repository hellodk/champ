/**
 * In-memory runtime health and load for model targets.
 *
 * This state is deliberately separate from persisted `providers.json`: a
 * timeout or circuit opening is an observation about the current runtime, not
 * a durable fact about an endpoint. Nothing here logs secrets or prompt data.
 */
import type { ModelTarget } from "./provider-model";

export type FailureClass =
  | "timeout"
  | "rate_limit"
  | "auth"
  | "model_not_found"
  | "server"
  | "network"
  | "unknown";

export interface TargetRuntime {
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: FailureClass;
  consecutiveFailures: number;
  circuitOpenUntil?: number;
  inFlight: number;
  latencyMs?: number;
  ttftMs?: number;
  totalSuccesses: number;
  totalFailures: number;
}

export interface RuntimeStateOptions {
  nowMs?: () => number;
  failureThreshold?: number;
  cooldownMs?: number;
  /** How long a recent failure suppresses a target for soft failover. */
  retrySuppressionMs?: number;
}

const HARD_FAILURE_CLASSES: ReadonlySet<FailureClass> = new Set([
  "auth",
  "model_not_found",
  "server",
  "network",
  "unknown",
]);

/**
 * Classify a provider error into a bounded set of runtime states. The original
 * message is never stored: errors can contain credentials or prompt content.
 */
export function classifyFailure(error: unknown): FailureClass {
  const text = error instanceof Error ? error.message : String(error ?? "");
  const lower = text.toLowerCase();
  if (/timeout|timed out|aborterror|aborted|deadline/.test(lower))
    return "timeout";
  if (
    /\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication/.test(
      lower,
    )
  )
    return "auth";
  if (/\b404\b|model.?not.?found|unknown model/.test(lower))
    return "model_not_found";
  if (/\b429\b|rate.?limit|quota|too many requests/.test(lower))
    return "rate_limit";
  if (/\b5\d\d\b|server error|service unavailable|internal error/.test(lower))
    return "server";
  if (/fetch failed|network|econn|enotfound|socket|connection/.test(lower))
    return "network";
  return "unknown";
}

function targetKey(target: ModelTarget): string {
  return JSON.stringify([target.endpointId, target.modelId]);
}

function emptyEntry(): TargetRuntime {
  return {
    consecutiveFailures: 0,
    inFlight: 0,
    totalSuccesses: 0,
    totalFailures: 0,
  };
}

export class RuntimeState {
  private readonly entries = new Map<string, TargetRuntime>();
  private readonly nowMs: () => number;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly retrySuppressionMs: number;

  constructor(opts: RuntimeStateOptions = {}) {
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.retrySuppressionMs = opts.retrySuppressionMs ?? 15_000;
  }

  get(target: ModelTarget): TargetRuntime | undefined {
    const entry = this.entries.get(targetKey(target));
    return entry ? { ...entry } : undefined;
  }

  recordSuccess(
    target: ModelTarget,
    latencyMs?: number,
    ttftMs?: number,
  ): void {
    const now = this.nowMs();
    const entry = this.entries.get(targetKey(target)) ?? emptyEntry();
    entry.lastSuccessAt = now;
    entry.lastError = undefined;
    entry.lastFailureAt = undefined;
    entry.consecutiveFailures = 0;
    entry.circuitOpenUntil = undefined;
    entry.totalSuccesses += 1;
    if (latencyMs !== undefined && Number.isFinite(latencyMs))
      entry.latencyMs = latencyMs;
    if (ttftMs !== undefined && Number.isFinite(ttftMs)) entry.ttftMs = ttftMs;
    this.entries.set(targetKey(target), entry);
  }

  recordFailure(target: ModelTarget, error: FailureClass): void {
    const now = this.nowMs();
    const entry = this.entries.get(targetKey(target)) ?? emptyEntry();
    entry.lastFailureAt = now;
    entry.lastError = error;
    entry.consecutiveFailures += 1;
    entry.totalFailures += 1;
    if (
      HARD_FAILURE_CLASSES.has(error) &&
      entry.consecutiveFailures >= this.failureThreshold
    ) {
      entry.circuitOpenUntil = now + this.cooldownMs;
    }
    this.entries.set(targetKey(target), entry);
  }

  /** Circuit-aware availability. A single timeout never marks a target dead. */
  isAvailable(target: ModelTarget, nowMs: number = this.nowMs()): boolean {
    const entry = this.entries.get(targetKey(target));
    if (!entry || entry.circuitOpenUntil === undefined) return true;
    return entry.circuitOpenUntil <= nowMs;
  }

  /** Runtime hint used by failover ranking; recovers automatically. */
  shouldAvoid(target: ModelTarget, nowMs: number = this.nowMs()): boolean {
    const entry = this.entries.get(targetKey(target));
    if (!entry) return false;
    if (!this.isAvailable(target, nowMs)) return true;
    return (
      entry.lastFailureAt !== undefined &&
      nowMs - entry.lastFailureAt < this.retrySuppressionMs
    );
  }

  beginRequest(target: ModelTarget): () => void {
    const key = targetKey(target);
    const entry = this.entries.get(key) ?? emptyEntry();
    entry.inFlight += 1;
    this.entries.set(key, entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.entries.get(key) ?? emptyEntry();
      current.inFlight = Math.max(0, current.inFlight - 1);
      this.entries.set(key, current);
    };
  }

  dispose(): void {
    this.entries.clear();
  }
}
