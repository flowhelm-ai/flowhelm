import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PortRegistry,
  type PortAllocation,
  type PortRegistryData,
} from '../src/admin/port-registry.js';
import {
  generateServiceUnit,
  installService,
  removeService,
  readService,
} from '../src/admin/service-generator.js';
import { parseSize, formatBytes } from '../src/admin/resource-limits.js';
import { UserManager } from '../src/admin/user-manager.js';
import {
  adminInitCommand,
  adminStatusCommand,
  dispatchAdminCommand,
  extractFlag,
  type AdminContext,
} from '../src/admin/cli.js';

// ═══════════════════════════════════════════════════════════════════════════
// Port Registry
// ═══════════════════════════════════════════════════════════════════════════

describe('PortRegistry', () => {
  let tmpDir: string;
  let registry: PortRegistry;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'flowhelm-test-'));
    registry = new PortRegistry({
      registryPath: join(tmpDir, 'ports.json'),
      basePort: 10000,
      portsPerUser: 10,
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('init creates registry file', async () => {
    await registry.init();
    const data = await registry.read();
    expect(data.basePort).toBe(10000);
    expect(data.portsPerUser).toBe(10);
    expect(data.allocations).toHaveLength(0);
  });

  it('init is idempotent', async () => {
    await registry.init();
    // Allocate a port
    await registry.allocate('stan');
    // Re-init should NOT overwrite
    await registry.init();
    const data = await registry.read();
    expect(data.allocations).toHaveLength(1);
  });

  it('allocate assigns sequential port blocks', async () => {
    await registry.init();

    const a1 = await registry.allocate('stan');
    expect(a1.basePort).toBe(10000);
    expect(a1.ports.proxy).toBe(10000);
    expect(a1.ports.channel).toBe(10001);
    expect(a1.ports.service).toBe(10002);
    expect(a1.ports.database).toBe(10003);
    expect(a1.username).toBe('stan');

    const a2 = await registry.allocate('alex');
    expect(a2.basePort).toBe(10010);
    expect(a2.ports.proxy).toBe(10010);
  });

  it('allocate rejects duplicate username', async () => {
    await registry.init();
    await registry.allocate('stan');
    await expect(registry.allocate('stan')).rejects.toThrow('already exists');
  });

  it('free removes allocation', async () => {
    await registry.init();
    await registry.allocate('stan');
    await registry.allocate('alex');

    const removed = await registry.free('stan');
    expect(removed.username).toBe('stan');

    const data = await registry.read();
    expect(data.allocations).toHaveLength(1);
    expect(data.allocations[0]!.username).toBe('alex');
  });

  it('free throws for unknown user', async () => {
    await registry.init();
    await expect(registry.free('ghost')).rejects.toThrow('No port allocation');
  });

  it('get returns allocation or undefined', async () => {
    await registry.init();
    await registry.allocate('stan');

    const found = await registry.get('stan');
    expect(found?.username).toBe('stan');

    const missing = await registry.get('ghost');
    expect(missing).toBeUndefined();
  });

  it('list returns all allocations', async () => {
    await registry.init();
    await registry.allocate('stan');
    await registry.allocate('alex');

    const all = await registry.list();
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.username).sort()).toEqual(['alex', 'stan']);
  });

  it('allocate reuses freed slots', async () => {
    await registry.init();
    await registry.allocate('stan'); // 10000
    await registry.allocate('alex'); // 10010
    await registry.free('stan');

    // New allocation should fill the gap at 10000
    const a3 = await registry.allocate('bob');
    expect(a3.basePort).toBe(10000);
  });

  it('detectConflicts returns empty for clean registry', async () => {
    await registry.init();
    await registry.allocate('stan');
    await registry.allocate('alex');

    const conflicts = await registry.detectConflicts();
    expect(conflicts).toHaveLength(0);
  });

  it('detectConflicts finds overlapping blocks', async () => {
    await registry.init();
    // Manually write overlapping allocations
    const data = await registry.read();
    data.allocations.push(
      {
        username: 'stan',
        basePort: 10000,
        ports: { proxy: 10000, channel: 10001, service: 10002, database: 10003 },
        allocatedAt: new Date().toISOString(),
      },
      {
        username: 'alex',
        basePort: 10005,
        ports: { proxy: 10005, channel: 10006, service: 10007, database: 10008 },
        allocatedAt: new Date().toISOString(),
      },
    );
    await writeFile(join(tmpDir, 'ports.json'), JSON.stringify(data, null, 2));

    const conflicts = await registry.detectConflicts();
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]).toContain('overlap');
  });

  it('allocate throws on port exhaustion', async () => {
    const smallRegistry = new PortRegistry({
      registryPath: join(tmpDir, 'small.json'),
      basePort: 65530,
      portsPerUser: 10,
    });
    await smallRegistry.init();

    await expect(smallRegistry.allocate('stan')).rejects.toThrow('Port exhaustion');
  });

  it('allocation includes timestamp', async () => {
    await registry.init();
    const before = new Date().toISOString();
    const alloc = await registry.allocate('stan');
    const after = new Date().toISOString();

    expect(alloc.allocatedAt >= before).toBe(true);
    expect(alloc.allocatedAt <= after).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Service Generator
// ═══════════════════════════════════════════════════════════════════════════

describe('ServiceGenerator', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'flowhelm-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('generateServiceUnit produces valid unit file', () => {
    const unit = generateServiceUnit({
      username: 'flowhelm-stan',
      homeDir: '/home/flowhelm-stan',
    });

    expect(unit.serviceName).toBe('flowhelm.service');
    expect(unit.unitPath).toBe('/home/flowhelm-stan/.config/systemd/user/flowhelm.service');
    expect(unit.content).toContain('[Unit]');
    expect(unit.content).toContain('[Service]');
    expect(unit.content).toContain('[Install]');
    expect(unit.content).toContain('ExecStart=/usr/bin/flowhelm start');
    expect(unit.content).toContain('Restart=always');
    expect(unit.content).toContain('WantedBy=default.target');
  });

  it('generateServiceUnit uses custom binary path', () => {
    const unit = generateServiceUnit({
      username: 'flowhelm-stan',
      homeDir: '/home/flowhelm-stan',
      binaryPath: '/opt/flowhelm/bin/flowhelm',
    });

    expect(unit.content).toContain('ExecStart=/opt/flowhelm/bin/flowhelm start');
  });

  it('generateServiceUnit includes agent runtime env', () => {
    const unit = generateServiceUnit({
      username: 'flowhelm-stan',
      homeDir: '/home/flowhelm-stan',
      agentRuntime: 'sdk',
    });

    expect(unit.content).toContain('FLOWHELM_AGENT_RUNTIME=sdk');
  });

  it('generateServiceUnit includes config dir env', () => {
    const unit = generateServiceUnit({
      username: 'flowhelm-stan',
      homeDir: '/home/flowhelm-stan',
    });

    expect(unit.content).toContain('FLOWHELM_CONFIG_DIR=/home/flowhelm-stan/.flowhelm');
  });

  it('generateServiceUnit sets NODE_ENV=production', () => {
    const unit = generateServiceUnit({
      username: 'flowhelm-stan',
      homeDir: '/home/flowhelm-stan',
    });

    expect(unit.content).toContain('NODE_ENV=production');
  });

  it('installService writes unit file to disk', async () => {
    const unit = await installService({
      username: 'flowhelm-stan',
      homeDir: tmpDir,
    });

    const expectedPath = join(tmpDir, '.config', 'systemd', 'user', 'flowhelm.service');
    expect(unit.unitPath).toBe(expectedPath);

    const content = await readFile(expectedPath, 'utf-8');
    expect(content).toContain('[Service]');
  });

  it('installService creates parent directories', async () => {
    await installService({
      username: 'flowhelm-stan',
      homeDir: tmpDir,
    });

    // Verify directory was created
    await access(join(tmpDir, '.config', 'systemd', 'user'));
  });

  it('removeService deletes unit file', async () => {
    await installService({
      username: 'flowhelm-stan',
      homeDir: tmpDir,
    });

    await removeService(tmpDir);

    const exists = await readService(tmpDir);
    expect(exists).toBeNull();
  });

  it('removeService is idempotent (no error on missing file)', async () => {
    // Should not throw
    await removeService(tmpDir);
  });

  it('readService returns content or null', async () => {
    // Before install
    expect(await readService(tmpDir)).toBeNull();

    // After install
    await installService({
      username: 'flowhelm-stan',
      homeDir: tmpDir,
    });
    const content = await readService(tmpDir);
    expect(content).toContain('[Service]');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Resource Limits (Unit-testable helpers)
// ═══════════════════════════════════════════════════════════════════════════

describe('ResourceLimits helpers', () => {
  describe('parseSize', () => {
    it('parses bytes', () => {
      expect(parseSize('1024B')).toBe(1024);
      expect(parseSize('100')).toBe(100);
    });

    it('parses kilobytes', () => {
      expect(parseSize('1K')).toBe(1024);
      expect(parseSize('10K')).toBe(10240);
    });

    it('parses megabytes', () => {
      expect(parseSize('256M')).toBe(256 * 1024 ** 2);
    });

    it('parses gigabytes', () => {
      expect(parseSize('4G')).toBe(4 * 1024 ** 3);
    });

    it('parses terabytes', () => {
      expect(parseSize('1T')).toBe(1024 ** 4);
    });

    it('parses fractional values', () => {
      expect(parseSize('1.5G')).toBe(Math.round(1.5 * 1024 ** 3));
    });

    it('is case-insensitive', () => {
      expect(parseSize('4g')).toBe(4 * 1024 ** 3);
      expect(parseSize('256m')).toBe(256 * 1024 ** 2);
    });

    it('throws on invalid size', () => {
      expect(() => parseSize('abc')).toThrow('Invalid size');
      expect(() => parseSize('')).toThrow('Invalid size');
    });
  });

  describe('formatBytes', () => {
    it('formats gigabytes', () => {
      expect(formatBytes(4 * 1024 ** 3)).toBe('4.0G');
    });

    it('formats megabytes', () => {
      expect(formatBytes(256 * 1024 ** 2)).toBe('256M');
    });

    it('formats kilobytes', () => {
      expect(formatBytes(512 * 1024)).toBe('512K');
    });

    it('formats bytes', () => {
      expect(formatBytes(100)).toBe('100B');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// User Manager
// ═══════════════════════════════════════════════════════════════════════════

describe('UserManager', () => {
  let tmpDir: string;
  let portRegistry: PortRegistry;
  let manager: UserManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'flowhelm-test-'));
    portRegistry = new PortRegistry({
      registryPath: join(tmpDir, 'ports.json'),
    });
    await portRegistry.init();

    manager = new UserManager({
      portRegistry,
      log: () => {},
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('linuxUser', () => {
    it('prefixes with flowhelm-', () => {
      expect(manager.linuxUser('stan')).toBe('flowhelm-stan');
      expect(manager.linuxUser('alex')).toBe('flowhelm-alex');
    });
  });

  describe('homeDir', () => {
    it('returns /home/flowhelm-{name}', () => {
      expect(manager.homeDir('stan')).toBe('/home/flowhelm-stan');
    });
  });

  describe('validateName', () => {
    it('accepts valid names', () => {
      expect(manager.validateName('stan')).toBeNull();
      expect(manager.validateName('alex-test')).toBeNull();
      expect(manager.validateName('user_1')).toBeNull();
      expect(manager.validateName('a')).toBeNull();
    });

    it('rejects empty name', () => {
      expect(manager.validateName('')).toContain('empty');
    });

    it('rejects too long name', () => {
      expect(manager.validateName('a'.repeat(25))).toContain('24 characters');
    });

    it('rejects invalid characters', () => {
      expect(manager.validateName('STAN')).toContain('lowercase');
      expect(manager.validateName('stan tyan')).toContain('lowercase');
      expect(manager.validateName('stan.tyan')).toContain('lowercase');
    });

    it('rejects names not starting with letter', () => {
      expect(manager.validateName('1stan')).toContain('lowercase');
      expect(manager.validateName('-stan')).toContain('lowercase');
    });

    it('rejects reserved names', () => {
      expect(manager.validateName('admin')).toContain('Reserved');
      expect(manager.validateName('root')).toContain('Reserved');
    });
  });

  // addUser and removeUser require root + real Linux user creation.
  // Integration tests run during VM validation (Phase 9A pattern).
  // Here we test the validation and helper logic.

  it('addUser rejects invalid username', async () => {
    const result = await manager.addUser({
      name: '',
      sshKeyPath: '/tmp/key.pub',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('empty');
  });

  it('addUser rejects reserved name', async () => {
    const result = await manager.addUser({
      name: 'root',
      sshKeyPath: '/tmp/key.pub',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Reserved');
  });

  it('addUser rejects missing SSH key', async () => {
    const result = await manager.addUser({
      name: 'stan',
      sshKeyPath: '/tmp/nonexistent-key.pub',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('Cannot read SSH key');
  });

  it('removeUser requires --archive or --force', async () => {
    const result = await manager.removeUser({ name: 'stan' });
    expect(result.success).toBe(false);
    expect(result.message).toContain('--archive');
  });

  it('removeUser rejects nonexistent user', async () => {
    const result = await manager.removeUser({ name: 'ghost', force: true });
    expect(result.success).toBe(false);
    expect(result.message).toContain('does not exist');
  });

  it('listUsers returns empty when no allocations', async () => {
    const users = await manager.listUsers();
    expect(users).toHaveLength(0);
  });

  it('listUsers includes port allocations', async () => {
    await portRegistry.allocate('stan');
    const users = await manager.listUsers();
    expect(users).toHaveLength(1);
    expect(users[0]!.name).toBe('stan');
    expect(users[0]!.ports?.ports.proxy).toBe(10000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Admin CLI Dispatch
// ═══════════════════════════════════════════════════════════════════════════

describe('Admin CLI', () => {
  let tmpDir: string;
  let portRegistry: PortRegistry;
  let userManager: UserManager;
  let ctx: AdminContext;
  const logs: string[] = [];
  const errors: string[] = [];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'flowhelm-test-'));
    portRegistry = new PortRegistry({
      registryPath: join(tmpDir, 'ports.json'),
    });
    await portRegistry.init();

    userManager = new UserManager({
      portRegistry,
      log: (msg) => logs.push(msg),
    });

    ctx = {
      portRegistry,
      userManager,
      log: (msg) => logs.push(msg),
      error: (msg) => errors.push(msg),
    };

    logs.length = 0;
    errors.length = 0;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('dispatchAdminCommand', () => {
    it('routes status command', async () => {
      const result = await dispatchAdminCommand(['status'], ctx);
      expect(result.success).toBe(true);
    });

    it('rejects unknown subcommand', async () => {
      const result = await dispatchAdminCommand(['foobar'], ctx);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unknown admin command');
    });

    it('routes add-user and validates', async () => {
      const result = await dispatchAdminCommand(['add-user'], ctx);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing username');
    });

    it('routes remove-user and validates', async () => {
      const result = await dispatchAdminCommand(['remove-user'], ctx);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing username');
    });

    it('routes set-limits and validates', async () => {
      const result = await dispatchAdminCommand(['set-limits'], ctx);
      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing username');
    });

    it('set-limits requires at least one limit flag', async () => {
      const result = await dispatchAdminCommand(['set-limits', 'stan'], ctx);
      expect(result.success).toBe(false);
      expect(result.message).toContain('No limits specified');
    });
  });

  describe('adminStatusCommand', () => {
    it('shows empty state', async () => {
      const result = await adminStatusCommand(ctx);
      expect(result.success).toBe(true);
      expect(logs.some((l) => l.includes('No users'))).toBe(true);
    });

    it('lists provisioned users', async () => {
      await portRegistry.allocate('stan');
      await portRegistry.allocate('alex');

      const result = await adminStatusCommand(ctx);
      expect(result.success).toBe(true);
      expect(result.message).toContain('2');
    });
  });

  describe('extractFlag', () => {
    it('extracts --flag value', () => {
      expect(extractFlag(['--name', 'stan'], 'name')).toBe('stan');
    });

    it('extracts --flag=value', () => {
      expect(extractFlag(['--name=stan'], 'name')).toBe('stan');
    });

    it('returns undefined for missing flag', () => {
      expect(extractFlag(['--other', 'val'], 'name')).toBeUndefined();
    });

    it('returns undefined for flag at end without value', () => {
      expect(extractFlag(['--name'], 'name')).toBeUndefined();
    });
  });
});
