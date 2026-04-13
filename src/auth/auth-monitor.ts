/**
 * Auth health monitoring for FlowHelm.
 *
 * Checks the status of configured authentication methods:
 * - OAuth tokens: reads ~/.claude/.credentials.json, checks expiresAt
 * - API keys: reads ~/.flowhelm/secrets/api-key, validates format
 *
 * Used by `flowhelm doctor`, `flowhelm status`, and `flowhelm auth status`.
 * OAuth tokens issued by Claude are valid for ~1 year; this monitor warns
 * at a configurable threshold (default 30 days) before expiry.
 */

import { readFile } from 'node:fs/promises';
import type { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { validateApiKey } from './api-key.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type AuthType = 'oauth' | 'api_key' | 'none';

export interface AuthHealthResult {
  /** Which auth method is configured. */
  type: AuthType;
  /** Overall health status. */
  status: 'ok' | 'warn' | 'expiring' | 'expired' | 'missing';
  /** Human-readable message. */
  message: string;
  /** Days until token expires (OAuth only). Negative means already expired. */
  daysRemaining?: number;
  /** ISO 8601 expiry timestamp (OAuth only). */
  expiresAt?: string;
  /** Subscription type from OAuth credentials. */
  subscriptionType?: string;
  /** Actionable fix suggestion. */
  fix?: string;
}

export interface AuthMonitorOptions {
  /** Override home directory for testing. */
  homeDir?: string;
  /** Warning threshold in days. Default: 30. */
  warnDays?: number;
  /** Custom file reader for testing. */
  readFileFn?: typeof readFile;
  /** Custom stat function for testing. */
  statFn?: typeof stat;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_WARN_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── OAuth Check ────────────────────────────────────────────────────────────

async function checkOAuth(opts: AuthMonitorOptions): Promise<AuthHealthResult | null> {
  const home = opts.homeDir ?? homedir();
  const credPath = join(home, '.claude', '.credentials.json');
  const readFn = opts.readFileFn ?? readFile;

  let content: string;
  try {
    content = await readFn(credPath, 'utf-8');
  } catch {
    return null; // File doesn't exist — not using OAuth
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return {
      type: 'oauth',
      status: 'warn',
      message: 'OAuth credentials file is malformed',
      fix: 'Run "flowhelm setup" to reconfigure authentication',
    };
  }

  const oauth = data.claudeAiOauth as Record<string, unknown> | undefined;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    return {
      type: 'oauth',
      status: 'warn',
      message: 'OAuth credentials file missing access token',
      fix: 'Run "flowhelm setup" to reconfigure authentication',
    };
  }

  const subscriptionType = (
    typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : 'unknown'
  ) as string;

  // Check expiry
  if (typeof oauth.expiresAt === 'string') {
    const expiresMs = new Date(oauth.expiresAt).getTime();
    if (isNaN(expiresMs)) {
      return {
        type: 'oauth',
        status: 'ok',
        message: `OAuth token active (${subscriptionType}), expiry date unparseable`,
        subscriptionType,
      };
    }

    const now = Date.now();
    const daysRemaining = Math.floor((expiresMs - now) / MS_PER_DAY);
    const warnDays = opts.warnDays ?? DEFAULT_WARN_DAYS;

    if (daysRemaining < 0) {
      return {
        type: 'oauth',
        status: 'expired',
        message: `OAuth token expired ${String(-daysRemaining)} day(s) ago`,
        daysRemaining,
        expiresAt: oauth.expiresAt,
        subscriptionType,
        fix: 'Run "flowhelm setup" to re-authenticate',
      };
    }

    if (daysRemaining <= warnDays) {
      return {
        type: 'oauth',
        status: 'expiring',
        message: `OAuth token expires in ${String(daysRemaining)} day(s)`,
        daysRemaining,
        expiresAt: oauth.expiresAt,
        subscriptionType,
        fix: 'Run "flowhelm setup" to renew authentication',
      };
    }

    return {
      type: 'oauth',
      status: 'ok',
      message: `OAuth token valid (${subscriptionType}), expires in ${String(daysRemaining)} days`,
      daysRemaining,
      expiresAt: oauth.expiresAt,
      subscriptionType,
    };
  }

  // No expiresAt field — can't check
  return {
    type: 'oauth',
    status: 'ok',
    message: `OAuth token active (${subscriptionType}), no expiry set`,
    subscriptionType,
  };
}

// ─── API Key Check ──────────────────────────────────────────────────────────

async function checkApiKey(opts: AuthMonitorOptions): Promise<AuthHealthResult | null> {
  const home = opts.homeDir ?? homedir();
  const keyPath = resolve(home, '.flowhelm', 'secrets', 'api-key');
  const readFn = opts.readFileFn ?? readFile;

  let content: string;
  try {
    content = await readFn(keyPath, 'utf-8');
  } catch {
    return null; // File doesn't exist — not using API key
  }

  const key = content.trim();
  if (!key) {
    return {
      type: 'api_key',
      status: 'warn',
      message: 'API key file is empty',
      fix: 'Run "flowhelm setup" to configure an API key',
    };
  }

  if (!validateApiKey(key)) {
    return {
      type: 'api_key',
      status: 'warn',
      message: 'API key format is invalid',
      fix: 'Run "flowhelm setup" to configure a valid Anthropic API key',
    };
  }

  // Mask key for display: show first 10 chars + last 4
  const masked =
    key.length > 14 ? `${key.slice(0, 10)}...${key.slice(-4)}` : key.slice(0, 6) + '...';

  return {
    type: 'api_key',
    status: 'ok',
    message: `API key configured (${masked})`,
  };
}

// ─── Main Check ─────────────────────────────────────────────────────────────

/**
 * Check all configured auth methods and return their health.
 * Checks both OAuth and API key — a user may have both configured.
 */
export async function checkAuthHealth(opts: AuthMonitorOptions = {}): Promise<AuthHealthResult[]> {
  const results: AuthHealthResult[] = [];

  const oauthResult = await checkOAuth(opts);
  if (oauthResult) results.push(oauthResult);

  const apiKeyResult = await checkApiKey(opts);
  if (apiKeyResult) results.push(apiKeyResult);

  if (results.length === 0) {
    results.push({
      type: 'none',
      status: 'missing',
      message: 'No authentication configured',
      fix: 'Run "flowhelm setup" to configure authentication',
    });
  }

  return results;
}

/**
 * Get the primary auth health result (worst status wins).
 * Used by doctor and status for a single-line summary.
 */
export async function getAuthStatus(opts: AuthMonitorOptions = {}): Promise<AuthHealthResult> {
  const results = await checkAuthHealth(opts);
  if (results.length === 0) {
    return {
      type: 'none',
      status: 'missing',
      message: 'No authentication configured',
      fix: 'Run "flowhelm setup" to configure authentication',
    };
  }

  // Priority: expired > expiring > warn > missing > ok
  const priority = ['expired', 'expiring', 'warn', 'missing', 'ok'] as const;
  let worst: AuthHealthResult = results[0] as AuthHealthResult;
  for (const r of results) {
    const ri = priority.indexOf(r.status);
    const wi = priority.indexOf(worst.status);
    if (ri < wi) worst = r;
  }
  return worst;
}
