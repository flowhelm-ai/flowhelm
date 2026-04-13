/**
 * Version utilities.
 *
 * Reads the FlowHelm version from package.json at runtime.
 * Used by `flowhelm --version`, `flowhelm doctor`, and `flowhelm status`.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedVersion: string | undefined;

/**
 * Get the FlowHelm version from the nearest package.json.
 *
 * Walks up from `dist/admin/version.js` to find the project root package.json.
 * Caches the result for subsequent calls.
 */
export function getVersion(): string {
  if (cachedVersion) return cachedVersion;

  // dist/admin/version.js → project root (two levels up)
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(thisDir, '..', '..', 'package.json'), // dist/admin → project root
    resolve(thisDir, '..', 'package.json'), // fallback: dist → project root
  ];

  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, 'utf-8');
      const pkg = JSON.parse(raw) as { version?: string; name?: string };
      if (pkg.name === 'flowhelm' && pkg.version) {
        cachedVersion = pkg.version;
        return cachedVersion;
      }
    } catch {
      // Try next candidate
    }
  }

  // Fallback: unknown version (shouldn't happen in a properly built package)
  cachedVersion = '0.0.0-unknown';
  return cachedVersion;
}
