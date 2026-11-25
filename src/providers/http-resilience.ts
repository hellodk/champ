/**
 * HTTP resilience for hand-rolled provider fetches (issue #104).
 *
 * Guarantees:
 * - Per-request timeout via a linked AbortSignal (default 120s).
 * - Bounded retries with exponential backoff + jitter on connection errors,
 *   and an explicit allow-list of transient statuses (408/429/500/502/503/504).
 *   Terminal statuses such as 507 are never retried. Applies to the INITIAL
 *   response only — once a stream starts producing tokens, retries never
 *   re-send the request.
 * - Retry-After header honored when present, up to a 30s cap.
 * - Caller abort always wins immediately.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
/** A server-controlled Retry-After must never stall a headless run for an hour. */
const MAX_RETRY_DELAY_MS = 30_000;

/** Statuses known to be transient. 507 is terminal — retrying it only
 * adds load to a server that has already run out of storage (#180). */
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export interface RetryNotice {
  attempt: number;
  status?: number;
}

export interface FetchResilienceOptions {
  /** Caller cancellation signal (user stop button). */
  signal?: AbortSignal;
  /** Per-attempt timeout in ms. Default: 120000. */
  timeoutMs?: number;
  /** Number of RETRIES after the first attempt fails. Default: 2. */
  maxRetries?: number;
  /** Base delay for exponential backoff. Default: 500ms. */
  baseDelayMs?: number;
  /** Called before each retry so callers can report an accurate attempt count. */
  onRetry?: (notice: RetryNotice) => void;
}

function isRetryableStatus(status: number): boolean {
  return TRANSIENT_STATUSES.has(status);
}

function delayWithAbort(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function cappedDelay(ms: number, source: string): number {
  if (ms <= MAX_RETRY_DELAY_MS) return ms;
  process.stderr.write(
    `[champ] ${source} of ${Math.round(ms / 1000)}s exceeds the maximum; retry delay capped at ${MAX_RETRY_DELAY_MS / 1000}s\n`,
  );
  return MAX_RETRY_DELAY_MS;
}

/**
 * fetch() wrapper adding timeout + bounded backoff retries.
 * `fetchImpl` is injectable for tests.
 */
export async function resilientFetch(
  url: string,
  init: RequestInit | undefined,
  opts: FetchResilienceOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Link caller signal + per-attempt timeout into one controller.
    const controller = new AbortController();
    const onUserAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onUserAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let lastError: unknown;
    try {
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!isRetryableStatus(res.status)) {
        return res;
      }
      if (attempt === maxRetries) {
        return res; // surface the last error status to the caller
      }
      opts.onRetry?.({ attempt: attempt + 1, status: res.status });
      // Release the body of the failed attempt before retrying.
      try {
        res.body?.cancel();
      } catch {
        // ignore
      }
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfterSec = retryAfterHeader
        ? Number.parseFloat(retryAfterHeader)
        : Number.NaN;
      const usedRetryAfter =
        Number.isFinite(retryAfterSec) && retryAfterSec >= 0;
      const backoff = usedRetryAfter
        ? retryAfterSec * 1000
        : baseDelayMs * Math.pow(2, attempt) + Math.random() * 250;
      await delayWithAbort(
        cappedDelay(backoff, usedRetryAfter ? "Retry-After" : "backoff"),
        opts.signal,
      );
    } catch (err) {
      if (opts.signal?.aborted) {
        throw err instanceof Error ? err : new Error("Aborted");
      }
      lastError = err;
      if (attempt === maxRetries) {
        const msg =
          err instanceof Error ? err.message : "network error or timeout";
        throw new Error(
          `Request failed after ${maxRetries + 1} attempts: ${msg}`,
        );
      }
      opts.onRetry?.({ attempt: attempt + 1 });
      await delayWithAbort(
        cappedDelay(
          baseDelayMs * Math.pow(2, attempt) + Math.random() * 250,
          "backoff",
        ),
        opts.signal,
      );
      void lastError;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onUserAbort);
    }
  }

  // Unreachable — loop always returns or throws.
  throw new Error("resilientFetch: exhausted attempts");
}
