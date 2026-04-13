/**
 * Interactive setup wizard for `flowhelm setup`.
 *
 * Walks users through a multi-section onboarding flow:
 * 1. Authentication (API key vs subscription)
 * 2. Agent runtime (CLI vs SDK)
 * 3. Channels (Telegram, WhatsApp, Gmail)
 * 4. Voice transcription (Whisper API, whisper.cpp, none)
 * 5. Identity (agent role, user name, timezone)
 * 6. Summary + write config + start services
 *
 * Supports --no-interactive mode with flags for IaC automation.
 * Detects existing config and offers section-based modification.
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { platform, cpus } from 'node:os';
import { runAuthSetup, runApiKeyFlow } from '../auth/setup-flow.js';
import { setupTelegramCommand, setupGmailCommand, type SetupContext } from './cli.js';
import { SkillStore } from '../skills/store.js';
import { RegistryClient } from '../skills/registry.js';
import { CredentialStore } from '../proxy/credential-store.js';
import { detectPlatform, getPodmanMachineState, type PlatformInfo } from '../container/platform.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SetupWizardOptions {
  configDir: string;
  dataDir: string;
  rl?: ReadlineInterface;
  output?: NodeJS.WritableStream;
  noInteractive?: boolean;
  flags?: Record<string, string>;
  /** Skip model downloads (for testing). */
  skipModelDownload?: boolean;
  /** Override platform info for testing. */
  platformInfoOverride?: PlatformInfo;
}

export interface SectionResult {
  name: string;
  completed: boolean;
  skipped: boolean;
}

export interface SetupWizardResult {
  success: boolean;
  sections: SectionResult[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function prompt(rl: ReadlineInterface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

/**
 * Prompt for multi-line JSON input (e.g., pasted service account key).
 * Collects lines until a valid JSON object is formed (balanced braces).
 * Returns empty string if the user presses Enter without input.
 */
function promptMultilineJson(rl: ReadlineInterface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (firstLine) => {
      const trimmed = firstLine.trim();
      if (!trimmed) {
        resolve('');
        return;
      }

      // If the first line contains a complete JSON object, return it
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          JSON.parse(trimmed);
          resolve(trimmed);
          return;
        } catch {
          /* incomplete */
        }
      }

      // Collect additional lines until we have valid JSON
      const lines = [firstLine];
      const onLine = (line: string): void => {
        lines.push(line);
        const combined = lines.join('\n').trim();
        if (combined.endsWith('}')) {
          try {
            JSON.parse(combined);
            rl.removeListener('line', onLine);
            resolve(combined);
            return;
          } catch {
            /* incomplete */
          }
        }
      };
      rl.on('line', onLine);
    });
  });
}

function write(output: NodeJS.WritableStream, msg: string): void {
  output.write(msg + '\n');
}

// ─── Section runners ────────────────────────────────────────────────────────

async function runAuthSection(
  rl: ReadlineInterface,
  output: NodeJS.WritableStream,
  _configDir: string,
  flags?: Record<string, string>,
): Promise<SectionResult> {
  write(output, '');
  write(
    output,
    '\u2500\u2500\u2500 Authentication \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  );

  if (flags?.['anthropic-key']) {
    // Non-interactive: use provided API key
    const result = await runApiKeyFlow({
      dataDir: _configDir,
      rl,
      output,
      key: flags['anthropic-key'],
    });
    return { name: 'Authentication', completed: result.success, skipped: false };
  }

  const result = await runAuthSetup({ dataDir: _configDir, rl, output });
  return { name: 'Authentication', completed: result.success, skipped: false };
}

async function runRuntimeSection(
  rl: ReadlineInterface,
  output: NodeJS.WritableStream,
  _configDir: string,
  flags?: Record<string, string>,
): Promise<{ result: SectionResult; runtime: string; credentialMethod: string }> {
  write(output, '');
  write(
    output,
    '\u2500\u2500\u2500 Agent Runtime \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  );

  let runtime = 'cli';
  let credentialMethod = 'api_key';

  if (flags?.['runtime']) {
    runtime = flags['runtime'];
  } else {
    write(output, 'Agent execution runtime:');
    write(output, '  1. Claude Code CLI (default \u2014 supports API key and subscription)');
    write(output, '  2. Claude Agent SDK (requires API key, for enterprise use)');
    const choice = await prompt(rl, '> ');
    if (choice === '2') {
      runtime = 'sdk';
      credentialMethod = 'api_key';
      write(output, '\u2713 SDK runtime selected (requires API key authentication)');
    } else {
      write(output, '\u2713 CLI runtime selected');
    }
  }

  return {
    result: { name: 'Runtime', completed: true, skipped: false },
    runtime,
    credentialMethod,
  };
}

async function runChannelsSection(
  rl: ReadlineInterface,
  output: NodeJS.WritableStream,
  configDir: string,
  dataDir: string,
  flags?: Record<string, string>,
): Promise<SectionResult> {
  write(output, '');
  write(
    output,
    '\u2500\u2500\u2500 Channels \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  );

  const skillStore = new SkillStore({ skillsDir: resolve(dataDir, 'skills') });
  await skillStore.init();
  const registryClient = new RegistryClient();
  const setupCtx: SetupContext = {
    configDir,
    skillStore,
    registryClient,
    log: (msg) => write(output, msg),
    error: (msg) => write(output, msg),
  };

  if (flags?.['telegram-token']) {
    // Non-interactive Telegram
    const allowedUsers = flags['telegram-users']
      ? flags['telegram-users']
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => !isNaN(n))
      : undefined;
    await setupTelegramCommand({ botToken: flags['telegram-token'], allowedUsers }, setupCtx);
  } else if (!flags) {
    // Interactive: ask which channels to enable
    write(output, 'Which channels would you like to enable?');
    write(output, '  1. Telegram (recommended)');
    write(output, '  2. WhatsApp');
    write(output, '  3. Gmail notifications');
    write(output, '  4. None (configure later)');
    write(output, '');
    write(output, 'Enter numbers separated by commas (e.g., 1,3):');
    const channelChoice = await prompt(rl, '> ');
    const choices = channelChoice.split(',').map((s) => s.trim());

    // Telegram
    if (choices.includes('1')) {
      write(output, '');
      write(output, 'Telegram Setup:');
      write(output, '  Create a bot via @BotFather on Telegram to get a bot token.');
      write(output, '  Then restrict access to your Telegram user ID(s).');
      write(output, '');
      const token = await prompt(rl, 'Telegram bot token: ');
      if (token) {
        const userIds = await prompt(rl, 'Allowed Telegram user IDs (comma-separated): ');
        const allowedUsers = userIds
          ? userIds
              .split(',')
              .map((s) => Number(s.trim()))
              .filter((n) => !isNaN(n))
          : undefined;
        await setupTelegramCommand({ botToken: token, allowedUsers }, setupCtx);
      }
    }

    // WhatsApp
    if (choices.includes('2')) {
      write(output, '');
      write(output, 'WhatsApp Setup:');
      write(output, '  WhatsApp uses QR code pairing. No credentials needed now.');
      write(output, '  A QR code will be displayed when you first start FlowHelm.');
      write(output, '  Scan it with WhatsApp on your phone to pair.');
      write(output, '');

      // Write whatsapp enabled to config
      const configPath = resolve(configDir, 'config.yaml');
      let existing: Record<string, unknown> = {};
      if (existsSync(configPath)) {
        const raw = readFileSync(configPath, 'utf-8');
        const parsed: unknown = parseYaml(raw);
        if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>;
      }
      const channels = (existing['channels'] as Record<string, unknown>) ?? {};
      channels['whatsapp'] = { enabled: true };
      existing['channels'] = channels;
      await mkdir(configDir, { recursive: true });
      await writeFile(configPath, stringifyYaml(existing), 'utf-8');
      write(output, '\u2713 WhatsApp enabled in config');
    }

    // Gmail
    if (choices.includes('3')) {
      write(output, '');
      write(output, 'Gmail Setup:');
      write(output, '');
      write(output, 'Email notification transport:');
      write(output, '  1. Google Cloud Pub/Sub (recommended \u2014 real-time, reliable)');
      write(output, '  2. IMAP IDLE (simpler \u2014 no GCP project needed)');
      const transportChoice = await prompt(rl, '> ');
      const transport: 'pubsub' | 'imap' = transportChoice === '2' ? 'imap' : 'pubsub';

      write(output, '');
      write(output, 'Gmail requires OAuth2 credentials from Google Cloud Console.');
      write(output, 'See: https://flowhelm.ai/docs/gmail-setup');
      write(output, '');
      const email = await prompt(rl, 'Gmail address: ');
      const clientId = await prompt(rl, 'OAuth client ID: ');
      const clientSecret = await prompt(rl, 'OAuth client secret: ');
      const refreshToken = await prompt(rl, 'OAuth refresh token: ');

      if (email && clientId && clientSecret && refreshToken) {
        const gmailOptions: Parameters<typeof setupGmailCommand>[0] = {
          emailAddress: email,
          oauthClientId: clientId,
          oauthClientSecret: clientSecret,
          oauthRefreshToken: refreshToken,
          transport,
        };

        if (transport === 'pubsub') {
          const gcpProject = await prompt(rl, 'GCP project ID: ');
          if (gcpProject) gmailOptions.gcpProject = gcpProject;
          write(output, '');
          write(output, 'Paste your service account key JSON below (or press Enter to skip):');
          const saKeyJson = await promptMultilineJson(rl, '');
          if (saKeyJson) gmailOptions.serviceAccountKeyJson = saKeyJson;
        }

        write(output, '');
        write(output, 'Which channel should receive email notifications?');
        write(output, '  1. Telegram');
        write(output, '  2. WhatsApp');
        write(output, '  3. None (reply via Gmail only)');
        const notifChoice = await prompt(rl, '> ');
        if (notifChoice === '1') gmailOptions.notificationChannel = 'telegram';
        else if (notifChoice === '2') gmailOptions.notificationChannel = 'whatsapp';

        await setupGmailCommand(gmailOptions, setupCtx);
      }
    }
  }

  // Non-interactive Gmail
  if (
    flags?.['gmail-email'] &&
    flags['gmail-client-id'] &&
    flags['gmail-client-secret'] &&
    flags['gmail-refresh-token']
  ) {
    // --gmail-service-account-key accepts either a file path or inline JSON
    const saKeyFlag = flags['gmail-service-account-key'];
    const saKeyIsJson = saKeyFlag?.trimStart().startsWith('{');
    await setupGmailCommand(
      {
        emailAddress: flags['gmail-email'],
        oauthClientId: flags['gmail-client-id'],
        oauthClientSecret: flags['gmail-client-secret'],
        oauthRefreshToken: flags['gmail-refresh-token'],
        gcpProject: flags['gmail-gcp-project'],
        serviceAccountKeyPath: saKeyIsJson ? undefined : saKeyFlag,
        serviceAccountKeyJson: saKeyIsJson ? saKeyFlag : undefined,
        transport: (flags['gmail-transport'] as 'pubsub' | 'imap') ?? 'pubsub',
        notificationChannel: flags['gmail-notification-channel'] as
          | 'telegram'
          | 'whatsapp'
          | undefined,
      },
      setupCtx,
    );
  }

  return { name: 'Channels', completed: true, skipped: false };
}

// ── Whisper Model Definitions ────────────────────────────────────────────────

interface WhisperModel {
  name: string;
  filename: string;
  url: string;
  sizeBytes: number;
  sizeLabel: string;
  /** Minimum container memory for model + inference buffers. */
  memoryLimit: string;
  /** Recommended CPU limit for the service container. */
  cpuLimit: string;
  /** Recommended whisper.cpp threads (capped by available cores at runtime). */
  threads: number;
  quality: string;
  speed: string;
}

const WHISPER_MODELS: WhisperModel[] = [
  {
    name: 'small',
    filename: 'ggml-small.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    sizeBytes: 488_000_000,
    sizeLabel: '466 MB',
    memoryLimit: '1536m',
    cpuLimit: '2.0',
    threads: 4,
    quality: 'Good',
    speed: 'Fast (~3-5x real-time)',
  },
  {
    name: 'large-v3-turbo',
    filename: 'ggml-large-v3-turbo.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    sizeBytes: 1_600_000_000,
    sizeLabel: '1.6 GB',
    memoryLimit: '4096m',
    cpuLimit: '4.0',
    threads: 6,
    quality: 'Best (multilingual)',
    speed: 'Slower (~1-2x real-time)',
  },
];

/** Get available CPU cores. */
function getAvailableCpuCores(): number {
  try {
    return cpus().length;
  } catch {
    return 4;
  }
}

/** Clamp whisper threads to not exceed available cores or Podman VM cores. */
function clampThreads(recommended: number, availableCores: number): number {
  // Reserve 2 cores for other containers (proxy, channel, agent, db)
  const maxThreads = Math.max(2, availableCores - 2);
  return Math.min(recommended, maxThreads, 16);
}

/**
 * Download a whisper model file with wget (fallback: curl).
 * Returns true on success.
 */
async function downloadModel(
  model: WhisperModel,
  destPath: string,
  output: NodeJS.WritableStream,
): Promise<boolean> {
  const execFileAsync = promisify(execFile);
  try {
    await execFileAsync('wget', ['-q', '--show-progress', '-O', destPath, model.url], {
      timeout: 1_200_000,
    });
    return true;
  } catch {
    try {
      await execFileAsync('curl', ['-fSL', '-o', destPath, model.url], { timeout: 1_200_000 });
      return true;
    } catch {
      write(output, `  Warning: Could not download model. Download manually:`);
      write(output, `    curl -fSL -o ${destPath} ${model.url}`);
      return false;
    }
  }
}

async function runVoiceSection(
  rl: ReadlineInterface,
  output: NodeJS.WritableStream,
  configDir: string,
  flags?: Record<string, string>,
  skipModelDownload?: boolean,
): Promise<SectionResult> {
  write(output, '');
  write(
    output,
    '\u2500\u2500\u2500 Voice Transcription \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  );

  let voiceChoice = flags?.['voice'] ?? '';
  const modelChoice = flags?.['voice-model'] ?? '';

  if (!flags) {
    write(output, 'Enable voice transcription for voice messages?');
    write(output, '  1. OpenAI Whisper API ($0.006/min, no local resources needed)');
    write(output, '  2. Local whisper.cpp (free, fully offline, runs on your machine)');
    write(output, '  3. No voice transcription');
    const choice = await prompt(rl, '> ');
    if (choice === '1') voiceChoice = 'openai_whisper';
    else if (choice === '2') voiceChoice = 'whisper_cpp';
    else voiceChoice = 'none';
  }

  // Write voice config
  const configPath = resolve(configDir, 'config.yaml');
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed: unknown = parseYaml(raw);
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>;
  }

  if (voiceChoice === 'openai_whisper' || voiceChoice === 'whisper_cpp') {
    const stt: Record<string, unknown> = { provider: voiceChoice };
    const service: Record<string, unknown> = {
      enabled: true,
      ...((existing['service'] as Record<string, unknown>) ?? {}),
    };

    if (voiceChoice === 'openai_whisper') {
      let apiKey = flags?.['openai-key'] ?? '';

      if (!apiKey && !flags) {
        write(output, '');
        write(output, 'OpenAI Whisper API requires an OpenAI API key.');
        write(output, '  1. Go to https://platform.openai.com/api-keys');
        write(output, '  2. Click "Create new secret key"');
        write(output, '  3. Copy the key (starts with sk-)');
        write(output, '');
        apiKey = await prompt(rl, 'OpenAI API key: ');
      }

      if (apiKey) {
        const secretsDir = resolve(configDir, 'secrets');
        const credStore = new CredentialStore({ secretsDir });
        await credStore.ensureSecretsDir();
        await credStore.addCredential(
          'openai',
          'api.openai.com',
          'Authorization',
          `Bearer ${apiKey}`,
          { requests: 100, windowSeconds: 60 },
        );
        write(output, '\u2713 Voice transcription enabled (OpenAI Whisper API)');
        write(output, '  API key stored in encrypted credential vault');
      } else {
        write(output, '\u2713 Voice transcription enabled (OpenAI Whisper API)');
        write(output, '  Warning: No API key provided. Run `flowhelm setup voice` to add it.');
      }

      // OpenAI mode needs minimal resources
      service['memoryLimit'] = service['memoryLimit'] ?? '512m';
      service['cpuLimit'] = service['cpuLimit'] ?? '0.5';
    } else {
      // ── Local whisper.cpp: model selection ──────────────────────────────

      const defaultModel = WHISPER_MODELS[0] as WhisperModel;
      let selectedModel: WhisperModel;

      if (!modelChoice && !flags) {
        write(output, '');
        write(output, 'Choose a whisper model:');
        write(output, '');
        for (let i = 0; i < WHISPER_MODELS.length; i++) {
          const m = WHISPER_MODELS[i];
          if (!m) continue;
          write(output, `  ${i + 1}. ${m.name} (${m.sizeLabel})`);
          write(output, `     Quality: ${m.quality} | Speed: ${m.speed}`);
          write(output, `     Memory: ${m.memoryLimit} RAM | CPU: ${m.cpuLimit} cores`);
        }
        write(output, '');
        const mChoice = await prompt(rl, '> ');
        const mIdx = parseInt(mChoice, 10) - 1;
        selectedModel = WHISPER_MODELS[mIdx] ?? defaultModel;
      } else {
        // Non-interactive: match by name or default to small
        selectedModel = WHISPER_MODELS.find((m) => m.name === modelChoice) ?? defaultModel;
      }

      write(output, '');
      write(output, `Selected model: ${selectedModel.name} (${selectedModel.sizeLabel})`);

      // Auto-tune threads based on available CPU cores
      const hostCores = getAvailableCpuCores();
      const threads = clampThreads(selectedModel.threads, hostCores);

      // Download model if needed
      const modelsDir = resolve(configDir, 'models');
      const modelPath = resolve(modelsDir, selectedModel.filename);
      let modelExists = false;
      try {
        const s = await stat(modelPath);
        modelExists = s.size > selectedModel.sizeBytes * 0.9;
      } catch {
        /* not found */
      }

      if (modelExists) {
        write(output, `  Model already downloaded: ${modelPath}`);
      } else if (skipModelDownload || flags?.['skip-model-download']) {
        write(output, '  Skipped model download. Download manually:');
        write(output, `    curl -fSL -o ${modelPath} ${selectedModel.url}`);
      } else {
        write(output, `Downloading ${selectedModel.filename} (${selectedModel.sizeLabel})...`);
        write(output, 'This may take a few minutes depending on your connection.');
        await mkdir(modelsDir, { recursive: true });
        const downloaded = await downloadModel(selectedModel, modelPath, output);
        if (downloaded) {
          write(output, `  Model downloaded: ${modelPath}`);
        }
      }

      stt['modelPath'] = `/models/${selectedModel.filename}`;
      stt['threads'] = threads;
      stt['language'] = flags?.['language'] ?? 'en';

      // Auto-configure service container resources for the selected model
      service['memoryLimit'] = selectedModel.memoryLimit;
      service['cpuLimit'] = selectedModel.cpuLimit;

      write(output, '');
      write(output, '\u2713 Voice transcription enabled (local whisper.cpp)');
      write(output, `  Model:   ${selectedModel.name} (${selectedModel.sizeLabel})`);
      write(output, `  Memory:  ${selectedModel.memoryLimit} (auto-configured)`);
      write(output, `  CPU:     ${selectedModel.cpuLimit} cores (auto-configured)`);
      write(output, `  Threads: ${threads} (${hostCores} host cores detected)`);
    }

    service['stt'] = stt;
    existing['service'] = service;
  } else {
    existing['service'] = { enabled: false };
    write(output, '\u2713 Voice transcription disabled');
  }

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, stringifyYaml(existing), 'utf-8');

  return { name: 'Voice', completed: true, skipped: voiceChoice === 'none' };
}

async function runIdentitySection(
  rl: ReadlineInterface,
  output: NodeJS.WritableStream,
  configDir: string,
  flags?: Record<string, string>,
): Promise<SectionResult> {
  write(output, '');
  write(
    output,
    '\u2500\u2500\u2500 Identity \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  );

  let agentRole = flags?.['agent-role'] ?? '';
  let userName = flags?.['user-name'] ?? '';
  let timezone = flags?.['user-timezone'] ?? '';

  if (!flags) {
    write(output, "What should your agent's role be?");
    write(output, '  (e.g., "Personal assistant", "Executive assistant", "Research aide")');
    agentRole = await prompt(rl, '> ');

    write(output, '');
    userName = await prompt(rl, 'Your name (for personalized responses): ');
    timezone = await prompt(rl, 'Your timezone (e.g., Europe/Helsinki): ');
  }

  // Write identity to config (not DB — DB requires running orchestrator)
  const configPath = resolve(configDir, 'config.yaml');
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed: unknown = parseYaml(raw);
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>;
  }

  const identity: Record<string, unknown> = {};
  if (agentRole) identity['agentRole'] = agentRole;
  if (flags?.['agent-tone']) identity['agentTone'] = flags['agent-tone'];
  if (flags?.['agent-expertise']) identity['agentExpertise'] = flags['agent-expertise'];
  if (userName) identity['userName'] = userName;
  if (flags?.['user-role']) identity['userRole'] = flags['user-role'];
  if (timezone) identity['userTimezone'] = timezone;

  if (Object.keys(identity).length > 0) {
    existing['identity'] = identity;
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, stringifyYaml(existing), 'utf-8');
    write(output, '\u2713 Identity configured');
  }

  return { name: 'Identity', completed: true, skipped: !agentRole && !userName };
}

async function runSummarySection(
  rl: ReadlineInterface,
  output: NodeJS.WritableStream,
  configDir: string,
  runtimeMode: string,
  credentialMethod: string,
  flags?: Record<string, string>,
): Promise<SectionResult> {
  // Write runtime and credential method to config
  const configPath = resolve(configDir, 'config.yaml');
  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed: unknown = parseYaml(raw);
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>;
  }

  const agent = (existing['agent'] as Record<string, unknown>) ?? {};
  agent['runtime'] = runtimeMode;
  agent['credentialMethod'] = credentialMethod;
  existing['agent'] = agent;

  // Enable channel container if any channel is configured
  const channels = existing['channels'] as Record<string, unknown> | undefined;
  if (channels && Object.keys(channels).length > 0) {
    existing['channelContainer'] = { enabled: true };
  }

  // Derive username from system user
  const username = process.env['USER'] ?? 'default';
  const flowhelmUsername = username.replace(/^flowhelm-/, '');
  existing['username'] = flowhelmUsername;

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, stringifyYaml(existing), 'utf-8');

  write(output, '');
  write(
    output,
    '\u2500\u2500\u2500 Summary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  );
  write(
    output,
    `Runtime:        ${runtimeMode === 'sdk' ? 'Claude Agent SDK' : 'Claude Code CLI'}`,
  );
  write(
    output,
    `Auth:           ${credentialMethod === 'api_key' ? 'API key' : 'OAuth subscription'}`,
  );
  write(output, `Config saved:   ${configPath}`);
  write(output, '');

  if (!flags) {
    write(output, 'Start FlowHelm now? [Y/n]');
    const startChoice = await prompt(rl, '> ');
    if (startChoice.toLowerCase() !== 'n') {
      write(output, '');
      write(output, 'Starting FlowHelm...');
      if (platform() === 'darwin') {
        write(output, '  launchctl load ~/Library/LaunchAgents/ai.flowhelm.plist');
      } else {
        write(output, '  systemctl --user enable --now flowhelm.service');
      }
      write(output, '');
      write(output, 'Or start manually:');
      write(output, '  flowhelm start');
    }
  }

  return { name: 'Summary', completed: true, skipped: false };
}

// ─── Re-run detection ───────────────────────────────────────────────────────

async function handleRerun(
  rl: ReadlineInterface,
  output: NodeJS.WritableStream,
  configDir: string,
  dataDir: string,
  skipModelDownload?: boolean,
): Promise<SetupWizardResult | null> {
  const configPath = resolve(configDir, 'config.yaml');
  if (!existsSync(configPath)) return null;

  write(output, 'Existing configuration detected.');
  write(output, 'What would you like to change?');
  write(output, '  1. Authentication');
  write(output, '  2. Channels');
  write(output, '  3. Voice');
  write(output, '  4. Identity');
  write(output, '  5. Start fresh (reconfigure everything)');
  write(output, '  6. Exit');
  const choice = await prompt(rl, '> ');

  const sections: SectionResult[] = [];

  switch (choice) {
    case '1':
      sections.push(await runAuthSection(rl, output, configDir));
      break;
    case '2':
      sections.push(await runChannelsSection(rl, output, configDir, dataDir));
      break;
    case '3':
      sections.push(await runVoiceSection(rl, output, configDir, undefined, skipModelDownload));
      break;
    case '4':
      sections.push(await runIdentitySection(rl, output, configDir));
      break;
    case '5':
      return null; // Fall through to full wizard
    case '6':
      return { success: true, sections: [] };
    default:
      write(output, 'Invalid choice.');
      return { success: false, sections: [] };
  }

  return { success: sections.every((s) => s.completed), sections };
}

// ─── Main wizard ────────────────────────────────────────────────────────────

export async function runSetupWizard(options: SetupWizardOptions): Promise<SetupWizardResult> {
  const output = options.output ?? process.stdout;
  const rl =
    options.rl ??
    createInterface({
      input: process.stdin,
      output: options.output ?? process.stdout,
    });
  const configDir = options.configDir;
  const dataDir = options.dataDir;
  const flags = options.noInteractive ? options.flags : undefined;
  const sections: SectionResult[] = [];

  try {
    // Derive username for welcome message
    const username = (process.env['USER'] ?? 'user').replace(/^flowhelm-/, '');

    write(output, '');
    write(output, `Welcome to FlowHelm setup for user: ${username}`);

    // ── Platform & container runtime detection ──────────────────────────────
    let platformInfo: PlatformInfo;
    try {
      platformInfo = options.platformInfoOverride ?? detectPlatform();
    } catch {
      platformInfo = {
        os: platform() === 'darwin' ? 'darwin' : 'linux',
        runtime: 'podman',
        serviceManager: platform() === 'darwin' ? 'launchd' : 'systemd',
        binaryPath: 'podman',
        version: 'unknown',
      };
    }

    const runtimeLabel = platformInfo.runtime === 'apple_container' ? 'Apple Container' : 'Podman';
    const osLabel = platformInfo.os === 'darwin' ? 'macOS' : 'Linux';

    write(output, '');
    write(output, `Platform:          ${osLabel}`);
    write(output, `Container runtime: ${runtimeLabel} ${platformInfo.version}`);
    write(output, `Service manager:   ${platformInfo.serviceManager}`);

    // macOS + Podman: check podman machine
    if (platformInfo.os === 'darwin' && platformInfo.runtime === 'podman') {
      const machineState = getPodmanMachineState();
      if (machineState === 'running') {
        write(output, `Podman machine:    running`);
      } else if (machineState === 'stopped') {
        write(output, '');
        write(output, 'Warning: Podman machine is stopped. Start it before continuing:');
        write(output, '  podman machine start');
      } else {
        write(output, '');
        write(output, 'Warning: No Podman machine found. Initialize and start one:');
        write(output, '  podman machine init && podman machine start');
      }
    }

    // macOS + Apple Container: check IP forwarding
    if (platformInfo.runtime === 'apple_container') {
      write(output, '');
      write(output, 'Note: Apple Container requires IP forwarding for internet access.');
      write(output, '  Verify with: sysctl net.inet.ip.forwarding');
      write(output, '  Enable with: sudo sysctl -w net.inet.ip.forwarding=1');
    }

    write(output, '');

    // Re-run detection (only in interactive mode)
    if (!options.noInteractive) {
      const rerunResult = await handleRerun(
        rl,
        output,
        configDir,
        dataDir,
        options.skipModelDownload,
      );
      if (rerunResult !== null) return rerunResult;
    }

    // Section 1: Authentication
    sections.push(await runAuthSection(rl, output, configDir, flags));

    // Section 2: Runtime
    const {
      result: runtimeResult,
      runtime,
      credentialMethod,
    } = await runRuntimeSection(rl, output, configDir, flags);
    sections.push(runtimeResult);

    // Section 3: Channels
    sections.push(await runChannelsSection(rl, output, configDir, dataDir, flags));

    // Section 4: Voice
    sections.push(await runVoiceSection(rl, output, configDir, flags, options.skipModelDownload));

    // Section 5: Identity
    sections.push(await runIdentitySection(rl, output, configDir, flags));

    // Section 6: Summary
    sections.push(await runSummarySection(rl, output, configDir, runtime, credentialMethod, flags));

    return { success: sections.every((s) => s.completed || s.skipped), sections };
  } finally {
    if (!options.rl) rl.close();
  }
}

// ─── Standalone voice setup (for `flowhelm setup voice`) ───────────────────

export interface RunSetupVoiceOptions {
  rl: ReadlineInterface;
  output: NodeJS.WritableStream;
  configDir: string;
  flags?: Record<string, string>;
  skipModelDownload?: boolean;
}

/**
 * Run only the voice section of the setup wizard.
 * Used by `flowhelm setup voice` CLI subcommand.
 */
export async function runSetupVoice(options: RunSetupVoiceOptions): Promise<SectionResult> {
  return runVoiceSection(
    options.rl,
    options.output,
    options.configDir,
    options.flags,
    options.skipModelDownload,
  );
}
