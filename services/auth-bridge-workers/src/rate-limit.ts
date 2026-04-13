/**
 * KV-backed rate limiter for Cloudflare Workers.
 *
 * Uses a counter-per-window approach: each rate limit check reads a counter
 * from KV, increments it, and writes back with TTL matching the window.
 *
 * Key format: rl:{category}:{ip}:{windowId}
 * Value: request count (number as string)
 * TTL: window duration
 *
 * Trade-off: KV is eventually consistent, so under high concurrency the
 * effective limit may be slightly higher than configured. This is acceptable
 * for an auth bridge — Cloudflare's edge network provides DDoS protection,
 * and the short session TTL + E2E encryption make brute-force useless.
 */

export interface RateLimitRule {
  maxRequests: number;
  windowMs: number;
}

export const RATE_LIMITS = {
  sessionCreate: { maxRequests: 5, windowMs: 60_000 } as RateLimitRule,
  poll: { maxRequests: 30, windowMs: 60_000 } as RateLimitRule,
  submit: { maxRequests: 3, windowMs: 60_000 } as RateLimitRule,
  qr: { maxRequests: 30, windowMs: 60_000 } as RateLimitRule,
} as const;

export const GLOBAL_SESSION_LIMIT: RateLimitRule = {
  maxRequests: 1000,
  windowMs: 3_600_000,
};

const RL_PREFIX = 'rl:';

export class KVRateLimiter {
  constructor(private readonly kv: KVNamespace) {}

  /**
   * Check if a request is allowed. Increments the counter if allowed.
   * Returns true if under the limit, false if rate-limited.
   */
  async check(key: string, rule: RateLimitRule): Promise<boolean> {
    const windowId = Math.floor(Date.now() / rule.windowMs);
    const kvKey = `${RL_PREFIX}${key}:${windowId}`;
    const ttlSeconds = Math.ceil(rule.windowMs / 1000);

    const raw = await this.kv.get(kvKey);
    const count = raw ? parseInt(raw, 10) : 0;

    if (count >= rule.maxRequests) {
      return false;
    }

    // Increment — eventual consistency means this could race, but the
    // worst case is allowing a few extra requests through.
    await this.kv.put(kvKey, String(count + 1), {
      expirationTtl: ttlSeconds,
    });

    return true;
  }

  /**
   * Check the global rate limit (shared across all IPs).
   */
  async checkGlobal(rule: RateLimitRule): Promise<boolean> {
    return this.check('global', rule);
  }

  /**
   * Get remaining requests for a key under a rule.
   */
  async remaining(key: string, rule: RateLimitRule): Promise<number> {
    const windowId = Math.floor(Date.now() / rule.windowMs);
    const kvKey = `${RL_PREFIX}${key}:${windowId}`;

    const raw = await this.kv.get(kvKey);
    const count = raw ? parseInt(raw, 10) : 0;

    return Math.max(0, rule.maxRequests - count);
  }
}
