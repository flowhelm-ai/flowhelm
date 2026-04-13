#!/usr/bin/env node

/**
 * FlowHelm CLI entry point.
 *
 * Parses the first argument as a subcommand and dispatches to the
 * appropriate handler. Only `flowhelm start` (or bare `flowhelm`)
 * starts the full orchestrator. All other commands run standalone
 * without loading the orchestrator or its heavy dependencies.
 */

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { getVersion } from './admin/version.js';
import { extractFlag } from './admin/cli.js';

// ─── Help ──────────────────────────────────────────────────────────────────

function printHelp(): void {
  const version = getVersion();
  console.log(`FlowHelm v${version} — Secure, multi-tenant AI agent orchestrator

Usage: flowhelm <command> [options]

Commands:
  start                Start the orchestrator (default if no command given)
  setup                Interactive onboarding wizard
  setup telegram       Configure Telegram channel
  setup gmail          Configure Gmail channel
  setup identity       Configure agent and user identity
  auth status           Show authentication health and token expiry
  auth switch <method>  Switch between oauth and api_key
  doctor               Run diagnostic health checks
  status               Show system status (--json for machine-readable)

  install <name>       Install a skill from the registry or local path
  uninstall <name>     Uninstall a skill
  list                 List installed skills
  search <query>       Search the skills registry
  info <name>          Show skill details
  update [name]        Update skills (all or specific)

  admin init           Initialize FlowHelm on this VM (run as root)
  admin add-user       Provision a new user
  admin remove-user    Remove a user
  admin status         Show all users and resource usage
  admin set-limits     Adjust per-user resource limits
  admin backup         Backup a user's data
  admin restore        Restore a user's data from backup

  identity             Manage agent/user identity (requires running orchestrator)
  personality          Manage agent/user personality (requires running orchestrator)

Options:
  --version, -v        Print version
  --help, -h           Print this help message

Quick start:
  curl -fsSL https://flowhelm.ai/install.sh | bash
  flowhelm admin init
  flowhelm admin add-user yourname --ssh-key ~/.ssh/yourname.pub
  ssh flowhelm-yourname@localhost
  flowhelm setup
`);
}

// ─── Lightweight context factories ─────────────────────────────────────────

function getConfigDir(): string {
  return resolve(
    (process.env['FLOWHELM_CONFIG_DIR'] ?? process.env['HOME'] ?? homedir()) + '/.flowhelm',
  );
}

function getDataDir(): string {
  return process.env['FLOWHELM_DATA_DIR'] ?? getConfigDir();
}

/**
 * Create a lightweight SkillStore + RegistryClient for skill commands.
 * Does NOT require a database connection or running orchestrator.
 */
async function createSkillContext() {
  const { SkillStore } = await import('./skills/store.js');
  const { RegistryClient } = await import('./skills/registry.js');

  const skillStore = new SkillStore({ skillsDir: resolve(getDataDir(), 'skills') });
  await skillStore.init();

  const registryClient = new RegistryClient();

  return { skillStore, registryClient };
}

// ─── Command handlers ──────────────────────────────────────────────────────

async function handleStart(): Promise<void> {
  // Dynamic import to avoid loading heavy orchestrator deps for other commands
  const { main } = await import('./index.js');
  return main();
}

async function handleSetup(args: string[]): Promise<void> {
  const subcommand = args[0];

  // Bare `flowhelm setup` → interactive wizard
  if (!subcommand || subcommand.startsWith('--')) {
    const { runSetupWizard } = await import('./admin/setup-wizard.js');
    const configDir = getConfigDir();
    const dataDir = getDataDir();

    // Check for --no-interactive mode
    const noInteractive = args.includes('--no-interactive');

    const result = await runSetupWizard({
      configDir,
      dataDir,
      noInteractive,
      flags: noInteractive ? parseNonInteractiveFlags(args) : undefined,
    });

    if (!result.success) {
      process.exit(1);
    }
    return;
  }

  // Setup subcommands (telegram, gmail, identity) use existing flag-based dispatch
  const { dispatchCommand } = await import('./admin/cli.js');
  const ctx = await createSkillContext();
  const result = await dispatchCommand(['setup', ...args], ctx);
  if (!result.success) {
    process.exit(1);
  }
}

async function handleDoctor(args: string[]): Promise<void> {
  const { runDoctor } = await import('./admin/doctor.js');
  const verbose = args.includes('--verbose') || args.includes('-v');
  const result = await runDoctor({ verbose });

  if (result.overallStatus === 'fail') {
    process.exit(1);
  }
}

async function handleStatus(args: string[]): Promise<void> {
  const { getStatus } = await import('./admin/status.js');
  const json = args.includes('--json');
  const admin = process.getuid?.() === 0;
  await getStatus({ json, admin });
}

async function handleAdmin(args: string[]): Promise<void> {
  const { dispatchAdminCommand, createAdminContext } = await import('./admin/cli.js');
  const ctx = createAdminContext();
  const result = await dispatchAdminCommand(args, ctx);
  if (!result.success) {
    console.error(`[flowhelm] ${result.message}`);
    process.exit(1);
  }
}

async function handleSkillCommand(command: string, args: string[]): Promise<void> {
  const { dispatchCommand } = await import('./admin/cli.js');
  const ctx = await createSkillContext();
  const result = await dispatchCommand([command, ...args], ctx);
  if (!result.success) {
    process.exit(1);
  }
}

async function handleAuth(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'status') {
    const { checkAuthHealth } = await import('./auth/auth-monitor.js');
    const results = await checkAuthHealth();
    console.log('');
    console.log('Authentication Status:');
    console.log('');
    for (const r of results) {
      const icon =
        r.status === 'ok' ? '  [OK]  ' : r.status === 'expired' ? '  [FAIL]' : '  [WARN]';
      console.log(`${icon} ${r.message}`);
      if (r.fix) console.log(`         Fix: ${r.fix}`);
    }
    console.log('');
    return;
  }

  if (subcommand === 'switch') {
    const target = args[1];
    if (!target || (target !== 'oauth' && target !== 'api_key')) {
      console.error('Usage: flowhelm auth switch <oauth|api_key>');
      console.error('');
      console.error('Switches the active credential method in ~/.flowhelm/config.yaml.');
      console.error('The orchestrator will use the new method on next request.');
      process.exit(1);
      return;
    }

    const { loadConfig, saveConfig } = await import('./config/loader.js');
    const configDir = getConfigDir();
    const config = loadConfig();

    // Verify the target auth is actually configured
    const { checkAuthHealth } = await import('./auth/auth-monitor.js');
    const results = await checkAuthHealth();
    const targetResult = results.find((r) => {
      if (target === 'oauth') return r.type === 'oauth';
      if (target === 'api_key') return r.type === 'api_key';
      return false;
    });

    if (!targetResult || targetResult.status === 'missing') {
      console.error(`Error: ${target} is not configured.`);
      console.error('Run "flowhelm setup" to configure it first.');
      process.exit(1);
      return;
    }

    if (targetResult.status === 'expired') {
      console.error(`Warning: ${target} credentials are expired.`);
      console.error('Run "flowhelm setup" to renew before switching.');
      process.exit(1);
      return;
    }

    // Update config
    const authMethod = target === 'oauth' ? 'subscription_bridge' : 'api_key';
    const credentialMethod = target;
    config.auth.method = authMethod;
    config.agent.credentialMethod = credentialMethod;
    await saveConfig(config, configDir);

    console.log(`Switched to ${target}. The orchestrator will use this on next request.`);
    console.log(
      'If the orchestrator is running, restart it: systemctl --user restart flowhelm.service',
    );
    return;
  }

  console.error(`Unknown auth subcommand: ${subcommand}`);
  console.error('Usage: flowhelm auth <status|switch>');
  process.exit(1);
}

async function handleIdentityPersonality(command: string, args: string[]): Promise<void> {
  // Identity and personality commands need a database connection.
  // Direct users to setup or channel commands.
  if (args.length === 0 || (args[0] !== 'agent' && args[0] !== 'user')) {
    console.error(`Usage: flowhelm ${command} <agent|user> <show|set> [flags]`);
    console.error('');
    console.error('Note: Identity/personality commands require a running orchestrator.');
    console.error('Alternatives:');
    console.error('  flowhelm setup identity   Configure identity during setup');
    console.error('  /identity                 Use in a channel conversation');
    console.error('  /personality              Use in a channel conversation');
    process.exit(1);
    return;
  }

  // Try to connect to the running orchestrator's MCP server or DB
  // For now, guide users to setup identity (which writes to config, no DB needed)
  console.error(`The "${command}" command requires a running orchestrator with database access.`);
  console.error('');
  console.error('Use one of these alternatives:');
  console.error('  flowhelm setup identity   Configure identity (writes to config.yaml)');
  console.error(`  /${command}                 Use in a channel conversation (e.g., Telegram)`);
  process.exit(1);
}

/** Parse --flag values for --no-interactive mode. */
function parseNonInteractiveFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  const flagNames = [
    'anthropic-key',
    'telegram-token',
    'telegram-users',
    'whatsapp-enabled',
    'gmail-email',
    'gmail-client-id',
    'gmail-client-secret',
    'gmail-refresh-token',
    'gmail-gcp-project',
    'gmail-transport',
    'gmail-notification-channel',
    'gmail-service-account-key',
    'voice',
    'openai-key',
    'agent-role',
    'agent-tone',
    'agent-expertise',
    'user-name',
    'user-role',
    'user-timezone',
    'runtime',
  ];
  for (const name of flagNames) {
    const value = extractFlag(args, name);
    if (value) flags[name] = value;
  }
  return flags;
}

// ─── Main dispatcher ───────────────────────────────────────────────────────

export async function cli(argv: string[]): Promise<void> {
  const args = argv.slice(2); // strip node and script path
  const command = args[0];

  switch (command) {
    case undefined:
    case 'start':
      return handleStart();

    case 'setup':
      return handleSetup(args.slice(1));

    case 'doctor':
      return handleDoctor(args.slice(1));

    case 'status':
      return handleStatus(args.slice(1));

    case 'auth':
      return handleAuth(args.slice(1));

    case 'admin':
      return handleAdmin(args.slice(1));

    case 'install':
    case 'uninstall':
    case 'list':
    case 'search':
    case 'info':
    case 'update':
      return handleSkillCommand(command, args.slice(1));

    case 'identity':
    case 'personality':
      return handleIdentityPersonality(command, args.slice(1));

    case 'version':
    case '--version':
    case '-v':
      console.log(`flowhelm v${getVersion()}`);
      return;

    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "flowhelm --help" for usage information.');
      process.exit(1);
  }
}

// Auto-invoke when run directly
cli(process.argv).catch((err) => {
  console.error('[flowhelm] Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
