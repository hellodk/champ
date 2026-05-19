/**
 * RateLimiter: token-bucket algorithm for LLM API call limiting.
 * Prevents runaway costs from misconfigured agent teams or infinite loops.
 *
 * Config (optional in .champ/config.yaml):
 *   rateLimit:
 *     requestsPerMinute: 30     # max requests per 60s window (default: unlimited)
 *     warningAt: 0.8            # fraction of limit that triggers a warning (default: 0.8)
 */

export interface RateLimitConfig {
  requestsPerMinute?: number;
  warningAt?: number; // 0-1, fraction of limit triggering warning
}

export class RateLimiter {
  private readonly windowMs = 60_000;
  private requestTimestamps: number[] = [];
  private readonly limit: number;
  private readonly warningAt: number;
  onWarning?: (used: number, limit: number) => void;

  constructor(config: RateLimitConfig = {}) {
    this.limit = config.requestsPerMinute ?? Infinity;
    this.warningAt = Math.min(1, Math.max(0, config.warningAt ?? 0.8));
  }

  /**
   * Check if a request is allowed. Returns immediately if within limit,
   * throws RateLimitError if limit is exceeded.
   */
  async acquire(): Promise<void> {
    if (this.limit === Infinity) return;

    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Evict timestamps older than the window
    this.requestTimestamps = this.requestTimestamps.filter(
      (t) => t >= windowStart,
    );

    const used = this.requestTimestamps.length;

    if (used >= this.limit) {
      const oldestInWindow = this.requestTimestamps[0];
      const waitMs = oldestInWindow + this.windowMs - now;
      throw new RateLimitError(
        `Rate limit reached: ${used}/${this.limit} requests in the last 60s. ` +
          `Resets in ${Math.ceil(waitMs / 1000)}s.`,
        waitMs,
      );
    }

    this.requestTimestamps.push(now);

    // Fire warning when approaching limit
    const newUsed = used + 1;
    if (newUsed >= Math.floor(this.limit * this.warningAt)) {
      this.onWarning?.(newUsed, this.limit);
    }
  }

  /** Current usage stats for display */
  getStats(): { used: number; limit: number; resetsIn: number } {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const recent = this.requestTimestamps.filter((t) => t >= windowStart);
    const oldest = recent[0];
    const resetsIn = oldest ? Math.max(0, oldest + this.windowMs - now) : 0;
    return { used: recent.length, limit: this.limit, resetsIn };
  }

  reset(): void {
    this.requestTimestamps = [];
  }
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly waitMs: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}
