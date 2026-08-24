/**
 * HTTP resilience for hand-rolled provider fetches (issue #104).
 *
 * Guarantees:
 * - Per-request timeout via a linked AbortSignal (default 120s).
 * - Bounded retries with exponential backoff + jitter on connection errors,
 *   429 and 5xx responses. Applies to the INITIAL response only — once a
 *   stream starts producing tokens, retries never re-send the request.
 * - Retry-After header honored when present.
 * - Caller abort always wins immediately.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;

export interface FetchResilienceOptions {
  /** Caller cancellation signal (user stop button). */
  signal?: AbortSignal;
  /** Per-attempt timeout in ms. Default: 120000. */
  timeoutMs?: number;
  /** Number of RETRIES after the first attempt fails. Default: 2. */
  maxRetries?: number;
  /** Base delay for exponential backoff. Default: 500ms. */
  baseDelayMs?: number;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
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
      const backoff =
        Number.isFinite(retryAfterSec) && retryAfterSec >= 0
          ? retryAfterSec * 1000
          : baseDelayMs * Math.pow(2, attempt) + Math.random() * 250;
      await delayWithAbort(backoff, opts.signal);
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
      await delayWithAbort(
        baseDelayMs * Math.pow(2, attempt) + Math.random() * 250,
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
