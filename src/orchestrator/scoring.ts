/**
 * Composite scoring for two-phase memory retrieval.
 *
 * Phase 1: HNSW candidate fetch (sub-ms, in PostgreSQL).
 * Phase 2: In-memory re-ranking using composite scoring (microseconds).
 *
 * Formula: score = α·similarity + β·e^(−λ·Δt) + γ·importance
 *
 * See ADR-029 for design rationale.
 */

import type { ScoringWeights } from './types.js';

const MS_PER_DAY = 86_400_000;

/** Default scoring weights. */
export const DEFAULT_SCORING_WEIGHTS: Readonly<ScoringWeights> = {
  alpha: 0.5,
  beta: 0.3,
  gamma: 0.2,
  lambda: 0.01,
};

/** Default candidate oversampling multiplier for Phase 1 HNSW fetch. */
export const DEFAULT_CANDIDATE_MULTIPLIER = 3;

/**
 * Compute a composite score for a memory candidate.
 *
 * @param similarity - Cosine similarity from HNSW index (0–1).
 * @param lastAccessedMs - Timestamp of last access in milliseconds.
 * @param importance - Importance or confidence value (0–1).
 * @param weights - Scoring weight parameters.
 * @param nowMs - Current time in milliseconds (injectable for testing).
 * @returns Composite score (higher is better).
 */
export function compositeScore(
  similarity: number,
  lastAccessedMs: number,
  importance: number,
  weights: ScoringWeights,
  nowMs: number = Date.now(),
): number {
  const deltaDays = Math.max(0, (nowMs - lastAccessedMs) / MS_PER_DAY);
  const recencyDecay = Math.exp(-weights.lambda * deltaDays);
  return weights.alpha * similarity + weights.beta * recencyDecay + weights.gamma * importance;
}

/**
 * Two-phase re-ranking: compute composite scores and return top N.
 *
 * @param candidates - Candidates from Phase 1 HNSW fetch, each with similarity and
 *   a `lastAccessed` timestamp and `importance` (or `confidence`) value.
 * @param weights - Scoring weight parameters.
 * @param limit - Max results to return.
 * @param nowMs - Current time in milliseconds (injectable for testing).
 * @returns Sorted array of candidates with their composite scores, truncated to `limit`.
 */
export function rankByCompositeScore<
  T extends { lastAccessed: number; importance: number; similarity: number },
>(
  candidates: T[],
  weights: ScoringWeights,
  limit: number,
  nowMs: number = Date.now(),
): Array<T & { compositeScore: number }> {
  return candidates
    .map((c) => ({
      ...c,
      compositeScore: compositeScore(c.similarity, c.lastAccessed, c.importance, weights, nowMs),
    }))
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, limit);
}
