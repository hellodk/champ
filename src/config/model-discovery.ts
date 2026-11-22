/**
 * Live model discovery and connectivity testing for configured endpoints.
 *
 * Reuses `buildProbeUrl` and `resilientFetch`, sends `Authorization: Bearer`
 * when a credential is present, enforces strict per-request and total deadlines,
 * and reports timeouts/errors cleanly rather than throwing or marking timeouts healthy.
 */
import { resilientFetch } from "../providers/http-resilience";
import { buildProbeUrl } from "../utils/probe-url";
import { catalogEntry } from "./provider-catalog";
import type { DiscoveredModel, Endpoint } from "./provider-model";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_DISCOVERY_DEADLINE_MS = 15_000;
const DEFAULT_TEST_DEADLINE_MS = 10_000;
const MAX_PROBE_CONCURRENCY = 4;

export interface DiscoveryDeps {
  fetch: typeof fetch;
  now: () => string;
  requestTimeoutMs?: number;
  discoveryDeadlineMs?: number;
  testDeadlineMs?: number;
}

export interface EndpointTestResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

function buildAuthHeaders(
  endpoint: Endpoint,
  secret: string | undefined,
): Record<string, string> {
  if (!secret) return {};
  if (endpoint.provider === "claude") {
    return {
      Authorization: `Bearer ${secret}`,
      "x-api-key": secret,
    };
  }
  return { Authorization: `Bearer ${secret}` };
}

function parseFiniteContext(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function parseCapabilities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const caps = value.filter((v): v is string => typeof v === "string");
  return caps.length > 0 ? caps : undefined;
}

function parseOllamaTags(payload: unknown, seenAt: string): DiscoveredModel[] {
  if (!payload || typeof payload !== "object") return [];
  const rawModels = (payload as { models?: unknown }).models;
  if (!Array.isArray(rawModels)) return [];

  const result: DiscoveredModel[] = [];
  for (const raw of rawModels) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id =
      typeof item.model === "string" && item.model.trim()
        ? item.model
        : typeof item.name === "string" && item.name.trim()
          ? item.name
          : "";
    if (!id) continue;

    const model: DiscoveredModel = { id, lastSeenAt: seenAt };
    if (typeof item.name === "string" && item.name !== id) {
      model.displayName = item.name;
    }
    const ctx =
      parseFiniteContext(item.context_length) ??
      parseFiniteContext(item.contextWindow);
    if (ctx !== undefined) model.contextWindow = ctx;
    const caps = parseCapabilities(item.capabilities);
    if (caps) model.capabilities = caps;
    result.push(model);
  }
  return result;
}

function parseOpenAIModels(
  payload: unknown,
  seenAt: string,
): DiscoveredModel[] {
  if (!payload || typeof payload !== "object") return [];
  const rawList = (payload as { data?: unknown }).data;
  if (!Array.isArray(rawList)) return [];

  const result: DiscoveredModel[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id.trim()) continue;

    const model: DiscoveredModel = { id: item.id, lastSeenAt: seenAt };
    if (typeof item.display_name === "string") {
      model.displayName = item.display_name;
    }
    const meta =
      item.meta && typeof item.meta === "object"
        ? (item.meta as Record<string, unknown>)
        : undefined;
    const ctx =
      parseFiniteContext(item.context_length) ??
      parseFiniteContext(item.context_window) ??
      parseFiniteContext(item.max_model_len) ??
      parseFiniteContext(meta?.n_ctx_train);
    if (ctx !== undefined) model.contextWindow = ctx;
    const caps = parseCapabilities(item.capabilities);
    if (caps) model.capabilities = caps;
    result.push(model);
  }
  return result;
}

async function runWithDeadline<T>(
  deadlineMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  onTimeout: () => T,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(onTimeout());
    }, deadlineMs);
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

export async function discoverModels(
  endpoint: Endpoint,
  secret: string | undefined,
  deps: DiscoveryDeps,
): Promise<DiscoveredModel[]> {
  const entry = catalogEntry(endpoint.provider);
  if (entry.discovery === "none") return [];

  const baseUrl = endpoint.baseUrl ?? entry.defaultBaseUrl;
  if (!baseUrl) return [];

  const url = buildProbeUrl(baseUrl, endpoint.provider);
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const deadlineMs = deps.discoveryDeadlineMs ?? DEFAULT_DISCOVERY_DEADLINE_MS;

  return runWithDeadline<DiscoveredModel[]>(
    deadlineMs,
    async (signal) => {
      try {
        const res = await resilientFetch(
          url,
          { method: "GET", headers: buildAuthHeaders(endpoint, secret) },
          { signal, timeoutMs: requestTimeoutMs, maxRetries: 0 },
          deps.fetch,
        );
        if (!res.ok) return [];
        const body: unknown = await res.json();
        const seenAt = deps.now();
        return entry.discovery === "ollama-tags"
          ? parseOllamaTags(body, seenAt)
          : parseOpenAIModels(body, seenAt);
      } catch {
        return [];
      }
    },
    () => [],
  );
}

export async function testEndpoint(
  endpoint: Endpoint,
  secret: string | undefined,
  deps: DiscoveryDeps,
): Promise<EndpointTestResult> {
  const entry = catalogEntry(endpoint.provider);
  if (entry.discovery === "none" && !endpoint.baseUrl) {
    return secret
      ? { ok: true, latencyMs: 0 }
      : { ok: false, error: `No API key configured for ${endpoint.name}` };
  }

  const baseUrl = endpoint.baseUrl ?? entry.defaultBaseUrl;
  if (!baseUrl) {
    return { ok: false, error: `No baseUrl configured for ${endpoint.name}` };
  }

  const url = buildProbeUrl(baseUrl, endpoint.provider);
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const deadlineMs = deps.testDeadlineMs ?? DEFAULT_TEST_DEADLINE_MS;
  const startedAt = Date.now();

  return runWithDeadline<EndpointTestResult>(
    deadlineMs,
    async (signal) => {
      try {
        const res = await resilientFetch(
          url,
          { method: "GET", headers: buildAuthHeaders(endpoint, secret) },
          { signal, timeoutMs: requestTimeoutMs, maxRetries: 0 },
          deps.fetch,
        );
        const latencyMs = Date.now() - startedAt;
        if (!res.ok) {
          return {
            ok: false,
            latencyMs,
            error: `HTTP ${res.status}`,
          };
        }
        return { ok: true, latencyMs };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    () => ({
      ok: false,
      error: `Timed out after ${deadlineMs}ms`,
    }),
  );
}

/**
 * Probe a list of endpoints with bounded concurrency (`<= 4`) under a shared deadline.
 */
export async function probeEndpoints(
  endpoints: readonly Endpoint[],
  getSecret: (endpoint: Endpoint) => Promise<string | undefined>,
  deps: DiscoveryDeps,
): Promise<Map<string, EndpointTestResult>> {
  const results = new Map<string, EndpointTestResult>();
  if (endpoints.length === 0) return results;

  const deadlineMs = deps.discoveryDeadlineMs ?? DEFAULT_DISCOVERY_DEADLINE_MS;
  return runWithDeadline<Map<string, EndpointTestResult>>(
    deadlineMs,
    async (signal) => {
      let nextIdx = 0;
      const workerCount = Math.min(MAX_PROBE_CONCURRENCY, endpoints.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (!signal.aborted) {
          const idx = nextIdx++;
          if (idx >= endpoints.length) break;
          const ep = endpoints[idx];
          const secret = await getSecret(ep);
          if (signal.aborted) break;
          const outcome = await testEndpoint(ep, secret, deps);
          if (!signal.aborted) {
            results.set(ep.id, outcome);
          }
        }
      });
      await Promise.all(workers);
      return results;
    },
    () => {
      for (const ep of endpoints) {
        if (!results.has(ep.id)) {
          results.set(ep.id, {
            ok: false,
            error: `Timed out after ${deadlineMs}ms`,
          });
        }
      }
      return results;
    },
  );
}
