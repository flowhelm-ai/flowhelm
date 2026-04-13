# Installation and Setup

## Overview

FlowHelm installation follows a two-actor model with clear separation of concerns:

| Actor | Stage | Command | Mode |
|---|---|---|---|
| Admin (root) | Install | `curl -fsSL https://flowhelm.ai/install.sh \| bash` | Non-interactive |
| Admin (root) | Initialize | `flowhelm admin init` | Non-interactive |
| Admin (root) | Add users | `flowhelm admin add-user <name> [flags]` | Non-interactive |
| User (SSH) | Configure | `flowhelm setup` | Interactive |

The install script and all admin commands are non-interactive. The only interactive step is `flowhelm setup`, which each user runs after SSH to configure their channels, credentials, and preferences.

## Why Non-Interactive Install

Products like Docker, Tailscale, and Claude Code use the same pattern: the install script is silent, configuration comes later. Admins installing system software want it done — not a questionnaire.

Interactive prompts during install are problematic because:
- They break automation (Terraform, Ansible, cloud-init user data scripts)
- The person installing (admin) is not the person configuring (user)
- Install decisions (what packages, where to put binaries) have safe defaults
- Configuration decisions (API keys, channels, voice) require user-specific knowledge the admin doesn't have

## Install Script (`install.sh`)

### One-Line Install

```bash
curl -fsSL https://flowhelm.ai/install.sh | bash
```

### What It Does

1. **Detect OS** — Ubuntu 24.04+ required. Fail with clear message on unsupported platforms.
2. **Check prerequisites** — Verify root/sudo access, internet connectivity, systemd.
3. **Install system packages** — Podman, slirp4netns, fuse-overlayfs, uidmap, crun, Node.js 22+.
4. **Install FlowHelm** — Download and install the `flowhelm` binary (npm global or standalone binary).
5. **Run `flowhelm admin init`** — Initialize system-level configuration, create `/etc/flowhelm/`, verify Podman rootless support.
6. **Print next steps** — Clear instructions for adding users.

### Properties

- **Non-interactive**: Zero prompts. All decisions use safe defaults.
- **Idempotent**: Safe to re-run. Skips already-installed packages, doesn't overwrite existing config.
- **Logged**: All output to stdout for debugging.
- **Exit codes**: 0 on success, non-zero with descriptive error message on failure.
- **No network after install**: The script itself needs network access, but after completion FlowHelm runs with outbound-only connections.

### Flags

```bash
# Defaults (equivalent to no flags)
curl -fsSL https://flowhelm.ai/install.sh | bash

# Skip flowhelm admin init (install packages and binary only)
curl -fsSL https://flowhelm.ai/install.sh | bash -s -- --no-init

# Specify a FlowHelm version
curl -fsSL https://flowhelm.ai/install.sh | bash -s -- --version 1.0.0

# Dry run (show what would be installed, don't execute)
curl -fsSL https://flowhelm.ai/install.sh | bash -s -- --dry-run

# Upgrade existing installation (updates binary + restarts services)
curl -fsSL https://flowhelm.ai/install.sh | bash -s -- --upgrade
```

### OS Support Matrix

| OS | Version | Container Runtime | Status |
|---|---|---|---|
| Ubuntu | 24.04 LTS | Podman rootless | Primary target (multi-tenant) |
| Ubuntu | 22.04 LTS | Podman rootless | Best effort |
| Debian | 12+ | Podman rootless | Best effort |
| macOS | Tahoe (26+), Apple Silicon | Apple Container | Supported (single-user) |
| macOS | Sequoia (15), Apple Silicon | Podman via `podman machine` | Supported (single-user) |
| macOS | Sonoma (14), Apple Silicon | Podman via `podman machine` | Best effort (single-user) |
| macOS | Any, Intel | Podman via `podman machine` | Best effort (single-user) |

### Example Output

```
[flowhelm] Detecting platform...
[flowhelm] OS: Ubuntu 24.04.1 LTS (x86_64)
[flowhelm] Installing system dependencies...
[flowhelm] ✓ podman 5.3.1
[flowhelm] ✓ slirp4netns 1.3.1
[flowhelm] ✓ fuse-overlayfs 1.14
[flowhelm] ✓ Node.js 22.12.0
[flowhelm] Installing FlowHelm v1.0.0...
[flowhelm] ✓ flowhelm installed to /usr/local/bin/flowhelm
[flowhelm] Running flowhelm admin init...
[flowhelm] ✓ /etc/flowhelm/ created
[flowhelm] ✓ Podman rootless support verified
[flowhelm]
[flowhelm] Installation complete.
[flowhelm]
[flowhelm] Next steps:
[flowhelm]   1. Add a user:    flowhelm admin add-user mark --ssh-key ~/.ssh/mark.pub
[flowhelm]   2. User logs in:  ssh flowhelm-mark@<this-vm>
[flowhelm]   3. User runs:     flowhelm setup
```

## Admin Commands

### `flowhelm admin init`

First-time VM initialization. Run automatically by install.sh, but can be run manually.

```bash
flowhelm admin init
```

What it does:
- Creates `/etc/flowhelm/` system config directory
- Verifies Podman rootless support (`podman info --format '{{.Host.Security.Rootless}}'`)
- Verifies cgroups v2 is active
- Verifies Node.js 22+ is available
- Creates the FlowHelm port registry (tracks allocated ports per user)
- Idempotent — safe to re-run

### `flowhelm admin add-user <name>`

Provisions a fully isolated user environment. Non-interactive — all options via flags.

```bash
flowhelm admin add-user mark --ssh-key ~/.ssh/mark.pub
flowhelm admin add-user evie --ssh-key ~/.ssh/evie.pub --ram-limit 4G --cpu-limit 2
```

What it does:
1. Creates Linux user `flowhelm-mark` with home directory
2. Allocates UID/GID sub-ranges (65536 IDs per user)
3. Enables systemd lingering (`loginctl enable-linger`)
4. Initializes Podman for the user (`podman system migrate`)
5. Creates per-user Podman network (`flowhelm-network-mark`)
6. Generates systemd user service (`flowhelm-mark.service`)
7. Allocates ports from the port registry
8. Adds SSH public key to `~/.ssh/authorized_keys`
9. Prints SSH connection instructions

Flags:

| Flag | Default | Description |
|---|---|---|
| `--ssh-key <path>` | (required) | Path to user's SSH public key |
| `--ram-limit <size>` | `4G` | Per-user memory limit |
| `--cpu-limit <cores>` | `2` | Per-user CPU limit |
| `--max-agents <n>` | `5` | Max concurrent agent containers |
| `--agent-runtime <mode>` | `cli` | Agent runtime: `cli` or `sdk` |

### `flowhelm admin remove-user <name>`

Remove a user with optional data archiving.

```bash
flowhelm admin remove-user mark --archive    # Archive data before removal
flowhelm admin remove-user mark --force      # Remove without archiving
```

What it does:
1. Stops all user containers (agents + proxy)
2. Stops and disables systemd service
3. Archives user data to `/var/backup/flowhelm/mark-<date>.tar.gz` (if `--archive`)
4. Removes Podman network, images, volumes
5. Removes Linux user and home directory
6. Frees port allocations

## User Setup (`flowhelm setup`)

The only interactive step. Run by each user after SSH login.

```bash
ssh flowhelm-mark@vm.example.com
flowhelm setup
```

### Interactive Flow

```
Welcome to FlowHelm setup for user: mark

─── Authentication ───────────────────────────────────
How would you like to authenticate with Claude?
  1. API key (recommended for always-on operation)
  2. Subscription OAuth (Pro/Max plan, requires browser)
> 1
Enter your Anthropic API key: sk-ant-***
✓ API key verified

─── Channels ─────────────────────────────────────────
Which channels would you like to enable?
  [x] Telegram (recommended)
  [ ] WhatsApp
  [ ] Gmail notifications
> 1

Enter your Telegram bot token (from @BotFather): 123:ABC***
✓ Bot connected: @stan_flowhelm_bot
Enter allowed Telegram user IDs (comma-separated): 12345678
✓ Access restricted to 1 user(s)

─── Voice ────────────────────────────────────────────
Enable voice transcription for voice notes?
  1. Yes, OpenAI Whisper API ($0.006/min, recommended)
  2. Yes, local whisper.cpp (free, slower)
  3. No
> 1
Enter your OpenAI API key: sk-***
✓ Whisper API verified

─── Summary ──────────────────────────────────────────
Authentication:  API key
Channels:        Telegram (@stan_flowhelm_bot)
Voice:           OpenAI Whisper API
Config saved to: ~/.flowhelm/config.yaml

Starting FlowHelm...
✓ Credential proxy container running
✓ Orchestrator started
✓ Telegram connected

FlowHelm is ready. Send a message to @stan_flowhelm_bot to begin.
```

### Voice Setup

Voice transcription can be configured during the main setup wizard or standalone via `flowhelm setup voice`:

```bash
flowhelm setup voice
```

This subcommand walks through:
1. **Provider selection**: OpenAI Whisper API, local whisper.cpp, or no voice transcription
2. **Model selection** (whisper.cpp only): `small` (466 MB, fast) or `large-v3-turbo` (1.6 GB, best accuracy)
3. **Auto-download**: Downloads the selected GGML model file to `~/.flowhelm/models/`
4. **Auto-configured resources**: Sets service container memory limit, CPU limit, and whisper.cpp thread count based on the selected model and available system resources

Non-interactive mode:

```bash
flowhelm setup --voice whisper_cpp --voice-model small --no-interactive
flowhelm setup --voice whisper_cpp --voice-model large-v3-turbo --no-interactive
flowhelm setup --voice openai_whisper --openai-key sk-... --no-interactive
```

See `docs/voice-pipeline.md` for full model comparison and memory requirements.

### Gmail Setup

Gmail is configured separately via `flowhelm setup gmail`:

```bash
flowhelm setup gmail \
  --email user@gmail.com \
  --oauth-client-id 308771... \
  --oauth-client-secret GOCSPX-... \
  --oauth-refresh-token 1//04... \
  --gcp-project my-project \
  --transport pubsub \
  --notification-channel telegram \
  --service-account-key '{"type":"service_account",...}'
```

**Service account key**: The `--service-account-key` flag accepts either a file path or inline JSON content (auto-detected). In the interactive wizard, you can paste the full JSON content directly — no need to save it to a file first (ADR-065). The key is stored in the encrypted vault, never in config.yaml.

### Non-Interactive Mode

For automation, `flowhelm setup` also accepts flags:

```bash
flowhelm setup \
  --anthropic-key sk-ant-... \
  --telegram-token 123:ABC \
  --telegram-users 12345678 \
  --voice openai_whisper \
  --openai-key sk-... \
  --no-interactive
```

### Re-Running Setup

`flowhelm setup` is safe to re-run. It detects existing configuration and offers to modify specific sections rather than starting from scratch:

```
Existing configuration detected.
What would you like to change?
  1. Authentication
  2. Channels
  3. Voice
  4. Start fresh
  5. Exit
>
```

## Automation / Cloud-Init

The entire flow can be scripted for infrastructure-as-code:

```bash
#!/bin/bash
# cloud-init user data or Terraform provisioner

# Install FlowHelm
curl -fsSL https://flowhelm.ai/install.sh | bash

# Add user (non-interactive)
flowhelm admin add-user mark --ssh-key /tmp/mark.pub --ram-limit 4G

# Configure user (non-interactive, as the user)
sudo -u flowhelm-mark flowhelm setup \
  --anthropic-key "$ANTHROPIC_API_KEY" \
  --telegram-token "$TELEGRAM_BOT_TOKEN" \
  --telegram-users "$TELEGRAM_USER_ID" \
  --no-interactive
```

This enables full GitOps workflows: OpenTofu provisions the VM, cloud-init runs the install, and the user's agent is operational without any manual SSH.

## Diagnostic Commands

### `flowhelm doctor`

Run diagnostic checks to verify the installation:

```bash
flowhelm doctor
flowhelm doctor --verbose
```

Checks are platform- and runtime-aware. On Linux, doctor checks Podman, systemd, cgroups, and `/etc/flowhelm`. On macOS, it checks the detected runtime (Apple Container or Podman) plus Podman machine status, launchd service, and macOS version. See `docs/apple-container.md` for the full macOS check list.

Each check reports `[OK]`, `[WARN]`, or `[FAIL]` with fix suggestions.

### `flowhelm status`

Show current system state:

```bash
flowhelm status          # Human-readable
flowhelm status --json   # Machine-readable
```

Shows: version, orchestrator state, running containers, auth health (token type, expiry), and (admin mode) user list with resource usage.

### `flowhelm auth status`

Check authentication health in detail:

```bash
flowhelm auth status
```

Shows: configured auth methods (OAuth, API key), token expiry dates, days remaining, subscription type. Warns at 30 days before OAuth token expiry.

### `flowhelm auth switch`

Switch the active authentication method:

```bash
flowhelm auth switch oauth      # Switch to OAuth
flowhelm auth switch api_key    # Switch to API key
```

Validates that the target auth method is configured and not expired before switching. Updates `~/.flowhelm/config.yaml`. Requires service restart to take effect.

### `flowhelm admin backup` / `flowhelm admin restore`

Per-user backup and restore:

```bash
# Create a backup
flowhelm admin backup mark

# List available backups
flowhelm admin backup --list mark

# Restore from a backup
flowhelm admin restore mark --from /var/backup/flowhelm/flowhelm-mark-20260410-143022.tar.gz
```

Backup archive contents: PostgreSQL dump, `config.yaml`, `secrets/` directory, `skills/installed.json`. Archives stored in `/var/backup/flowhelm/`. See @docs/deployment.md for cron examples.

## macOS Install

FlowHelm supports macOS as a single-user personal deployment. The install script auto-detects the best runtime.

### One-Line Install (macOS)

```bash
curl -fsSL https://flowhelm.ai/install.sh | bash
```

### What Happens on macOS

The install script detects the macOS version and CPU architecture:

**macOS Tahoe (26+) + Apple Silicon:**
1. Install Node.js 22+ via Homebrew
2. Check for Apple Container CLI (prompt to install from GitHub releases if missing)
3. Install FlowHelm via npm
4. Print `flowhelm setup` instructions

**macOS pre-Tahoe (15, 14) or Intel:**
1. Install Node.js 22+ via Homebrew
2. Install Podman via Homebrew (`brew install podman`)
3. Initialize Podman machine (`podman machine init`)
4. Start Podman machine (`podman machine start`)
5. Install FlowHelm via npm
6. Print `flowhelm setup` instructions

### macOS Example Output (Pre-Tahoe)

```
[flowhelm] OS: macOS 15.7.1 (arm64) [pre-Tahoe, Podman fallback]
[flowhelm] Homebrew found: /opt/homebrew
[flowhelm] Node.js v22.12.0 already installed (>= 22)
[flowhelm] Podman 5.8.1 already installed (>= 4.x)
[flowhelm] Podman machine already running
[flowhelm] Installing FlowHelm (latest)...
[flowhelm] FlowHelm 1.0.0 installed to /opt/homebrew/bin/flowhelm
[flowhelm]
[flowhelm] Installation complete.
[flowhelm]
[flowhelm] Installed:
[flowhelm]   Node.js:          v22.12.0
[flowhelm]   FlowHelm:         1.0.0
[flowhelm]   Podman:           5.8.1
[flowhelm]   Podman machine:   podman-machine-default (true)
[flowhelm]
[flowhelm] Next steps:
[flowhelm]   1. Run:  flowhelm setup
[flowhelm]   2. Run:  flowhelm doctor
```

### Setup Wizard on macOS

`flowhelm setup` detects the runtime and shows relevant guidance:

```
Welcome to FlowHelm setup for user: mark

Platform:          macOS
Container runtime: Podman 5.8.1
Service manager:   launchd
Podman machine:    running

─── Authentication ─────────────────────────────────
...
```

On macOS, `flowhelm setup` skips `flowhelm admin init` (Linux multi-tenant only) and shows `launchctl` commands instead of `systemctl`.

See `docs/apple-container.md` for full macOS runtime details and troubleshooting.

## Upgrade Path

```bash
# Admin upgrades FlowHelm binary
curl -fsSL https://flowhelm.ai/install.sh | bash -s -- --upgrade

# Or via npm
npm update -g flowhelm

# Linux: per-user services restart automatically via systemd
# macOS: launchd service restarts via `launchctl kickstart`
# No user action required for minor/patch versions
```

For major versions with breaking changes, `flowhelm admin upgrade` will handle migrations.
