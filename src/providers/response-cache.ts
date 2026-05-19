/**
 * ResponseCache: TTL-based in-memory cache for LLM responses.
 *
 * Key = SHA256 of (provider + model + messages JSON).
 * Only caches complete, non-streaming responses under 10 KB.
 * TTL default: 5 minutes.
 *
 * Usage: opt-in by calling agentController.setResponseCache(cache) after
 * constructing AgentController. The cache is shared across all messages
 * in a session and is never persisted to disk.
 */
import * as crypto from "crypto";

export interface CacheEntry {
  response: string;
  timestamp: number;
  ttlMs: number;
}

export class ResponseCache {
  private cache = new Map<string, CacheEntry>();
  private readonly defaultTtlMs: number;

  constructor(ttlMinutes = 5) {
    this.defaultTtlMs = ttlMinutes * 60 * 1000;
  }

  private makeKey(
    provider: string,
    model: string,
    messagesJson: string,
  ): string {
    return crypto
      .createHash("sha256")
      .update(`${provider}:${model}:${messagesJson}`)
      .digest("hex")
      .slice(0, 32);
  }

  /**
   * Look up a cached response. Returns null on cache miss or if the entry
   * has expired (expired entries are evicted on read).
   */
  get(provider: string, model: string, messagesJson: string): string | null {
    const key = this.makeKey(provider, model, messagesJson);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > entry.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.response;
  }

  /**
   * Store a response in the cache. Responses larger than 10 KB are silently
   * dropped (they are unlikely to benefit from caching and would waste memory).
   * When the cache exceeds 100 entries the oldest entry is evicted.
   */
  set(
    provider: string,
    model: string,
    messagesJson: string,
    response: string,
  ): void {
    // Only cache responses under 10 KB
    if (response.length > 10_000) return;
    const key = this.makeKey(provider, model, messagesJson);
    this.cache.set(key, {
      response,
      timestamp: Date.now(),
      ttlMs: this.defaultTtlMs,
    });
    // Evict the oldest entry when the cap is reached.
    // Map preserves insertion order — first key is oldest (O(1)).
    if (this.cache.size > 100) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
  }

  /** Remove all cached entries. */
  clear(): void {
    this.cache.clear();
  }

  /** Number of entries currently in the cache. */
  get size(): number {
    return this.cache.size;
  }
}
