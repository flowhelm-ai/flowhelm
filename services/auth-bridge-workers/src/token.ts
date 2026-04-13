/**
 * Short URL token generator — Workers-compatible (Web Crypto API).
 *
 * Generates 5-character tokens from a 56-character safe alphabet that
 * excludes visually ambiguous characters (0/O/o, 1/l/I).
 */

const SAFE_ALPHABET =
  '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';

const TOKEN_LENGTH = 5;
const MAX_RETRIES = 10;

/** Rejection threshold: largest multiple of 56 that fits in a byte. 4 * 56 = 224. */
const REJECT_THRESHOLD = 224;

export function generateRawToken(): string {
  const chars: string[] = [];

  while (chars.length < TOKEN_LENGTH) {
    const bytes = new Uint8Array(TOKEN_LENGTH - chars.length + 4);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < REJECT_THRESHOLD && chars.length < TOKEN_LENGTH) {
        chars.push(SAFE_ALPHABET[byte % SAFE_ALPHABET.length]!);
      }
    }
  }

  return chars.join('');
}

export function generateUniqueToken(existsFn: (token: string) => boolean): string {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const token = generateRawToken();
    if (!existsFn(token)) return token;
  }
  throw new Error(`Failed to generate unique token after ${MAX_RETRIES} attempts`);
}

export { SAFE_ALPHABET, TOKEN_LENGTH };
