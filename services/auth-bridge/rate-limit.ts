/**
 * In-memory sliding-window rate limiter.
 *
 * Tracks request timestamps per key (IP address) in a circular buffer.
 * Expired entries are lazily pruned on each check. Separate limits for
 * different endpoint categories.
 */

export interface RateLimitRule {
  /** Maximum requests allowed in the window. */
  maxRequests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

/** Per-endpoint rate limit rules (from auth-bridge.md). */
export const RATE_LIMITS = {
  /** POST /api/session — session creation. */
  sessionCreate: { maxRequests: 5, windowMs: 60_000 } as RateLimitRule,
  /** GET /api/session/:token/poll — VM polling. */
  poll: { maxRequests: 30, windowMs: 60_000 } as RateLimitRule,
  /** POST /api/session/:token — browser credential submission. */
  submit: { maxRequests: 3, windowMs: 60_000 } as RateLimitRule,
  /** GET /qr/:token — QR code generation. */
  qr: { maxRequests: 30, windowMs: 60_000 } as RateLimitRule,
} as const;

/** Global rate limit for session creation (across all IPs). */
export const GLOBAL_SESSION_LIMIT: RateLimitRule = {
  maxRequests: 1000,
  windowMs: 3_600_000, // 1 hour
};

interface BucketEntry {
  timestamps: number[];
}

export class RateLimiter {
  private readonly buckets = new Map<string, BucketEntry>();
  private readonly globalBucket: BucketEntry = { timestamps: [] };
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(cleanupIntervalMs = 300_000) {
    this.cleanupTimer = setInterval(
      () => this.pruneAll(),
      cleanupIntervalMs,
    );
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Check if a request is allowed under the given rule.
   * @param key — identifier (typically IP address)
   * @param rule — rate limit rule to apply
   * @returns true if allowed, false if rate-limited
   */
  check(key: string, rule: RateLimitRule): boolean {
    const now = Date.now();
    const cutoff = now - rule.windowMs;

    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.buckets.set(key, entry);
    }

    // Prune expired timestamps
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= rule.maxRequests) {
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  /**
   * Check the global rate limit (shared across all IPs).
   * Used for session creation to cap total throughput.
   */
  checkGlobal(rule: RateLimitRule): boolean {
    const now = Date.now();
    const cutoff = now - rule.windowMs;

    this.globalBucket.timestamps = this.globalBucket.timestamps.filter(
      (t) => t > cutoff,
    );

    if (this.globalBucket.timestamps.length >= rule.maxRequests) {
      return false;
    }

    this.globalBucket.timestamps.push(now);
    return true;
  }

  /**
   * Get remaining requests for a key under a rule.
   * Useful for setting Retry-After headers.
   */
  remaining(key: string, rule: RateLimitRule): number {
    const now = Date.now();
    const cutoff = now - rule.windowMs;
    const entry = this.buckets.get(key);
    if (!entry) return rule.maxRequests;

    const active = entry.timestamps.filter((t) => t > cutoff).length;
    return Math.max(0, rule.maxRequests - active);
  }

  /**
   * Get the time (ms) until the next request would be allowed.
   * Returns 0 if not rate-limited.
   */
  retryAfterMs(key: string, rule: RateLimitRule): number {
    const now = Date.now();
    const cutoff = now - rule.windowMs;
    const entry = this.buckets.get(key);
    if (!entry) return 0;

    const active = entry.timestamps.filter((t) => t > cutoff);
    if (active.length < rule.maxRequests) return 0;

    // Earliest timestamp that's still in the window — when it expires, a slot opens.
    const earliest = Math.min(...active);
    return earliest + rule.windowMs - now;
  }

  /** Remove all entries with only expired timestamps. */
  private pruneAll(): void {
    const now = Date.now();
    // Use the longest window (1 hour) as the prune cutoff
    const cutoff = now - 3_600_000;

    for (const [key, entry] of this.buckets) {
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
      if (entry.timestamps.length === 0) {
        this.buckets.delete(key);
      }
    }

    this.globalBucket.timestamps = this.globalBucket.timestamps.filter(
      (t) => t > cutoff,
    );
  }

  /** Stop cleanup timer. Call on shutdown. */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.buckets.clear();
    this.globalBucket.timestamps = [];
  }
}
