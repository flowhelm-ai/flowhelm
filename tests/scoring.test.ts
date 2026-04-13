import { describe, it, expect } from 'vitest';
import {
  compositeScore,
  rankByCompositeScore,
  DEFAULT_SCORING_WEIGHTS,
} from '../src/orchestrator/scoring.js';
import type { ScoringWeights } from '../src/orchestrator/types.js';

const MS_PER_DAY = 86_400_000;

describe('compositeScore', () => {
  const now = Date.now();

  it('computes the correct formula: α·similarity + β·e^(−λ·Δt) + γ·importance', () => {
    const similarity = 0.9;
    const lastAccessed = now; // Δt = 0
    const importance = 0.8;

    const score = compositeScore(
      similarity,
      lastAccessed,
      importance,
      DEFAULT_SCORING_WEIGHTS,
      now,
    );

    // α=0.5, β=0.3, γ=0.2
    // score = 0.5*0.9 + 0.3*e^0 + 0.2*0.8 = 0.45 + 0.3 + 0.16 = 0.91
    expect(score).toBeCloseTo(0.91, 5);
  });

  it('applies recency decay over time', () => {
    const recent = compositeScore(0.8, now, 0.5, DEFAULT_SCORING_WEIGHTS, now);
    const sevenDaysAgo = compositeScore(
      0.8,
      now - 7 * MS_PER_DAY,
      0.5,
      DEFAULT_SCORING_WEIGHTS,
      now,
    );
    const yearAgo = compositeScore(0.8, now - 365 * MS_PER_DAY, 0.5, DEFAULT_SCORING_WEIGHTS, now);

    expect(recent).toBeGreaterThan(sevenDaysAgo);
    expect(sevenDaysAgo).toBeGreaterThan(yearAgo);
  });

  it('returns maximum score when all components are 1.0 and Δt=0', () => {
    const score = compositeScore(1.0, now, 1.0, DEFAULT_SCORING_WEIGHTS, now);
    // 0.5*1 + 0.3*1 + 0.2*1 = 1.0
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('returns minimum score when all components are 0 and Δt is very large', () => {
    const veryOld = now - 10000 * MS_PER_DAY;
    const score = compositeScore(0, veryOld, 0, DEFAULT_SCORING_WEIGHTS, now);
    expect(score).toBeCloseTo(0, 1);
  });

  it('handles zero recency (lastAccessed = now)', () => {
    const score = compositeScore(0.5, now, 0.5, DEFAULT_SCORING_WEIGHTS, now);
    // 0.5*0.5 + 0.3*1 + 0.2*0.5 = 0.25 + 0.3 + 0.1 = 0.65
    expect(score).toBeCloseTo(0.65, 5);
  });

  it('handles custom weights', () => {
    const weights: ScoringWeights = { alpha: 1.0, beta: 0.0, gamma: 0.0, lambda: 0.01 };
    const score = compositeScore(0.7, now - 30 * MS_PER_DAY, 0.9, weights, now);
    // Only similarity matters
    expect(score).toBeCloseTo(0.7, 5);
  });

  it('handles future lastAccessed (Δt clamped to 0)', () => {
    const futureTime = now + MS_PER_DAY;
    const score = compositeScore(0.5, futureTime, 0.5, DEFAULT_SCORING_WEIGHTS, now);
    // Δt clamped to 0, so recency = e^0 = 1
    expect(score).toBeCloseTo(0.65, 5);
  });

  it('lambda controls decay rate', () => {
    const fastDecay: ScoringWeights = { alpha: 0, beta: 1.0, gamma: 0, lambda: 0.1 };
    const slowDecay: ScoringWeights = { alpha: 0, beta: 1.0, gamma: 0, lambda: 0.001 };
    const thirtyDaysAgo = now - 30 * MS_PER_DAY;

    const fast = compositeScore(0.5, thirtyDaysAgo, 0.5, fastDecay, now);
    const slow = compositeScore(0.5, thirtyDaysAgo, 0.5, slowDecay, now);

    expect(slow).toBeGreaterThan(fast);
  });
});

describe('rankByCompositeScore', () => {
  const now = Date.now();

  it('sorts candidates by composite score descending', () => {
    const candidates = [
      { similarity: 0.6, lastAccessed: now - 10 * MS_PER_DAY, importance: 0.3 },
      { similarity: 0.9, lastAccessed: now, importance: 0.8 },
      { similarity: 0.7, lastAccessed: now - 1 * MS_PER_DAY, importance: 0.5 },
    ];

    const ranked = rankByCompositeScore(candidates, DEFAULT_SCORING_WEIGHTS, 10, now);

    expect(ranked[0].similarity).toBe(0.9); // Most relevant + recent + important
    expect(ranked[ranked.length - 1].similarity).toBe(0.6); // Least
    // All should have compositeScore
    for (const r of ranked) {
      expect(r.compositeScore).toBeGreaterThan(0);
    }
  });

  it('truncates to the specified limit', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      similarity: (10 - i) / 10,
      lastAccessed: now,
      importance: 0.5,
    }));

    const ranked = rankByCompositeScore(candidates, DEFAULT_SCORING_WEIGHTS, 3, now);
    expect(ranked.length).toBe(3);
  });

  it('returns empty array for empty input', () => {
    const ranked = rankByCompositeScore([], DEFAULT_SCORING_WEIGHTS, 10, now);
    expect(ranked).toEqual([]);
  });

  it('newer + relevant beats old + relevant', () => {
    const candidates = [
      { similarity: 0.9, lastAccessed: now - 365 * MS_PER_DAY, importance: 0.5 },
      { similarity: 0.85, lastAccessed: now, importance: 0.5 },
    ];

    const ranked = rankByCompositeScore(candidates, DEFAULT_SCORING_WEIGHTS, 10, now);
    // The recent one should win despite slightly lower similarity
    expect(ranked[0].similarity).toBe(0.85);
  });

  it('preserves original candidate properties', () => {
    const candidates = [
      { similarity: 0.8, lastAccessed: now, importance: 0.5, id: 'abc', content: 'test' },
    ];

    const ranked = rankByCompositeScore(candidates, DEFAULT_SCORING_WEIGHTS, 10, now);
    expect(ranked[0]).toHaveProperty('id', 'abc');
    expect(ranked[0]).toHaveProperty('content', 'test');
    expect(ranked[0]).toHaveProperty('compositeScore');
  });
});

describe('DEFAULT_SCORING_WEIGHTS', () => {
  it('has expected default values', () => {
    expect(DEFAULT_SCORING_WEIGHTS.alpha).toBe(0.5);
    expect(DEFAULT_SCORING_WEIGHTS.beta).toBe(0.3);
    expect(DEFAULT_SCORING_WEIGHTS.gamma).toBe(0.2);
    expect(DEFAULT_SCORING_WEIGHTS.lambda).toBe(0.01);
  });

  it('weights sum to 1.0', () => {
    const sum =
      DEFAULT_SCORING_WEIGHTS.alpha + DEFAULT_SCORING_WEIGHTS.beta + DEFAULT_SCORING_WEIGHTS.gamma;
    expect(sum).toBeCloseTo(1.0, 5);
  });
});
