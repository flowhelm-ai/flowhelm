/**
 * Backup and restore commands for FlowHelm user data.
 *
 * `flowhelm admin backup <name>` creates a timestamped tar.gz archive
 * containing the user's PostgreSQL dump, config, encrypted credentials,
 * and installed skills manifest.
 *
 * `flowhelm admin restore <name> --from <path>` restores from an archive.
 *
 * `flowhelm admin backup --list <name>` lists available backups.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CliResult } from './cli.js';
import { extractFlag } from './cli.js';

const execFileAsync = promisify(execFileCb);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BackupOptions {
  /** User short name (e.g., "mark"). */
  name: string;
  /** Backup output directory. Default: /var/backup/flowhelm */
  backupDir?: string;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  /** Custom exec function for testing. */
  execFn?: typeof execFileAsync;
}

export interface RestoreOptions {
  /** User short name. */
  name: string;
  /** Path to the backup archive. */
  archivePath: string;
  /** Backup directory for scanning. Default: /var/backup/flowhelm */
  backupDir?: string;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
  /** Custom exec function for testing. */
  execFn?: typeof execFileAsync;
}

export interface ListBackupsOptions {
  /** User short name. */
  name: string;
  /** Backup directory. Default: /var/backup/flowhelm */
  backupDir?: string;
  log?: (msg: string) => void;
}

export interface BackupEntry {
  filename: string;
  path: string;
  date: Date;
  sizeBytes: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_BACKUP_DIR = '/var/backup/flowhelm';
const LINUX_USER_PREFIX = 'flowhelm-';

// ─── Helpers ────────────────────────────────────────────────────────────────

function linuxUser(name: string): string {
  return `${LINUX_USER_PREFIX}${name}`;
}

function userHome(name: string): string {
  return `/home/${linuxUser(name)}`;
}

function configDir(name: string): string {
  return path.join(userHome(name), '.flowhelm');
}

function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// ─── Backup ─────────────────────────────────────────────────────────────────

export async function createBackup(options: BackupOptions): Promise<CliResult> {
  const log = options.log ?? console.log;
  const errFn = options.error ?? console.error;
  const exec = options.execFn ?? execFileAsync;
  const backupDir = options.backupDir ?? DEFAULT_BACKUP_DIR;
  const { name } = options;

  const home = userHome(name);
  const cfg = configDir(name);
  const dbContainer = `flowhelm-db-${name}`;

  // Verify user home exists
  if (!fs.existsSync(home)) {
    errFn(`User home not found: ${home}`);
    return { success: false, message: `User "${name}" does not exist` };
  }

  // Ensure backup dir exists
  await fsp.mkdir(backupDir, { recursive: true });

  // Create temp staging directory
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `flowhelm-backup-${name}-`));

  try {
    // 1. PostgreSQL dump (run as the Linux user whose rootless Podman owns the container)
    log(`  Dumping database from ${dbContainer}...`);
    try {
      const { stdout } = await exec(
        'sudo',
        [
          '-u',
          linuxUser(name),
          'podman',
          'exec',
          dbContainer,
          'pg_dump',
          '-U',
          'flowhelm',
          'flowhelm',
        ],
        { cwd: userHome(name) },
      );
      await fsp.writeFile(path.join(tmpDir, 'database.sql'), stdout);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errFn(`  Database dump failed: ${msg}`);
      return { success: false, message: `Database dump failed for "${name}": ${msg}` };
    }

    // 2. Config file
    const configPath = path.join(cfg, 'config.yaml');
    if (fs.existsSync(configPath)) {
      await fsp.cp(configPath, path.join(tmpDir, 'config.yaml'));
      log('  Copied config.yaml');
    }

    // 3. Secrets directory
    const secretsDir = path.join(cfg, 'secrets');
    if (fs.existsSync(secretsDir)) {
      await fsp.cp(secretsDir, path.join(tmpDir, 'secrets'), { recursive: true });
      log('  Copied secrets/');
    }

    // 4. Skills manifest
    const skillsManifest = path.join(cfg, 'skills', 'installed.json');
    if (fs.existsSync(skillsManifest)) {
      await fsp.mkdir(path.join(tmpDir, 'skills'), { recursive: true });
      await fsp.cp(skillsManifest, path.join(tmpDir, 'skills', 'installed.json'));
      log('  Copied skills/installed.json');
    }

    // Create tar.gz archive
    const timestamp = formatTimestamp();
    const archiveName = `flowhelm-${name}-${timestamp}.tar.gz`;
    const archivePath = path.join(backupDir, archiveName);

    await exec('tar', ['-czf', archivePath, '-C', tmpDir, '.']);

    const stat = await fsp.stat(archivePath);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);

    log(`  Archive: ${archivePath} (${sizeMB} MB)`);
    return { success: true, message: `Backup created: ${archivePath}` };
  } finally {
    // Clean up temp dir
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── Restore ────────────────────────────────────────────────────────────────

export async function restoreBackup(options: RestoreOptions): Promise<CliResult> {
  const log = options.log ?? console.log;
  const errFn = options.error ?? console.error;
  const exec = options.execFn ?? execFileAsync;
  const { name, archivePath } = options;

  const home = userHome(name);
  const cfg = configDir(name);
  const dbContainer = `flowhelm-db-${name}`;
  const linux = linuxUser(name);

  // Verify archive exists
  if (!fs.existsSync(archivePath)) {
    errFn(`Archive not found: ${archivePath}`);
    return { success: false, message: `Archive not found: ${archivePath}` };
  }

  // Verify user home exists
  if (!fs.existsSync(home)) {
    errFn(`User home not found: ${home}`);
    return { success: false, message: `User "${name}" does not exist` };
  }

  // Extract to temp dir
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), `flowhelm-restore-${name}-`));

  try {
    await exec('tar', ['-xzf', archivePath, '-C', tmpDir]);

    // 1. Stop user service
    log('  Stopping orchestrator service...');
    try {
      await exec('systemctl', ['--user', `--machine=${linux}@.host`, 'stop', 'flowhelm.service']);
    } catch {
      // Service may not be running — that's fine
    }

    // 2. Restore config
    const configSrc = path.join(tmpDir, 'config.yaml');
    if (fs.existsSync(configSrc)) {
      await fsp.mkdir(cfg, { recursive: true });
      await fsp.cp(configSrc, path.join(cfg, 'config.yaml'));
      log('  Restored config.yaml');
    }

    // 3. Restore secrets
    const secretsSrc = path.join(tmpDir, 'secrets');
    if (fs.existsSync(secretsSrc)) {
      const secretsDst = path.join(cfg, 'secrets');
      await fsp.mkdir(secretsDst, { recursive: true });
      await fsp.cp(secretsSrc, secretsDst, { recursive: true });
      log('  Restored secrets/');
    }

    // 4. Restore skills manifest
    const skillsSrc = path.join(tmpDir, 'skills', 'installed.json');
    if (fs.existsSync(skillsSrc)) {
      const skillsDst = path.join(cfg, 'skills');
      await fsp.mkdir(skillsDst, { recursive: true });
      await fsp.cp(skillsSrc, path.join(skillsDst, 'installed.json'));
      log('  Restored skills/installed.json');
    }

    // 5. Restore database (run as the Linux user whose rootless Podman owns the container)
    const dbSrc = path.join(tmpDir, 'database.sql');
    if (fs.existsSync(dbSrc)) {
      log(`  Restoring database to ${dbContainer}...`);
      // Start DB container temporarily (service was stopped, so container may be stopped too)
      try {
        await exec('sudo', ['-u', linux, 'podman', 'start', dbContainer], { cwd: home });
        // Wait for PostgreSQL to be ready
        let ready = false;
        for (let i = 0; i < 20; i++) {
          try {
            await exec(
              'sudo',
              [
                '-u',
                linux,
                'podman',
                'exec',
                dbContainer,
                'pg_isready',
                '-U',
                'flowhelm',
                '-d',
                'flowhelm',
              ],
              { cwd: home },
            );
            ready = true;
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        if (!ready) {
          errFn('  Database container did not become ready');
          return { success: false, message: 'Database container not ready for restore' };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errFn(`  Failed to start database container: ${msg}`);
        return { success: false, message: `Cannot start DB container for restore: ${msg}` };
      }
      // Copy SQL dump into the container and run psql -f (stdin piping through sudo is unreliable)
      // First copy to user-accessible location (temp dir is root-owned)
      const userSqlPath = path.join(home, '.flowhelm', 'restore-tmp.sql');
      await fsp.cp(dbSrc, userSqlPath);
      await exec('chown', [`${linux}:${linux}`, userSqlPath]);
      const containerSqlPath = '/tmp/restore.sql';
      await exec(
        'sudo',
        ['-u', linux, 'podman', 'cp', userSqlPath, `${dbContainer}:${containerSqlPath}`],
        { cwd: home },
      );
      await exec(
        'sudo',
        [
          '-u',
          linux,
          'podman',
          'exec',
          dbContainer,
          'psql',
          '-U',
          'flowhelm',
          '-d',
          'flowhelm',
          '-f',
          containerSqlPath,
        ],
        { cwd: home },
      );
      await exec(
        'sudo',
        ['-u', linux, 'podman', 'exec', dbContainer, 'rm', '-f', containerSqlPath],
        { cwd: home },
      ).catch(() => {});
      await fsp.rm(userSqlPath, { force: true }).catch(() => {});
      // Stop DB container again before service restart takes over
      await exec('sudo', ['-u', linux, 'podman', 'stop', dbContainer], { cwd: home }).catch(
        () => {},
      );
      log('  Database restored');
    }

    // 6. Restart service
    log('  Restarting orchestrator service...');
    try {
      await exec('systemctl', ['--user', `--machine=${linux}@.host`, 'start', 'flowhelm.service']);
    } catch {
      log('  Service not restarted (may need manual start)');
    }

    return { success: true, message: `Backup restored for "${name}" from ${archivePath}` };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

// ─── List ───────────────────────────────────────────────────────────────────

export async function listBackups(options: ListBackupsOptions): Promise<BackupEntry[]> {
  const log = options.log ?? console.log;
  const backupDir = options.backupDir ?? DEFAULT_BACKUP_DIR;
  const { name } = options;

  const prefix = `flowhelm-${name}-`;

  if (!fs.existsSync(backupDir)) {
    log('No backups found.');
    return [];
  }

  const entries = await fsp.readdir(backupDir);
  const backups: BackupEntry[] = [];

  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith('.tar.gz')) continue;

    const fullPath = path.join(backupDir, entry);
    try {
      const stat = await fsp.stat(fullPath);
      // Parse timestamp from filename: flowhelm-{name}-YYYYMMDD-HHMMSS.tar.gz
      const timestampStr = entry.slice(prefix.length, -7); // strip .tar.gz
      const year = parseInt(timestampStr.slice(0, 4), 10);
      const month = parseInt(timestampStr.slice(4, 6), 10) - 1;
      const day = parseInt(timestampStr.slice(6, 8), 10);
      const hour = parseInt(timestampStr.slice(9, 11), 10);
      const min = parseInt(timestampStr.slice(11, 13), 10);
      const sec = parseInt(timestampStr.slice(13, 15), 10);

      backups.push({
        filename: entry,
        path: fullPath,
        date: new Date(year, month, day, hour, min, sec),
        sizeBytes: stat.size,
      });
    } catch {
      // Skip unreadable files
    }
  }

  // Sort newest first
  backups.sort((a, b) => b.date.getTime() - a.date.getTime());

  if (backups.length === 0) {
    log('No backups found.');
  } else {
    log(`Backups for "${name}" (${String(backups.length)}):`);
    for (const b of backups) {
      const sizeMB = (b.sizeBytes / 1024 / 1024).toFixed(1);
      log(`  ${b.filename}  ${b.date.toISOString().slice(0, 19)}  ${sizeMB} MB`);
    }
  }

  return backups;
}

// ─── CLI Command Handlers ───────────────────────────────────────────────────

export async function adminBackupCommand(
  args: string[],
  ctx: { log?: (msg: string) => void; error?: (msg: string) => void },
  execFn?: typeof execFileAsync,
): Promise<CliResult> {
  const log = ctx.log ?? console.log;
  const errFn = ctx.error ?? console.error;

  const listFlag = args.includes('--list');
  const name = args.find((a) => !a.startsWith('--'));

  if (!name) {
    errFn('Usage: flowhelm admin backup <name> [--list]');
    return { success: false, message: 'Missing username' };
  }

  if (listFlag) {
    await listBackups({ name, log });
    return { success: true, message: `Listed backups for "${name}"` };
  }

  log(`Creating backup for "${name}"...`);
  return createBackup({ name, log, error: errFn, execFn });
}

export async function adminRestoreCommand(
  args: string[],
  ctx: { log?: (msg: string) => void; error?: (msg: string) => void },
  execFn?: typeof execFileAsync,
): Promise<CliResult> {
  const errFn = ctx.error ?? console.error;
  const log = ctx.log ?? console.log;

  const name = args.find((a) => !a.startsWith('--'));
  const archivePath = extractFlag(args, 'from');

  if (!name) {
    errFn('Usage: flowhelm admin restore <name> --from <path>');
    return { success: false, message: 'Missing username' };
  }

  if (!archivePath) {
    errFn('Usage: flowhelm admin restore <name> --from <path>');
    errFn('Missing --from flag');
    return { success: false, message: 'Missing --from flag' };
  }

  log(`Restoring backup for "${name}" from ${archivePath}...`);
  return restoreBackup({ name, archivePath, log, error: errFn, execFn });
}
