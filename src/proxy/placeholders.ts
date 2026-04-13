/**
 * Placeholder credentials for agent containers.
 *
 * When MITM TLS is active, agent containers receive these format-valid
 * but meaningless tokens. They pass CLI startup validation but carry
 * no real access. The MITM proxy replaces them with real credentials
 * before requests reach upstream APIs.
 *
 * This eliminates the need to forward real tokens into agent containers.
 */

/**
 * Placeholder OAuth token. Passes non-empty string checks.
 * The MITM proxy replaces this with the real Bearer token.
 */
export const PLACEHOLDER_OAUTH_TOKEN = 'flowhelm-proxy-placeholder-oauth-token';

/**
 * Placeholder API key. Matches the sk-ant-* prefix pattern that
 * Claude Code CLI validates at startup.
 * The MITM proxy replaces this with the real API key.
 */
export const PLACEHOLDER_API_KEY =
  'sk-ant-flowhelm-proxy-placeholder-000000000000000000000000000000000000000000000000';

/**
 * Placeholder OpenAI API key for the service container.
 * The MITM proxy replaces this with the real OpenAI API key
 * when intercepting requests to api.openai.com.
 */
export const PLACEHOLDER_OPENAI_API_KEY = 'sk-flowhelm-proxy-placeholder-openai';

/**
 * Get placeholder environment variables for agent containers.
 * Used when MITM TLS is active (caCertPath is set).
 *
 * Sets exactly ONE placeholder env var matching the configured credential method.
 * This ensures the agent's outbound auth header matches the proxy's credential rule:
 *
 *   credentialMethod='oauth'   → CLAUDE_CODE_OAUTH_TOKEN → CLI sends Authorization: Bearer
 *   credentialMethod='api_key' → ANTHROPIC_API_KEY       → CLI/SDK sends x-api-key
 *
 * When credentialMethod is not set, auto-detects from available credentials:
 *   - Only OAuth available → oauth
 *   - Only API key available → api_key
 *   - Both available → api_key (safe default; user should set credentialMethod explicitly)
 */
export function getPlaceholderEnv(options?: {
  /** Explicit credential method from config (agent.credentialMethod). */
  credentialMethod?: 'oauth' | 'api_key';
  hasOAuth?: boolean;
  hasApiKey?: boolean;
}): Record<string, string> {
  const env: Record<string, string> = {};
  const hasOAuth = options?.hasOAuth ?? !!process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  const hasApiKey = options?.hasApiKey ?? !!process.env['ANTHROPIC_API_KEY'];

  // Resolve effective method: explicit config > auto-detect
  let method = options?.credentialMethod;
  if (!method) {
    if (hasOAuth && !hasApiKey) method = 'oauth';
    else if (hasApiKey) method = 'api_key';
    else method = 'api_key'; // fallback
  }

  // Set exactly ONE placeholder — never both
  if (method === 'oauth') {
    env['CLAUDE_CODE_OAUTH_TOKEN'] = PLACEHOLDER_OAUTH_TOKEN;
  } else {
    env['ANTHROPIC_API_KEY'] = PLACEHOLDER_API_KEY;
  }

  return env;
}
