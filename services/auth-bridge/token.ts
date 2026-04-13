/**
 * Short URL token generator for auth bridge sessions.
 *
 * Generates 5-character tokens from a 56-character safe alphabet that
 * excludes visually ambiguous characters (0/O/o, 1/l/I).
 * 56^5 = 550,731,776 possible tokens — collision probability is negligible
 * at expected concurrency levels.
 */

import { randomBytes } from 'node:crypto';

/**
 * Safe alphabet: digits 2-9, uppercase A-Z minus O/I, lowercase a-z minus o/l.
 * 56 characters total. Designed for QR codes and manual typing.
 */
const SAFE_ALPHABET =
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';

const TOKEN_LENGTH = 5;
const MAX_RETRIES = 10;

/**
 * Generate a single random token (no collision check).
 * Uses crypto.randomBytes for uniform distribution via rejection sampling.
 */
export function generateRawToken(): string {
  const chars: string[] = [];
  // Each byte gives 0-255. We reject values >= 224 (largest multiple of 56)
  // to avoid modulo bias. 256 / 56 = 4.571… → 4 * 56 = 224.
  const rejectThreshold = 224; // 4 * 56

  while (chars.length < TOKEN_LENGTH) {
    const bytes = randomBytes(TOKEN_LENGTH - chars.length + 4); // over-request to reduce loops
    for (const byte of bytes) {
      if (byte < rejectThreshold && chars.length < TOKEN_LENGTH) {
        chars.push(SAFE_ALPHABET[byte % SAFE_ALPHABET.length]);
      }
    }
  }

  return chars.join('');
}

/**
 * Generate a unique token that does not collide with any existing token.
 * @param existsFn — returns true if the token is already in use
 * @returns A unique 5-character token
 * @throws If a unique token cannot be generated after MAX_RETRIES attempts
 */
export function generateUniqueToken(existsFn: (token: string) => boolean): string {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const token = generateRawToken();
    if (!existsFn(token)) {
      return token;
    }
  }
  throw new Error(
    `Failed to generate unique token after ${MAX_RETRIES} attempts`,
  );
}

export { SAFE_ALPHABET, TOKEN_LENGTH, MAX_RETRIES };
