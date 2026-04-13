/**
 * OAuth credential persistence for Claude Code CLI.
 *
 * Reads/writes ~/.claude/.credentials.json in the format the claude binary expects.
 * Files are created with mode 0600 (owner read/write only).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

export interface CredentialFile {
  claudeAiOauth: ClaudeOAuthCredentials;
}

/** Default credentials file path: ~/.claude/.credentials.json */
export function defaultCredentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json');
}

/** Default account metadata path: ~/.claude.json */
export function defaultAccountPath(): string {
  return join(homedir(), '.claude.json');
}

/**
 * Read credentials from the credentials file.
 * Returns null if the file does not exist or is malformed.
 */
export async function readCredentials(path?: string): Promise<CredentialFile | null> {
  const filePath = path ?? defaultCredentialsPath();
  try {
    const content = await readFile(filePath, 'utf-8');
    const data = JSON.parse(content) as Record<string, unknown>;

    if (!data.claudeAiOauth || typeof data.claudeAiOauth !== 'object') {
      return null;
    }

    const oauth = data.claudeAiOauth as Record<string, unknown>;
    if (typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
      return null;
    }

    return data as unknown as CredentialFile;
  } catch {
    return null;
  }
}

/**
 * Write credentials to the credentials file.
 * Creates parent directories if needed. Sets file mode 0600.
 */
export async function writeCredentials(credentials: CredentialFile, path?: string): Promise<void> {
  const filePath = path ?? defaultCredentialsPath();
  const dir = dirname(filePath);

  await mkdir(dir, { recursive: true });

  const content = JSON.stringify(credentials, null, 2) + '\n';
  await writeFile(filePath, content, { mode: 0o600 });
}

/**
 * Build a credentials file from a raw access token string.
 * This is used when receiving a token from the auth bridge or direct paste.
 * Sets sensible defaults for optional fields.
 */
export function buildCredentials(
  accessToken: string,
  options: {
    refreshToken?: string;
    subscriptionType?: string;
    rateLimitTier?: string;
  } = {},
): CredentialFile {
  return {
    claudeAiOauth: {
      accessToken,
      refreshToken: options.refreshToken,
      // Default: 1 year from now (the claude binary handles refresh internally)
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      subscriptionType: options.subscriptionType ?? 'pro',
      rateLimitTier: options.rateLimitTier ?? 'pro',
    },
  };
}

/**
 * Validate that a credential file has the minimum required fields.
 */
export function validateCredentials(creds: CredentialFile): boolean {
  const oauth = creds.claudeAiOauth;
  return typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0;
}

/**
 * Store a raw access token as credentials.
 * Convenience wrapper combining buildCredentials + writeCredentials.
 */
export async function storeAccessToken(
  accessToken: string,
  options: {
    refreshToken?: string;
    subscriptionType?: string;
    rateLimitTier?: string;
    path?: string;
  } = {},
): Promise<CredentialFile> {
  const creds = buildCredentials(accessToken, options);
  await writeCredentials(creds, options.path);
  return creds;
}
