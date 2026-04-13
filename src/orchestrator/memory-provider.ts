/**
 * MemoryProvider — containerized LLM interface for orchestrator-side memory jobs.
 *
 * Spawns `claude -p` in a dedicated short-lived Podman container
 * (`flowhelm-memory-{username}`). Supports both OAuth subscription and API keys
 * via the credential proxy — the orchestrator never holds real credentials.
 *
 * Both consolidation and reflection jobs dispatch through this provider.
 * Containers are short-lived (10s close delay). See ADR-031, ADR-053.
 */

import type {
  MemorySummarizationProvider,
  SummarizationOptions,
  ContainerRuntime,
  MountConfig,
} from './types.js';
import { getPlaceholderEnv } from '../proxy/placeholders.js';

// ─── Memory Provider ─────────────────────────────────────────────────────

export interface MemoryProviderOptions {
  containerRuntime: ContainerRuntime;
  username: string;
  agentImage: string;
  network: string;
  proxyUrl?: string;
  /** Path to the proxy CA cert on the host (for MITM TLS trust). */
  caCertPath?: string;
  /** Credential method for placeholder env selection. */
  credentialMethod?: 'oauth' | 'api_key';
}

export class MemoryProvider implements MemorySummarizationProvider {
  private readonly runtime: ContainerRuntime;
  private readonly username: string;
  private readonly agentImage: string;
  private readonly network: string;
  private readonly proxyUrl?: string;
  private readonly caCertPath?: string;
  private readonly credentialMethod?: 'oauth' | 'api_key';

  constructor(options: MemoryProviderOptions) {
    this.runtime = options.containerRuntime;
    this.username = options.username;
    this.agentImage = options.agentImage;
    this.network = options.network;
    this.proxyUrl = options.proxyUrl;
    this.caCertPath = options.caCertPath;
    this.credentialMethod = options.credentialMethod;
  }

  async summarize(content: string, options: SummarizationOptions): Promise<string> {
    const containerName = `flowhelm-memory-${this.username}`;
    const fullPrompt = options.systemPrompt ? `${options.systemPrompt}\n\n${content}` : content;

    const env: Record<string, string> = {};
    if (this.proxyUrl) {
      env.HTTPS_PROXY = this.proxyUrl;
      env.HTTP_PROXY = this.proxyUrl;
    }

    // Credential injection: same pattern as WarmContainerRuntime.
    // With MITM proxy: mount CA cert + set placeholder credentials.
    // Without MITM: forward real tokens from the orchestrator's env.
    const mounts: MountConfig[] = [];
    if (this.caCertPath) {
      mounts.push({
        source: this.caCertPath,
        target: '/usr/local/share/ca-certificates/flowhelm-proxy-ca.crt',
        readOnly: true,
      });
      env.NODE_EXTRA_CA_CERTS = '/usr/local/share/ca-certificates/flowhelm-proxy-ca.crt';
      Object.assign(env, getPlaceholderEnv({ credentialMethod: this.credentialMethod }));
    } else {
      // No MITM — forward real tokens directly
      const oauthToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
      const apiKey = process.env['ANTHROPIC_API_KEY'];
      if (oauthToken) env['CLAUDE_CODE_OAUTH_TOKEN'] = oauthToken;
      if (apiKey) env['ANTHROPIC_API_KEY'] = apiKey;
    }

    try {
      // Remove any stale container from a previous run
      if (await this.runtime.exists(containerName)) {
        await this.runtime.stop(containerName, 5).catch(() => {});
        await this.runtime.remove(containerName).catch(() => {});
      }

      const containerId = await this.runtime.create({
        name: containerName,
        image: this.agentImage,
        memoryLimit: '256m',
        cpuLimit: '0.5',
        pidsLimit: 128,
        readOnly: false,
        mounts,
        tmpfs: [{ target: '/tmp', size: '64m' }],
        env,
        network: this.network,
        securityOpts: ['no-new-privileges'],
        command: [
          'claude',
          '-p',
          fullPrompt,
          '--model',
          options.model,
          '--max-turns',
          '1',
          '--output-format',
          'text',
        ],
      });

      await this.runtime.start(containerId);

      // Wait for completion by polling logs (container runs to completion)
      const output = await this.waitForCompletion(containerName, 120_000);
      return output.trim();
    } finally {
      // Clean up with 10s grace period
      await this.cleanup(containerName);
    }
  }

  private async waitForCompletion(containerName: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const isRunning = await this.runtime.isHealthy(containerName);
      if (!isRunning) {
        return await this.runtime.logs(containerName);
      }
      await sleep(1000);
    }
    throw new Error(`Memory container ${containerName} timed out after ${timeoutMs}ms`);
  }

  private async cleanup(containerName: string): Promise<void> {
    try {
      if (await this.runtime.exists(containerName)) {
        await this.runtime.stop(containerName, 10).catch(() => {});
        await this.runtime.remove(containerName).catch(() => {});
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────

export interface CreateMemoryProviderOptions {
  containerRuntime: ContainerRuntime;
  username: string;
  agentImage: string;
  network: string;
  proxyUrl?: string;
  caCertPath?: string;
  credentialMethod?: 'oauth' | 'api_key';
}

export function createMemoryProvider(
  options: CreateMemoryProviderOptions,
): MemorySummarizationProvider {
  return new MemoryProvider(options);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
