/**
 * Authentication flow for `flowhelm setup`.
 *
 * Provides three authentication methods:
 * 1. API key — for SdkRuntime (pay-per-use)
 * 2. Subscription via Token Bridge — scan QR, E2E encrypted transfer
 * 3. Subscription via SSH Tunnel — advanced, manual port forwarding
 *
 * This module contains the logic for each flow. The CLI UI layer
 * (prompts, progress display) calls these functions.
 */

import type { Interface as ReadlineInterface } from 'node:readline';
import { createInterface } from 'node:readline';

import { validateApiKey, writeApiKey, defaultApiKeyPath } from './api-key.js';
import {
  generateKeyPair,
  createSession,
  pollAndDecrypt,
  deleteSession,
  type BridgeKeyPair,
} from './bridge-client.js';
import { storeAccessToken } from './credential-store.js';

export type AuthMethod = 'api_key' | 'subscription_bridge' | 'subscription_tunnel';

export interface AuthResult {
  method: AuthMethod;
  /** True if authentication succeeded. */
  success: boolean;
  /** Error message if failed. */
  error?: string;
}

export interface SetupFlowOptions {
  /** Bridge server URL. Default: 'https://flowhelm.to'. */
  bridgeUrl?: string;
  /** Data directory for storing secrets. */
  dataDir?: string;
  /** Custom readline interface (for testing). */
  rl?: ReadlineInterface;
  /** Custom output stream (for testing). */
  output?: NodeJS.WritableStream;
}

const DEFAULT_BRIDGE_URL = 'https://flowhelm.to';

/** Prompt the user for input and return their response. */
function prompt(rl: ReadlineInterface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

/**
 * Run the API key authentication flow.
 * Prompts for an API key, validates format, stores it.
 */
export async function runApiKeyFlow(
  options: SetupFlowOptions & { key?: string } = {},
): Promise<AuthResult> {
  const output = options.output ?? process.stdout;
  const rl = options.rl ?? createInterface({ input: process.stdin, output });

  try {
    output.write('\n=== API Key Authentication ===\n\n');
    output.write('Get an API key at https://console.anthropic.com/settings/keys\n\n');

    const key = options.key ?? (await prompt(rl, 'API key: '));
    if (!key) {
      return { method: 'api_key', success: false, error: 'No key provided' };
    }

    if (!validateApiKey(key)) {
      return {
        method: 'api_key',
        success: false,
        error: 'Invalid API key format. Expected sk-ant-api*-... or sk-ant-...',
      };
    }

    await writeApiKey(key, options.dataDir ? defaultApiKeyPath(options.dataDir) : undefined);

    output.write('\n✓ API key stored securely.\n');
    output.write('FlowHelm will use the SDK runtime with your API key.\n\n');

    return { method: 'api_key', success: true };
  } finally {
    if (!options.rl) rl.close();
  }
}

export interface BridgeFlowCallbacks {
  /** Called after session is created. Display QR code and URL. */
  onSessionCreated?: (token: string, bridgeUrl: string) => void;
  /** Called on each poll attempt. */
  onPoll?: (attempt: number) => void;
  /** Called after successful authentication. */
  onSuccess?: (subscriptionType: string) => void;
}

/**
 * Run the Token Bridge authentication flow.
 * 1. Generate X25519 keypair
 * 2. Create session on bridge
 * 3. Display QR code / short URL
 * 4. Poll for encrypted credentials
 * 5. Decrypt and store
 */
export async function runBridgeFlow(
  options: SetupFlowOptions = {},
  callbacks: BridgeFlowCallbacks = {},
): Promise<AuthResult> {
  const bridgeUrl = (options.bridgeUrl ?? DEFAULT_BRIDGE_URL).replace(/\/$/, '');
  const output = options.output ?? process.stdout;

  try {
    output.write('\n=== Token Bridge Authentication ===\n\n');
    output.write('Creating secure session...\n');

    // 1. Generate keypair
    const keyPair: BridgeKeyPair = await generateKeyPair();

    // 2. Create session on bridge
    const session = await createSession(bridgeUrl, keyPair.publicKeyBase64);

    // 3. Notify caller to display QR code
    callbacks.onSessionCreated?.(session.token, bridgeUrl);

    if (!callbacks.onSessionCreated) {
      // Default display
      output.write(`\nOpen this link on your phone or laptop:\n`);
      output.write(`  ${bridgeUrl}/${session.token}\n\n`);
      output.write('Waiting for authentication... (polling every 2s)\n');
    }

    // 4. Poll and decrypt
    const plainToken = await pollAndDecrypt(bridgeUrl, session.token, keyPair.privateKey, {
      onPoll: callbacks.onPoll,
    });

    // 5. Store credentials
    const creds = await storeAccessToken(plainToken, {
      subscriptionType: 'pro',
      path: options.dataDir ? undefined : undefined,
    });

    // 6. Cleanup session
    await deleteSession(bridgeUrl, session.token);

    callbacks.onSuccess?.(creds.claudeAiOauth.subscriptionType ?? 'pro');

    if (!callbacks.onSuccess) {
      output.write('\n✓ Token received and decrypted.\n');
      output.write('✓ Credentials stored.\n');
      output.write(
        '\nNote: Anthropic may restrict subscription usage with third-party\n' +
          'tools. If this stops working, switch to API key authentication\n' +
          'with: flowhelm setup auth --api-key\n\n',
      );
    }

    return { method: 'subscription_bridge', success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.write(`\nAuthentication failed: ${message}\n`);

    // Offer fallback
    output.write(
      '\nFallback: Run "claude setup-token" on a machine with Claude Code,\n' +
        'then paste the token here.\n',
    );

    return {
      method: 'subscription_bridge',
      success: false,
      error: message,
    };
  }
}

/**
 * Run the SSH tunnel authentication flow.
 * Displays instructions for the user to set up SSH port forwarding
 * and run `claude login` through the tunnel.
 */
export async function runTunnelFlow(options: SetupFlowOptions = {}): Promise<AuthResult> {
  const output = options.output ?? process.stdout;
  const rl = options.rl ?? createInterface({ input: process.stdin, output });

  try {
    output.write('\n=== SSH Tunnel Authentication ===\n\n');
    output.write('On your local machine (with a browser), run:\n\n');
    output.write('  ssh -L 9876:localhost:9876 your-vm-host\n\n');
    output.write('Then on the VM, run:\n\n');
    output.write('  claude login --port 9876\n\n');
    output.write('This opens the OAuth flow through the SSH tunnel.\n');
    output.write('Complete the authentication in your local browser.\n\n');

    const done = await prompt(
      rl,
      'Press Enter when authentication is complete (or "q" to cancel): ',
    );

    if (done.toLowerCase() === 'q') {
      return {
        method: 'subscription_tunnel',
        success: false,
        error: 'Cancelled by user',
      };
    }

    output.write('\n✓ If claude login succeeded, credentials are stored.\n');
    output.write('FlowHelm will use the CLI runtime with your subscription.\n\n');

    return { method: 'subscription_tunnel', success: true };
  } finally {
    if (!options.rl) rl.close();
  }
}

/**
 * Run the main auth setup flow — presents the three-option menu.
 */
export async function runAuthSetup(options: SetupFlowOptions = {}): Promise<AuthResult> {
  const output = options.output ?? process.stdout;
  const rl = options.rl ?? createInterface({ input: process.stdin, output });

  try {
    output.write('\n=== FlowHelm Authentication ===\n\n');
    output.write('How would you like to authenticate with Claude?\n\n');
    output.write('  1. API key (recommended for always-on production)\n');
    output.write('     Pay-per-use. Get a key at console.anthropic.com\n\n');
    output.write('  2. Claude subscription (Pro/Max plan)\n');
    output.write('     Use your existing subscription. At your own risk —\n');
    output.write('     Anthropic may restrict third-party subscription usage.\n\n');

    const choice = await prompt(rl, '> ');

    if (choice === '1') {
      return runApiKeyFlow({ ...options, rl });
    }

    if (choice === '2') {
      output.write('\nChoose authentication method:\n\n');
      output.write('  a. Token Bridge (recommended)\n');
      output.write('     Scan a QR code on your phone, authenticate there.\n\n');
      output.write('  b. SSH Tunnel (advanced)\n');
      output.write('     Authenticate via SSH port forwarding.\n\n');

      const subChoice = await prompt(rl, '> ');

      if (subChoice.toLowerCase() === 'a') {
        return runBridgeFlow({ ...options, rl });
      }

      if (subChoice.toLowerCase() === 'b') {
        return runTunnelFlow({ ...options, rl });
      }

      return {
        method: 'subscription_bridge',
        success: false,
        error: 'Invalid choice',
      };
    }

    return {
      method: 'api_key',
      success: false,
      error: 'Invalid choice',
    };
  } finally {
    if (!options.rl) rl.close();
  }
}
