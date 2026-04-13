/**
 * Shared warm container base for CLI and SDK agent runtimes.
 *
 * Both runtimes use the same container lifecycle:
 *   - Containers stay alive between messages (CMD sleep infinity)
 *   - Messages processed via `podman exec <command>`
 *   - Async PG backup after each message
 *   - Idle timeout → final backup → stop → remove
 *   - Cold restart → restore session from PG → create container
 *
 * Subclasses implement only:
 *   - buildCommand(task, container): the podman exec command
 *   - parseExecResult(stdout, stderr): normalized AgentResult
 *   - runtimeName: for log prefixes
 */

import { mkdir, writeFile, readdir, copyFile, access, constants } from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type {
  AgentRuntime,
  AgentTask,
  AgentResult,
  ContainerRuntime,
} from '../orchestrator/types.js';
import type { SessionManager } from './session-manager.js';
import type { WarmContainer } from './types.js';
import { generateMcpConfig } from './mcp-config.js';
import type { FlowHelmConfig } from '../config/schema.js';
import type { SkillStore } from '../skills/store.js';
import { getPlaceholderEnv } from '../proxy/placeholders.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WarmContainerRuntimeOptions {
  config: FlowHelmConfig;
  containerRuntime: ContainerRuntime;
  sessionManager: SessionManager;
  proxyUrl: string;
  /** Per-user skill store for container skill sync. */
  skillStore?: SkillStore;
  /** Path to built-in skills shipped with the container image. */
  builtinSkillsDir?: string;
  /** Path to the CA certificate for MITM TLS proxy. Mounted read-only into agent containers. */
  caCertPath?: string;
}

// ─── Base Class ─────────────────────────────────────────────────────────────

export abstract class WarmContainerRuntime implements AgentRuntime {
  protected readonly config: FlowHelmConfig;
  protected readonly containerRuntime: ContainerRuntime;
  protected readonly sessionManager: SessionManager;
  protected readonly proxyUrl: string;
  protected readonly skillStore: SkillStore | undefined;
  protected readonly builtinSkillsDir: string | undefined;
  protected readonly caCertPath: string | undefined;

  /** Active warm containers keyed by chat ID. */
  private readonly warmContainers = new Map<string, WarmContainer>();

  /** Idle timeout timers keyed by chat ID. */
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: WarmContainerRuntimeOptions) {
    this.config = options.config;
    this.containerRuntime = options.containerRuntime;
    this.sessionManager = options.sessionManager;
    this.proxyUrl = options.proxyUrl;
    this.skillStore = options.skillStore;
    this.builtinSkillsDir = options.builtinSkillsDir;
    this.caCertPath = options.caCertPath;
  }

  /** Log prefix for this runtime (e.g., "cli-runtime", "sdk-runtime"). */
  protected abstract get runtimeName(): string;

  /** Build the podman exec command for a task. */
  protected abstract buildCommand(task: AgentTask, container: WarmContainer): string[];

  /** Parse the exec result into a normalized AgentResult + session metadata. */
  protected abstract parseExecResult(
    stdout: string,
    stderr: string,
  ): { result: AgentResult; sessionId: string };

  /**
   * Execute an agent task in a warm container.
   *
   * 1. Get or create warm container for this chat
   * 2. Build runtime-specific command
   * 3. Execute via podman exec
   * 4. Parse response
   * 5. Async PG backup
   * 6. Reset idle timer
   */
  async execute(task: AgentTask): Promise<AgentResult> {
    const container = await this.getOrCreateContainer(task);
    const command = this.buildCommand(task, container);
    const hasResume = command.includes('--resume');
    console.log(
      `[${this.runtimeName}] Executing in ${container.containerId} (sessionId=${container.sessionId ?? 'none'}, resume=${String(hasResume)}): ${command.join(' ').slice(0, 300)}`,
    );
    // Use containerTimeout from config for the exec timeout. The default 30s is far
    // too short for Claude API calls which include network latency, retries on 529, and model inference.
    const execTimeout = this.config.agent.containerTimeout;
    let execResult = await this.containerRuntime.exec(container.containerId, command, {
      timeout: execTimeout,
    });
    console.log(
      `[${this.runtimeName}] Exec stdout (${execResult.stdout.length} chars): ${execResult.stdout.slice(0, 300)}`,
    );
    if (execResult.stderr)
      console.log(`[${this.runtimeName}] Exec stderr: ${execResult.stderr.slice(0, 300)}`);

    // If resume failed (stale session), retry without --resume
    if (!execResult.stdout.trim() && execResult.stderr.includes('No conversation found')) {
      console.log(`[${this.runtimeName}] Session resume failed, retrying without --resume`);
      container.sessionId = null;
      const retryCommand = this.buildCommand(task, container);
      execResult = await this.containerRuntime.exec(container.containerId, retryCommand, {
        timeout: execTimeout,
      });
      console.log(
        `[${this.runtimeName}] Retry stdout (${execResult.stdout.length} chars): ${execResult.stdout.slice(0, 300)}`,
      );
    }

    const { result, sessionId } = this.parseExecResult(execResult.stdout, execResult.stderr);

    // Update warm container state
    container.sessionId = sessionId || container.sessionId;
    container.lastActivityAt = Date.now();
    container.messageCount++;

    // Async PG backup (non-blocking)
    void this.asyncBackupSession(task.chatId, container, sessionId).catch((err) => {
      console.error(`[${this.runtimeName}] Session backup failed for ${task.chatId}:`, err);
    });

    // Reset idle timer
    this.resetIdleTimer(task.chatId);

    return result;
  }

  async isHealthy(): Promise<boolean> {
    try {
      return await this.containerRuntime.imageExists(this.config.agent.image);
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<void> {
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    const stopPromises = Array.from(this.warmContainers.entries()).map(
      async ([chatId, container]) => {
        try {
          await this.asyncBackupSession(chatId, container, container.sessionId ?? '');
          await this.containerRuntime.stop(container.containerId, 10);
          await this.containerRuntime.remove(container.containerId);
        } catch (err) {
          console.error(`[${this.runtimeName}] Error stopping container for ${chatId}:`, err);
        }
      },
    );
    await Promise.all(stopPromises);
    this.warmContainers.clear();
  }

  getWarmContainer(chatId: string): WarmContainer | null {
    return this.warmContainers.get(chatId) ?? null;
  }

  getWarmContainerCount(): number {
    return this.warmContainers.size;
  }

  // ── Container Lifecycle ─────────────────────────────────────────────────

  private async getOrCreateContainer(task: AgentTask): Promise<WarmContainer> {
    const existing = this.warmContainers.get(task.chatId);
    if (existing) {
      const healthy = await this.containerRuntime.isHealthy(existing.containerId);
      if (healthy) return existing;
      this.warmContainers.delete(task.chatId);
      this.clearIdleTimer(task.chatId);
    }
    return await this.createWarmContainer(task);
  }

  private async createWarmContainer(task: AgentTask): Promise<WarmContainer> {
    const dataDir = this.config.dataDir.replace('~', process.env['HOME'] ?? '~');
    const chatHash = hashChatId(task.chatId);
    const containerName = `flowhelm-agent-${task.username}-${chatHash}`;
    const sessionDir = path.join(dataDir, 'sessions', chatHash);
    const ipcDir = path.join(dataDir, 'ipc');
    const configDir = path.join(dataDir, 'agent-config', chatHash);
    const skillsSyncDir = path.join(dataDir, 'skills-sync', chatHash);
    const network = `flowhelm-network-${task.username}`;

    // MCP config: TCP on macOS (virtiofs UDS limitation), UDS on Linux.
    const isMacOS = process.platform === 'darwin';
    const sanitizedChatId = task.chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const mcpSocketName = `${sanitizedChatId}-memory.sock`;
    const mcpConfig =
      isMacOS && task.mcpPort
        ? generateMcpConfig({
            socketPath: '',
            tcpHost: 'host.containers.internal',
            tcpPort: task.mcpPort,
          })
        : generateMcpConfig({ socketPath: `/workspace/ipc/${mcpSocketName}` });

    const downloadsDir = path.join(dataDir, 'downloads');
    await mkdir(sessionDir, { recursive: true });
    await mkdir(ipcDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(skillsSyncDir, { recursive: true });
    await mkdir(downloadsDir, { recursive: true });

    await writeFile(
      path.join(configDir, 'mcp-config.json'),
      JSON.stringify(mcpConfig, null, 2),
      'utf-8',
    );

    // Sync skills into staging directory for container mount
    await this.syncSkills(skillsSyncDir);

    // Copy host Claude credentials into session dir for subscription auth
    await this.provisionCredentials(sessionDir);

    const restoredSession = await this.sessionManager.restoreToFilesystem(task.chatId, sessionDir);
    if (restoredSession) {
      console.log(
        `[${this.runtimeName}] Restored session for ${task.chatId}: sessionId=${restoredSession.sessionId}, files=${Object.keys(restoredSession.sessionFiles).length}`,
      );
    } else {
      console.log(`[${this.runtimeName}] No session to restore for ${task.chatId}`);
    }

    const networkExists = await this.containerRuntime.networkExists(network);
    if (!networkExists) {
      await this.containerRuntime.createNetwork(network);
    }

    const containerId = await this.containerRuntime.create({
      name: containerName,
      image: this.config.agent.image,
      memoryLimit: this.config.agent.memoryLimit,
      cpuLimit: this.config.agent.cpuLimit,
      pidsLimit: this.config.agent.pidsLimit,
      readOnly: false,
      mounts: [
        {
          source: sessionDir,
          target: '/home/flowhelm/.claude-host',
          readOnly: false,
          selinuxLabel: 'Z',
        },
        // IPC bind mount: only needed on Linux (UDS mode).
        // macOS uses TCP — virtiofs doesn't support UDS through bind mounts.
        ...(!isMacOS
          ? [
              {
                source: ipcDir,
                target: '/workspace/ipc',
                readOnly: false,
                selinuxLabel: 'Z' as const,
              },
            ]
          : []),
        { source: configDir, target: '/workspace/config', readOnly: true, selinuxLabel: 'Z' },
        {
          source: skillsSyncDir,
          target: '/workspace/.claude/skills',
          readOnly: true,
          selinuxLabel: 'Z',
        },
        // Mount downloads dir (shared with channel container) so agent can read images/media
        {
          source: path.join(dataDir, 'downloads'),
          target: '/workspace/downloads',
          readOnly: true,
          selinuxLabel: 'Z',
        },
        // Mount CA cert for MITM TLS proxy trust (agent trusts FlowHelm CA)
        ...(this.caCertPath
          ? [
              {
                source: this.caCertPath,
                target: '/usr/local/share/ca-certificates/flowhelm-proxy-ca.crt',
                readOnly: true as const,
                selinuxLabel: 'Z' as const,
              },
            ]
          : []),
      ],
      tmpfs: [{ target: '/tmp', size: '100m' }],
      env: {
        HTTPS_PROXY: this.proxyUrl,
        HTTP_PROXY: this.proxyUrl,
        NO_PROXY: 'localhost,127.0.0.1',
        HOME: '/home/flowhelm',
        // Trust FlowHelm CA for MITM TLS proxy (extends default CA bundle)
        ...(this.caCertPath
          ? { NODE_EXTRA_CA_CERTS: '/usr/local/share/ca-certificates/flowhelm-proxy-ca.crt' }
          : {}),
        // When MITM TLS is active, use placeholder credentials that the proxy replaces.
        // The credential method determines which placeholder (and thus which auth header
        // the agent sends): 'oauth' → Authorization: Bearer, 'api_key' → x-api-key.
        // Without MITM, fall back to forwarding real tokens (non-MITM setups).
        ...(this.caCertPath
          ? getPlaceholderEnv({ credentialMethod: this.config.agent.credentialMethod })
          : {
              ...(process.env['CLAUDE_CODE_OAUTH_TOKEN']
                ? { CLAUDE_CODE_OAUTH_TOKEN: process.env['CLAUDE_CODE_OAUTH_TOKEN'] }
                : {}),
              ...(process.env['ANTHROPIC_API_KEY']
                ? { ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'] }
                : {}),
            }),
        ...(task.env ?? {}),
      },
      network,
      userNamespace: 'keep-id:uid=1000,gid=1000',
      securityOpts: ['no-new-privileges'],
      workDir: '/workspace',
      command: ['sleep', 'infinity'],
    });

    await this.containerRuntime.start(containerId);

    // Session files are on a host bind mount at /home/flowhelm/.claude-host
    // (root-owned due to Podman rootless UID mapping). Copy them into the
    // container's own /home/flowhelm/.claude which is writable by flowhelm user.
    await this.containerRuntime.exec(containerId, [
      'sh',
      '-c',
      // Copy restored session files, restore .claude.json from backup key, fix ownership
      'mkdir -p /home/flowhelm/.claude' +
        ' && cp -a /home/flowhelm/.claude-host/. /home/flowhelm/.claude/ 2>/dev/null' +
        ' && if [ -f /home/flowhelm/.claude/__claude.json ]; then' +
        '   cp /home/flowhelm/.claude/__claude.json /home/flowhelm/.claude.json;' +
        '   rm /home/flowhelm/.claude/__claude.json;' +
        ' fi' +
        ' && chown -R flowhelm:flowhelm /home/flowhelm/.claude /home/flowhelm/.claude.json 2>/dev/null' +
        '; true',
    ]);

    // Update system CA store so curl/git trust the FlowHelm MITM proxy CA.
    // Runs as the container's default user (flowhelm). If permission denied,
    // NODE_EXTRA_CA_CERTS still covers Node.js (claude CLI, Agent SDK).
    if (this.caCertPath) {
      await this.containerRuntime
        .exec(containerId, ['sh', '-c', 'update-ca-certificates 2>/dev/null; true'])
        .catch(() => {});
    }

    const container: WarmContainer = {
      containerId,
      containerName,
      chatId: task.chatId,
      sessionId: restoredSession?.sessionId ?? null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      messageCount: 0,
      sessionDir,
      ipcDir,
    };

    this.warmContainers.set(task.chatId, container);
    this.resetIdleTimer(task.chatId);

    return container;
  }

  // ── Session Backup ──────────────────────────────────────────────────────

  private async asyncBackupSession(
    chatId: string,
    container: WarmContainer,
    sessionId: string,
  ): Promise<void> {
    if (!sessionId) return;
    try {
      // Read session files from INSIDE the container (not host filesystem)
      // because Podman rootless UID mapping makes host reads unreliable
      const sessionFiles = await this.readSessionFilesFromContainer(container.containerId);
      if (Object.keys(sessionFiles).length === 0) {
        console.log(`[${this.runtimeName}] No session files found in container for ${chatId}`);
        return;
      }
      await this.sessionManager.saveSession(chatId, sessionId, sessionFiles, {
        messageCount: container.messageCount,
      });
    } catch (err) {
      console.error(`[${this.runtimeName}] Session backup failed for ${chatId}:`, err);
    }
  }

  /**
   * Read session files from inside a running container via podman exec.
   * Returns a flat map of {relativePath: content} for all session-related files.
   */
  private async readSessionFilesFromContainer(
    containerId: string,
  ): Promise<Record<string, string>> {
    const claudeDir = '/home/flowhelm/.claude';
    const projectsDir = `${claudeDir}/projects`;

    // Back up everything under ~/.claude/projects/ — session transcripts (.jsonl),
    // Claude Code auto-memory (.md), subagent data, tool results, etc.
    const listResult = await this.containerRuntime.exec(containerId, [
      'find',
      projectsDir,
      '-type',
      'f',
    ]);

    const files = listResult.stdout.trim().split('\n').filter(Boolean);
    const sessionFiles: Record<string, string> = {};

    for (const absPath of files) {
      const relativePath = absPath.slice(claudeDir.length + 1); // Strip prefix + /
      if (!relativePath) continue;
      try {
        const catResult = await this.containerRuntime.exec(containerId, ['cat', absPath]);
        sessionFiles[relativePath] = catResult.stdout;
      } catch {
        // File may have been deleted between list and read — skip
      }
    }

    // Also capture ~/.claude.json (Claude Code global config, lives outside .claude/)
    try {
      const configResult = await this.containerRuntime.exec(containerId, [
        'cat',
        '/home/flowhelm/.claude.json',
      ]);
      if (configResult.stdout.trim()) {
        sessionFiles['__claude.json'] = configResult.stdout;
      }
    } catch {
      // No config file yet — skip
    }

    return sessionFiles;
  }

  // ── Idle Timer Management ───────────────────────────────────────────────

  private resetIdleTimer(chatId: string): void {
    this.clearIdleTimer(chatId);
    const timer = setTimeout(() => {
      void this.handleIdleTimeout(chatId);
    }, this.config.agent.idleTimeout);
    this.idleTimers.set(chatId, timer);
  }

  private clearIdleTimer(chatId: string): void {
    const timer = this.idleTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(chatId);
    }
  }

  private async handleIdleTimeout(chatId: string): Promise<void> {
    const container = this.warmContainers.get(chatId);
    if (!container) return;

    console.log(`[${this.runtimeName}] Idle timeout for ${chatId}, stopping container`);

    try {
      if (container.sessionId) {
        await this.asyncBackupSession(chatId, container, container.sessionId);
      }
      await this.containerRuntime.stop(container.containerId, 10);
      await this.containerRuntime.remove(container.containerId);
    } catch (err) {
      console.error(`[${this.runtimeName}] Error during idle cleanup for ${chatId}:`, err);
    } finally {
      this.warmContainers.delete(chatId);
      this.idleTimers.delete(chatId);
    }
  }

  // ── Credential Provisioning ─────────────────────────────────────────────

  /**
   * Copy the host's Claude OAuth credentials into the session directory
   * so the container can authenticate with the Claude API.
   *
   * For subscription auth (CLI runtime), Claude Code stores credentials at
   * ~/.claude/.credentials.json. The session directory is mounted as
   * /home/user/.claude inside the container, so placing the file there
   * makes it available to the containerized Claude Code CLI.
   *
   * For API key auth (SDK runtime), credentials are injected via the
   * credential proxy — this method is a no-op.
   */
  private async provisionCredentials(sessionDir: string): Promise<void> {
    const home = process.env['HOME'] ?? '';
    const hostCredentialsPath = path.join(home, '.claude', '.credentials.json');

    try {
      await access(hostCredentialsPath, constants.R_OK);
      await copyFile(hostCredentialsPath, path.join(sessionDir, '.credentials.json'));
    } catch {
      // No host credentials — API key auth via proxy, or user hasn't authenticated yet
    }
  }

  // ── Skill Sync ─────────────────────────────────────────────────────────

  /**
   * Sync installed + built-in skills into a staging directory.
   * This directory is bind-mounted into the container at
   * /workspace/.claude/skills/ (read-only).
   */
  private async syncSkills(stagingDir: string): Promise<void> {
    // Copy installed skills
    if (this.skillStore) {
      try {
        const installedSkills = await this.skillStore.getInstalledSkillDirs();
        for (const { name, dir } of installedSkills) {
          await copyDirRecursive(dir, path.join(stagingDir, name));
        }
      } catch (err) {
        console.error(`[${this.runtimeName}] Failed to sync installed skills:`, err);
      }
    }

    // Copy built-in skills
    if (this.builtinSkillsDir) {
      try {
        const entries = await readdir(this.builtinSkillsDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            await copyDirRecursive(
              path.join(this.builtinSkillsDir ?? '', entry.name),
              path.join(stagingDir, entry.name),
            );
          }
        }
      } catch (err) {
        console.error(`[${this.runtimeName}] Failed to sync built-in skills:`, err);
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Recursively copy a directory. */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

export function hashChatId(chatId: string): string {
  return crypto.createHash('sha256').update(chatId).digest('hex').slice(0, 12);
}
