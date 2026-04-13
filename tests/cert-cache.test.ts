import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CertCache } from '../src/proxy/cert-cache.js';

describe('CertCache', () => {
  describe('basic operations', () => {
    it('returns undefined for unknown keys', () => {
      const cache = new CertCache<string>();
      expect(cache.get('unknown')).toBeUndefined();
    });

    it('stores and retrieves values', () => {
      const cache = new CertCache<string>();
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('tracks size', () => {
      const cache = new CertCache<string>();
      expect(cache.size).toBe(0);
      cache.set('a', 'v');
      expect(cache.size).toBe(1);
      cache.set('b', 'v');
      expect(cache.size).toBe(2);
    });

    it('overwrites existing keys', () => {
      const cache = new CertCache<string>();
      cache.set('key', 'old');
      cache.set('key', 'new');
      expect(cache.get('key')).toBe('new');
      expect(cache.size).toBe(1);
    });

    it('clears all entries', () => {
      const cache = new CertCache<string>();
      cache.set('a', '1');
      cache.set('b', '2');
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get('a')).toBeUndefined();
    });

    it('has() returns true for existing keys', () => {
      const cache = new CertCache<string>();
      cache.set('key', 'value');
      expect(cache.has('key')).toBe(true);
      expect(cache.has('other')).toBe(false);
    });
  });

  describe('LRU eviction', () => {
    it('evicts oldest entry when at capacity', () => {
      const cache = new CertCache<string>({ maxEntries: 2 });
      cache.set('a', '1');
      cache.set('b', '2');
      cache.set('c', '3'); // Should evict 'a'
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe('2');
      expect(cache.get('c')).toBe('3');
      expect(cache.size).toBe(2);
    });

    it('get() refreshes LRU position', () => {
      const cache = new CertCache<string>({ maxEntries: 2 });
      cache.set('a', '1');
      cache.set('b', '2');
      cache.get('a'); // Touch 'a' — now 'b' is oldest
      cache.set('c', '3'); // Should evict 'b' (oldest)
      expect(cache.get('a')).toBe('1');
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBe('3');
    });
  });

  describe('TTL expiration', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns undefined for expired entries', () => {
      const cache = new CertCache<string>({ ttlMs: 1000 });
      cache.set('key', 'value');
      expect(cache.get('key')).toBe('value');

      vi.advanceTimersByTime(1001);
      expect(cache.get('key')).toBeUndefined();
    });

    it('has() returns false for expired entries', () => {
      const cache = new CertCache<string>({ ttlMs: 1000 });
      cache.set('key', 'value');
      expect(cache.has('key')).toBe(true);

      vi.advanceTimersByTime(1001);
      expect(cache.has('key')).toBe(false);
    });

    it('cleans up expired entries on access', () => {
      const cache = new CertCache<string>({ ttlMs: 1000 });
      cache.set('key', 'value');
      expect(cache.size).toBe(1);

      vi.advanceTimersByTime(1001);
      cache.get('key'); // Access triggers cleanup
      expect(cache.size).toBe(0);
    });
  });

  describe('getOrCreate', () => {
    it('calls generator on cache miss', async () => {
      const cache = new CertCache<string>();
      const generator = vi.fn().mockReturnValue('generated');

      const result = await cache.getOrCreate('key', generator);
      expect(result).toBe('generated');
      expect(generator).toHaveBeenCalledWith('key');
    });

    it('returns cached value on cache hit (no generator call)', async () => {
      const cache = new CertCache<string>();
      cache.set('key', 'cached');
      const generator = vi.fn().mockReturnValue('generated');

      const result = await cache.getOrCreate('key', generator);
      expect(result).toBe('cached');
      expect(generator).not.toHaveBeenCalled();
    });

    it('handles async generators', async () => {
      const cache = new CertCache<string>();
      const generator = vi.fn().mockResolvedValue('async-value');

      const result = await cache.getOrCreate('key', generator);
      expect(result).toBe('async-value');
    });

    it('caches the generated value for subsequent gets', async () => {
      const cache = new CertCache<string>();
      const generator = vi.fn().mockReturnValue('generated');

      await cache.getOrCreate('key', generator);
      const result = cache.get('key');
      expect(result).toBe('generated');
    });
  });
});
