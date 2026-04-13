/**
 * Anthropic API key validation and storage.
 *
 * Validates the sk-ant-* key format and persists to the FlowHelm secrets
 * directory for use by the SdkRuntime path.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

/** Anthropic API key prefix pattern: sk-ant-api03- */
const API_KEY_PATTERN = /^sk-ant-api\d{2}-[A-Za-z0-9_-]+$/;

/** Legacy API key pattern (older keys without api prefix). */
const LEGACY_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{40,}$/;

/**
 * Validate that a string looks like a valid Anthropic API key.
 * Checks format only — does not make network requests.
 */
export function validateApiKey(key: string): boolean {
  const trimmed = key.trim();
  return API_KEY_PATTERN.test(trimmed) || LEGACY_KEY_PATTERN.test(trimmed);
}

/** Default path for API key storage: ~/.flowhelm/secrets/api-key */
export function defaultApiKeyPath(dataDir?: string): string {
  const base = dataDir ?? join(homedir(), '.flowhelm');
  return join(base, 'secrets', 'api-key');
}

/**
 * Read the stored API key.
 * Returns null if not found or empty.
 */
export async function readApiKey(path?: string): Promise<string | null> {
  const filePath = path ?? defaultApiKeyPath();
  try {
    const content = await readFile(filePath, 'utf-8');
    const key = content.trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/**
 * Store an API key to the secrets directory.
 * Creates parent directories if needed. Sets file mode 0600.
 *
 * @throws If the key format is invalid
 */
export async function writeApiKey(key: string, path?: string): Promise<void> {
  const trimmed = key.trim();
  if (!validateApiKey(trimmed)) {
    throw new Error('Invalid API key format. Expected sk-ant-api*-... or sk-ant-... format.');
  }

  const filePath = path ?? defaultApiKeyPath();
  const dir = dirname(filePath);

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, trimmed + '\n', { mode: 0o600 });
}

/**
 * Delete the stored API key.
 * No-op if the file does not exist.
 */
export async function deleteApiKey(path?: string): Promise<void> {
  const filePath = path ?? defaultApiKeyPath();
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(filePath);
  } catch {
    // File doesn't exist — no-op
  }
}
