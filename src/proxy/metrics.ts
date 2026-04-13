/**
 * Proxy request metrics with percentile tracking.
 *
 * Tracks per-credential request counts, status code distribution,
 * rate limit hits, and latency percentiles using a circular buffer
 * of the last 1000 measurements.
 */

// ─── Circular Buffer ─────────────────────────────────────────────────────────

class CircularBuffer {
  private readonly buffer: number[];
  private readonly capacity: number;
  private index = 0;
  private count = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Array<number>(capacity).fill(0);
  }

  push(value: number): void {
    this.buffer[this.index % this.capacity] = value;
    this.index++;
    if (this.count < this.capacity) this.count++;
  }

  /** Get sorted snapshot of current values. */
  sorted(): number[] {
    const values = this.buffer.slice(0, this.count);
    return values.sort((a, b) => a - b);
  }

  get size(): number {
    return this.count;
  }
}

// ─── Percentile Helpers ──────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

export interface MetricsSnapshot {
  uptime: number;
  totalRequests: number;
  perCredential: Record<string, number>;
  statusCodes: Record<string, number>;
  rateLimitHits: number;
  latency: {
    p50: number;
    p90: number;
    p99: number;
    count: number;
  };
}

/**
 * In-memory proxy metrics collector.
 *
 * All methods are synchronous for minimal overhead in the hot path.
 */
export class ProxyMetrics {
  private readonly startedAt = Date.now();
  private totalRequests = 0;
  private readonly credentialCounts = new Map<string, number>();
  private readonly statusCodeCounts = new Map<string, number>();
  private rateLimitHits = 0;
  private readonly latencyBuffer: CircularBuffer;

  constructor(latencyBufferSize = 1000) {
    this.latencyBuffer = new CircularBuffer(latencyBufferSize);
  }

  /**
   * Record a completed request.
   */
  record(credentialName: string, statusCode: number, durationMs: number): void {
    this.totalRequests++;
    this.credentialCounts.set(credentialName, (this.credentialCounts.get(credentialName) ?? 0) + 1);
    const codeKey = String(statusCode);
    this.statusCodeCounts.set(codeKey, (this.statusCodeCounts.get(codeKey) ?? 0) + 1);
    this.latencyBuffer.push(durationMs);
  }

  /**
   * Record a rate limit hit.
   */
  recordRateLimitHit(): void {
    this.rateLimitHits++;
  }

  /**
   * Get a snapshot of current metrics.
   */
  snapshot(): MetricsSnapshot {
    const sorted = this.latencyBuffer.sorted();
    return {
      uptime: Date.now() - this.startedAt,
      totalRequests: this.totalRequests,
      perCredential: Object.fromEntries(this.credentialCounts),
      statusCodes: Object.fromEntries(this.statusCodeCounts),
      rateLimitHits: this.rateLimitHits,
      latency: {
        p50: percentile(sorted, 50),
        p90: percentile(sorted, 90),
        p99: percentile(sorted, 99),
        count: this.latencyBuffer.size,
      },
    };
  }

  /**
   * Reset all metrics (used during tests or credential reload).
   */
  reset(): void {
    this.totalRequests = 0;
    this.credentialCounts.clear();
    this.statusCodeCounts.clear();
    this.rateLimitHits = 0;
  }
}
