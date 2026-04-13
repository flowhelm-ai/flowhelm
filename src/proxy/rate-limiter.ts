/**
 * Per-host sliding window rate limiter.
 *
 * Each credential rule can define a rate limit (requests per window).
 * The limiter tracks request timestamps per host pattern and rejects
 * requests that exceed the configured threshold.
 *
 * Uses an in-memory sliding window — no persistence needed since the
 * proxy container is always running and rate state resets on restart.
 */

import type { RateLimitRule } from './credential-schema.js';

interface WindowEntry {
  /** Timestamps (ms) of requests within the current window. */
  timestamps: number[];
  /** Rate limit rule for this host. */
  rule: RateLimitRule;
}

/**
 * Sliding window rate limiter.
 *
 * Tracks request counts per credential name within configurable windows.
 * Thread-safe in single-threaded Node.js event loop context.
 */
export class RateLimiter {
  private readonly windows = new Map<string, WindowEntry>();

  /**
   * Register a rate limit rule for a credential.
   * Call this once per credential at startup.
   */
  register(credentialName: string, rule: RateLimitRule): void {
    this.windows.set(credentialName, {
      timestamps: [],
      rule,
    });
  }

  /**
   * Check if a request is allowed under the rate limit.
   * If no rate limit is registered for the credential, always allows.
   *
   * @returns Object with `allowed` boolean, `remaining` count, and `retryAfterMs`
   *          (milliseconds until the next window slot opens, if blocked).
   */
  check(credentialName: string, now?: number): RateLimitResult {
    const entry = this.windows.get(credentialName);
    if (!entry) {
      return { allowed: true, remaining: Infinity, retryAfterMs: 0 };
    }

    const currentTime = now ?? Date.now();
    const windowMs = entry.rule.windowSeconds * 1000;
    const windowStart = currentTime - windowMs;

    // Evict expired timestamps
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    if (entry.timestamps.length >= entry.rule.requests) {
      // Rate limited — calculate when the oldest entry expires
      const oldestInWindow = entry.timestamps[0] ?? currentTime;
      const retryAfterMs = oldestInWindow + windowMs - currentTime;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(0, retryAfterMs),
      };
    }

    return {
      allowed: true,
      remaining: entry.rule.requests - entry.timestamps.length,
      retryAfterMs: 0,
    };
  }

  /**
   * Record a request (call after `check()` returns allowed=true).
   */
  record(credentialName: string, now?: number): void {
    const entry = this.windows.get(credentialName);
    if (!entry) return;
    entry.timestamps.push(now ?? Date.now());
  }

  /**
   * Convenience: check and record in one call.
   * Returns the check result. If allowed, the request is automatically recorded.
   */
  consume(credentialName: string, now?: number): RateLimitResult {
    const result = this.check(credentialName, now);
    if (result.allowed) {
      this.record(credentialName, now);
    }
    return result;
  }

  /**
   * Reset all rate limit state (for testing).
   */
  reset(): void {
    for (const entry of this.windows.values()) {
      entry.timestamps = [];
    }
  }

  /**
   * Get current stats for a credential (for debugging/monitoring).
   */
  stats(
    credentialName: string,
  ): { current: number; limit: number; windowSeconds: number } | undefined {
    const entry = this.windows.get(credentialName);
    if (!entry) return undefined;

    const windowMs = entry.rule.windowSeconds * 1000;
    const windowStart = Date.now() - windowMs;
    const current = entry.timestamps.filter((t) => t > windowStart).length;

    return {
      current,
      limit: entry.rule.requests,
      windowSeconds: entry.rule.windowSeconds,
    };
  }
}

export interface RateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Remaining requests in the current window. */
  remaining: number;
  /** Milliseconds until the next window slot opens (0 if allowed). */
  retryAfterMs: number;
}
