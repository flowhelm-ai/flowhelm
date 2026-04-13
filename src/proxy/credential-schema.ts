/**
 * Credential rules schema and types.
 *
 * Defines the structure of credential rules stored in the encrypted
 * credential file. Each rule maps a host pattern to a header+value
 * pair that the proxy injects into matching outbound requests, plus
 * optional per-host rate limits.
 */

import { z } from 'zod';

// ─── Rate Limit Schema ─────────────────────────────────────────────────────

const rateLimitSchema = z.object({
  /** Maximum requests allowed within the window. */
  requests: z.number().int().min(1),
  /** Window size in seconds. */
  windowSeconds: z.number().int().min(1),
});

export type RateLimitRule = z.infer<typeof rateLimitSchema>;

// ─── Credential Rule Schema ────────────────────────────────────────────────

const credentialRuleSchema = z.object({
  /** Human-readable name for this credential (e.g., "Anthropic", "Google OAuth"). */
  name: z.string().min(1).max(128),

  /**
   * Host pattern to match against the request's target host.
   * Supports exact match ("api.anthropic.com") and wildcard prefix ("*.googleapis.com").
   * Wildcard only allowed as the first segment (e.g., "*.example.com").
   */
  hostPattern: z
    .string()
    .min(1)
    .regex(
      /^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/,
      'Invalid host pattern. Use exact host or *.domain.com wildcard.',
    ),

  /** HTTP header name to inject (e.g., "x-api-key", "Authorization"). */
  header: z.string().min(1).max(256),

  /** Header value — the real credential (e.g., "sk-ant-...", "Bearer ya29..."). */
  value: z.string().min(1),

  /**
   * Multiple credential values for round-robin distribution.
   * When present, overrides `value` — the proxy rotates through these keys
   * sequentially to distribute load across multiple API keys.
   */
  values: z.array(z.string().min(1)).min(1).optional(),

  /** Optional per-host rate limit. */
  rateLimit: rateLimitSchema.optional(),

  /** Optional request-level rules enforced by the MITM proxy. */
  rules: z
    .object({
      /** Allowed HTTP methods (e.g., ["GET", "POST"]). Empty = all allowed. */
      methods: z.array(z.string().min(1)).optional(),
      /** Allowed URL path prefixes (e.g., ["/v1/messages"]). Empty = all allowed. */
      pathPrefixes: z.array(z.string().min(1)).optional(),
      /** Maximum request body size in bytes. */
      maxBodySize: z.number().int().min(0).optional(),
    })
    .optional(),

  /** Unix timestamp (ms) when this credential expires. Used for expiration warnings. */
  expiresAt: z.number().int().optional(),

  /**
   * Billing/auth method this credential belongs to.
   * When the proxy has an active credentialMethod set, it filters to only
   * inject credentials matching that method. Credentials without this field
   * are always included (non-billing credentials like Gmail, Telegram).
   */
  credentialMethod: z.enum(['oauth', 'api_key']).optional(),
});

export type CredentialRule = z.infer<typeof credentialRuleSchema>;

// ─── Credential Rules File Schema ──────────────────────────────────────────

const credentialRulesSchema = z.object({
  credentials: z.array(credentialRuleSchema).default([]),
  /** Hostnames that should skip MITM even when a credential rule matches (cert pinning). */
  pinningBypass: z.array(z.string().min(1)).default([]),
  /**
   * General-purpose encrypted secrets (key-value).
   * For non-HTTP secrets that don't fit the proxy injection model:
   * DB passwords, internal tokens, etc.
   */
  secrets: z.record(z.string(), z.string()).default({}),
});

export type CredentialRules = z.infer<typeof credentialRulesSchema>;

// ─── Validation ────────────────────────────────────────────────────────────

/**
 * Parse and validate a credential rules object.
 * Throws a Zod error with clear field paths on invalid input.
 */
export function parseCredentialRules(data: unknown): CredentialRules {
  return credentialRulesSchema.parse(data);
}

/**
 * Match a hostname against a credential rule's host pattern.
 * Supports exact match and wildcard prefix (*.domain.com).
 */
export function matchesHostPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1); // ".domain.com"
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === pattern;
}

/**
 * Find the first credential rule matching a given hostname.
 * Returns undefined if no rule matches.
 */
export function findCredentialForHost(
  hostname: string,
  rules: CredentialRule[],
): CredentialRule | undefined {
  return rules.find((rule) => matchesHostPattern(hostname, rule.hostPattern));
}

/**
 * Find ALL credential rules matching a given hostname.
 * Returns empty array if no rules match.
 *
 * Used by the MITM handler when multiple credentials exist for the same
 * host (e.g., OAuth + API key for api.anthropic.com). The MITM handler
 * reads the agent's HTTP request headers and selects the credential
 * whose header matches what the agent actually sent.
 */
export function findAllCredentialsForHost(
  hostname: string,
  rules: CredentialRule[],
): CredentialRule[] {
  return rules.filter((rule) => matchesHostPattern(hostname, rule.hostPattern));
}

/**
 * Filter credentials by the active billing method.
 *
 * When `activeMethod` is set (e.g., 'oauth' or 'api_key'), credentials tagged
 * with a different `credentialMethod` are excluded. Credentials without a
 * `credentialMethod` tag are always included (non-billing creds like Gmail, Telegram).
 */
export function filterByCredentialMethod(
  credentials: CredentialRule[],
  activeMethod: 'oauth' | 'api_key' | undefined,
): CredentialRule[] {
  if (!activeMethod) return credentials;
  return credentials.filter((c) => !c.credentialMethod || c.credentialMethod === activeMethod);
}

/**
 * Select the best credential from a list based on the request's existing headers.
 *
 * Matching strategy:
 *   1. If the request already has a header that matches a credential's header name
 *      (e.g., request has `authorization` and credential injects `authorization`),
 *      use that credential — the agent chose this auth method.
 *   2. Fall back to the first credential if no header matches.
 *
 * This ensures the MITM replaces the placeholder header the agent actually sent,
 * rather than injecting a different auth method and stripping the original.
 *
 * Accepts Node.js IncomingHttpHeaders (string | string[] | undefined values)
 * as well as plain Record<string, string> for flexibility.
 */
export function selectCredentialByHeaders(
  credentials: CredentialRule[],
  requestHeaders: Record<string, string | string[] | undefined>,
): CredentialRule | undefined {
  if (credentials.length === 0) return undefined;
  if (credentials.length === 1) return credentials[0];

  // Look for a credential whose header is already present in the request
  for (const cred of credentials) {
    const headerLower = cred.header.toLowerCase();
    if (headerLower in requestHeaders) {
      return cred;
    }
  }

  // No header match — use first credential (preserves existing behavior)
  return credentials[0];
}

// Re-export schemas for external use (e.g., CLI validation)
export { credentialRuleSchema, credentialRulesSchema, rateLimitSchema };
