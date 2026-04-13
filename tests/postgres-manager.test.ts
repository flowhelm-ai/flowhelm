import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PostgresContainerManager, dbContainerName } from '../src/container/postgres-manager.js';
import type {
  ContainerRuntime,
  ContainerConfig,
  ContainerInfo,
  ExecResult,
} from '../src/orchestrator/types.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn().mockResolvedValue(undefined) };
});

// ─── Mock Runtime ─────────────────────────────────────────────────────────

function createMockRuntime(overrides?: Partial<ContainerRuntime>): ContainerRuntime {
  return {
    create: vi.fn<(config: ContainerConfig) => Promise<string>>().mockResolvedValue('container-id'),
    start: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    stop: vi.fn<(id: string, timeout?: number) => Promise<void>>().mockResolvedValue(undefined),
    remove: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    exec: vi.fn<(id: string, command: string[]) => Promise<ExecResult>>().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }),
    logs: vi.fn<(id: string, tail?: number) => Promise<string>>().mockResolvedValue(''),
    isHealthy: vi.fn<(id: string) => Promise<boolean>>().mockResolvedValue(true),
    exists: vi.fn<(nameOrId: string) => Promise<boolean>>().mockResolvedValue(false),
    list: vi.fn<(filter?: unknown) => Promise<ContainerInfo[]>>().mockResolvedValue([]),
    createNetwork: vi.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined),
    removeNetwork: vi.fn<(name: string) => Promise<void>>().mockResolvedValue(undefined),
    networkExists: vi.fn<(name: string) => Promise<boolean>>().mockResolvedValue(true),
    imageExists: vi.fn<(image: string) => Promise<boolean>>().mockResolvedValue(true),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('dbContainerName', () => {
  it('follows naming convention', () => {
    expect(dbContainerName('stan')).toBe('flowhelm-db-stan');
    expect(dbContainerName('alex')).toBe('flowhelm-db-alex');
  });
});

describe('PostgresContainerManager', () => {
  let runtime: ContainerRuntime;
  let manager: PostgresContainerManager;

  beforeEach(() => {
    runtime = createMockRuntime();
    manager = new PostgresContainerManager({
      runtime,
      username: 'stan',
      dataDir: '/home/flowhelm-stan/.flowhelm/data/pg',
      dbPassword: 'test-password-123',
    });
  });

  // ─── Container Config ───────────────────────────────────────────────

  describe('buildContainerConfig', () => {
    it('produces correct container name', () => {
      const config = manager.buildContainerConfig();
      expect(config.name).toBe('flowhelm-db-stan');
    });

    it('uses default image', () => {
      const config = manager.buildContainerConfig();
      expect(config.image).toBe('ghcr.io/flowhelm-ai/flowhelm-db:0.1.0');
    });

    it('uses custom image when provided', () => {
      const m = new PostgresContainerManager({
        runtime,
        username: 'stan',
        dataDir: '/data',
        image: 'pgvector/pgvector:0.8-pg18',
      });
      expect(m.buildContainerConfig().image).toBe('pgvector/pgvector:0.8-pg18');
    });

    it('sets resource limits', () => {
      const config = manager.buildContainerConfig();
      expect(config.memoryLimit).toBe('256m');
      expect(config.cpuLimit).toBe('0.5');
      expect(config.pidsLimit).toBe(128);
    });

    it('uses custom resource limits', () => {
      const m = new PostgresContainerManager({
        runtime,
        username: 'stan',
        dataDir: '/data',
        memoryLimit: '512m',
        cpuLimit: '1.0',
      });
      const config = m.buildContainerConfig();
      expect(config.memoryLimit).toBe('512m');
      expect(config.cpuLimit).toBe('1.0');
    });

    it('uses writable filesystem (PG needs write access)', () => {
      const config = manager.buildContainerConfig();
      expect(config.readOnly).toBe(false);
    });

    it('mounts data directory with SELinux label', () => {
      const config = manager.buildContainerConfig();
      expect(config.mounts).toHaveLength(1);
      expect(config.mounts[0]).toEqual({
        source: '/home/flowhelm-stan/.flowhelm/data/pg',
        target: '/var/lib/postgresql/data',
        readOnly: false,
        selinuxLabel: 'Z',
      });
    });

    it('configures tmpfs mounts', () => {
      const config = manager.buildContainerConfig();
      expect(config.tmpfs).toEqual([
        { target: '/tmp', size: '64m' },
        { target: '/run/postgresql', size: '8m' },
      ]);
    });

    it('sets PostgreSQL environment variables', () => {
      const config = manager.buildContainerConfig();
      expect(config.env).toEqual({
        POSTGRES_USER: 'flowhelm',
        POSTGRES_DB: 'flowhelm',
        POSTGRES_PASSWORD: 'test-password-123',
        PGDATA: '/var/lib/postgresql/data',
      });
    });

    it('uses the user Podman network', () => {
      const config = manager.buildContainerConfig();
      expect(config.network).toBe('flowhelm-network-stan');
    });

    it('sets security options', () => {
      const config = manager.buildContainerConfig();
      expect(config.securityOpts).toContain('no-new-privileges');
    });

    it('does not set userns (rootless Podman provides UID isolation)', () => {
      const config = manager.buildContainerConfig();
      expect(config.userNamespace).toBeUndefined();
    });
  });

  // ─── Connection Info ────────────────────────────────────────────────

  describe('getConnectionInfo', () => {
    it('returns correct connection details', () => {
      const info = manager.getConnectionInfo();
      expect(info).toEqual({
        host: 'flowhelm-db-stan',
        port: 5432,
        database: 'flowhelm',
        username: 'flowhelm',
        password: 'test-password-123',
      });
    });

    it('uses custom database name', () => {
      const m = new PostgresContainerManager({
        runtime,
        username: 'stan',
        dataDir: '/data',
        dbName: 'custom_db',
        dbUser: 'custom_user',
        dbPassword: 'pw',
      });
      const info = m.getConnectionInfo();
      expect(info.database).toBe('custom_db');
      expect(info.username).toBe('custom_user');
    });
  });

  describe('getConnectionUrl', () => {
    it('builds a valid postgres URL', () => {
      const url = manager.getConnectionUrl();
      expect(url).toBe('postgres://flowhelm:test-password-123@flowhelm-db-stan:5432/flowhelm');
    });

    it('URL-encodes special characters in password', () => {
      const m = new PostgresContainerManager({
        runtime,
        username: 'stan',
        dataDir: '/data',
        dbPassword: 'p@ss/word#123',
      });
      const url = m.getConnectionUrl();
      expect(url).toContain(encodeURIComponent('p@ss/word#123'));
    });
  });

  // ─── Lifecycle ──────────────────────────────────────────────────────

  describe('start', () => {
    it('creates and starts container when it does not exist', async () => {
      vi.mocked(runtime.exists).mockResolvedValue(false);

      await manager.start();

      expect(runtime.create).toHaveBeenCalledOnce();
      expect(runtime.start).toHaveBeenCalledWith('flowhelm-db-stan');
    });

    it('does nothing when container exists and is healthy', async () => {
      vi.mocked(runtime.exists).mockResolvedValue(true);
      vi.mocked(runtime.isHealthy).mockResolvedValue(true);

      await manager.start();

      expect(runtime.create).not.toHaveBeenCalled();
      expect(runtime.start).not.toHaveBeenCalled();
    });

    it('starts existing container when it is not healthy', async () => {
      vi.mocked(runtime.exists).mockResolvedValue(true);
      vi.mocked(runtime.isHealthy).mockResolvedValue(false);

      await manager.start();

      expect(runtime.create).not.toHaveBeenCalled();
      expect(runtime.start).toHaveBeenCalledWith('flowhelm-db-stan');
    });
  });

  describe('stop', () => {
    it('stops a running container with 30s timeout', async () => {
      vi.mocked(runtime.exists).mockResolvedValue(true);
      vi.mocked(runtime.isHealthy).mockResolvedValue(true);

      await manager.stop();

      expect(runtime.stop).toHaveBeenCalledWith('flowhelm-db-stan', 30);
    });

    it('does nothing when container does not exist', async () => {
      vi.mocked(runtime.exists).mockResolvedValue(false);

      await manager.stop();

      expect(runtime.stop).not.toHaveBeenCalled();
    });

    it('does nothing when container exists but is already stopped', async () => {
      vi.mocked(runtime.exists).mockResolvedValue(true);
      vi.mocked(runtime.isHealthy).mockResolvedValue(false);

      await manager.stop();

      expect(runtime.stop).not.toHaveBeenCalled();
    });
  });

  // ─── Health Check ───────────────────────────────────────────────────

  describe('isHealthy', () => {
    it('returns false when container does not exist', async () => {
      vi.mocked(runtime.exists).mockResolvedValue(false);
      expect(await manager.isHealthy()).toBe(false);
    });

    it('returns true when pg_isready succeeds', async () => {
      vi.mocked(runtime.exists).mockResolvedValue(true);
      vi.mocked(runtime.exec).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });

      expect(await manager.isHealthy()).toBe(true);
      expect(runtime.exec).toHaveBeenCalledWith('flowhelm-db-stan', [
        'pg_isready',
        '-U',
        'flowhelm',
        '-d',
        'flowhelm',
      ]);
    });

    it('returns false when pg_isready fails', async () => {
      vi.mocked(runtime.exists).mockResolvedValue(true);
      vi.mocked(runtime.exec).mockResolvedValue({ stdout: '', stderr: 'error', exitCode: 2 });

      expect(await manager.isHealthy()).toBe(false);
    });

    it('returns false when exec throws', async () => {
      vi.mocked(runtime.exists).mockResolvedValue(true);
      vi.mocked(runtime.exec).mockRejectedValue(new Error('exec failed'));

      expect(await manager.isHealthy()).toBe(false);
    });
  });

  // ─── Password Generation ───────────────────────────────────────────

  describe('password generation', () => {
    it('auto-generates password when not provided', () => {
      const m = new PostgresContainerManager({
        runtime,
        username: 'stan',
        dataDir: '/data',
      });
      const pw = m.getPassword();
      expect(pw).toBeDefined();
      expect(pw.length).toBeGreaterThan(16);
    });

    it('uses provided password', () => {
      expect(manager.getPassword()).toBe('test-password-123');
    });
  });

  // ─── Naming ─────────────────────────────────────────────────────────

  describe('naming', () => {
    it('getName returns the container name', () => {
      expect(manager.getName()).toBe('flowhelm-db-stan');
    });
  });
});
