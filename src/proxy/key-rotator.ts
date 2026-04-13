/**
 * Multi-key round-robin selector.
 *
 * When a credential rule has a `values` array (multiple API keys),
 * the rotator distributes requests across them sequentially. Falls
 * back to the single `value` field when no `values` array is present.
 */

import type { CredentialRule } from './credential-schema.js';

/**
 * Round-robin key rotator for multi-key credential rules.
 *
 * Each credential name gets an independent counter. The counter
 * increments atomically (single-threaded Node.js) and wraps via
 * modulo to cycle through available keys evenly.
 */
export class KeyRotator {
  private readonly counters = new Map<string, number>();

  /**
   * Get the next credential value for a rule.
   *
   * If the rule has a `values` array, returns the next value in
   * round-robin order. Otherwise returns the single `value`.
   */
  getNextValue(credential: CredentialRule): string {
    if (!credential.values || credential.values.length === 0) {
      return credential.value;
    }

    const current = this.counters.get(credential.name) ?? 0;
    const idx = current % credential.values.length;
    const value = credential.values[idx] ?? credential.value;
    this.counters.set(credential.name, current + 1);
    return value;
  }

  /**
   * Reset all counters (used during credential reload).
   */
  reset(): void {
    this.counters.clear();
  }

  /**
   * Get the current counter for a credential (for metrics/debugging).
   */
  getCounter(credentialName: string): number {
    return this.counters.get(credentialName) ?? 0;
  }
}
