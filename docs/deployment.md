# Deployment

## VM Requirements

**Minimum (1 user):** 2 vCPU, 4 GB RAM, 30 GB SSD, Ubuntu 24.04 LTS
**Recommended (2 users):** 4 vCPU, 8 GB RAM, 50 GB SSD, Ubuntu 24.04 LTS

ARM VMs (Ampere, Graviton) are supported and often cheaper. Any provider that runs Ubuntu 24.04 with Podman works.

**macOS (development):** Apple Silicon M1+, 8 GB RAM minimum, macOS Tahoe (26) for Apple Container.

## Installation

One-line install on a fresh Ubuntu 24.04 VM:

```bash
curl -fsSL https://flowhelm.ai/install.sh | bash
```

This installs all dependencies (Podman, Node.js 22+, etc.), the FlowHelm binary, and runs `flowhelm admin init`. Non-interactive, idempotent, safe to re-run.

After install, add users and they run `flowhelm setup` via SSH. See @docs/installation.md for the full installation and onboarding flow.

## Always-On Operation

Each user gets a systemd service (`flowhelm-{username}.service`) with `Restart=always`. The orchestrator manages the credential proxy container and spawns agent containers on demand.

## Crash Recovery

**Process crash:** systemd restarts in 10s. Channels reconnect. PostgreSQL queue retains messages (crash recovery resets stuck `processing` → `pending`). Database and proxy containers survive (independent lifecycle).

**Proxy container crash:** Orchestrator detects via health check, restarts proxy. Agent tasks queue until proxy is healthy.

**Agent container crash:** Orchestrator re-queues the message, notifies user "⚠️ Task failed, retrying..."

**VM restart:** systemd starts all services. Podman has no daemon to start. Proxy containers relaunch. Gmail Pub/Sub reconnects and delivers queued notifications.

No human intervention needed with API key auth. Subscription OAuth may require manual re-auth after extended downtime.

## Session Persistence

Warm agent containers with `podman exec` (ADR-008). Session files live in the container filesystem during warm lifetime. PostgreSQL backs up session state asynchronously after each message for crash recovery and cold restarts. Three-tier cognitive memory provides persistent long-term recall across all sessions (crash-safe, transactional, semantically searchable). See @docs/memory.md and @docs/sessions.md.

## Health Monitoring

The orchestrator runs a `HealthMonitor` (`src/orchestrator/health.ts`) that periodically checks each component (proxy, DB, channels, service). On failure:

- **Exponential backoff**: `interval = min(base × 2^failures, maxBackoff)` prevents CPU waste on broken components
- **Auto-restart**: attempts restart up to 3 times per component
- **Gate dispatch**: orchestrator checks `healthMonitor.isHealthy('proxy')` before dequeuing agent tasks — messages stay queued until recovery
- **Recovery detection**: resets to base interval on successful health check after failure

Default: 30s base interval, 5 min max backoff, multiplier 2.

## Multi-User Operation

Multiple users run simultaneously on a single VM. Each user has:
- Dedicated Linux user (`flowhelm-{name}`) with unique UID and sub-UID/GID range
- Isolated Podman rootless runtime — one user's containers are invisible to another
- Separate credential vault, database, and Podman network
- Per-user systemd service (`flowhelm.service`) with independent crash recovery
- Port allocation via `/etc/flowhelm/ports.json` (10 ports per user from base 10000)

**Container UID mapping**: All containers use `--userns=keep-id:uid=1000,gid=1000` (ADR-063) to map any host UID to container UID 1000 (`node` user). This is critical for multi-tenant — without the explicit UID qualifier, bind mounts are unreadable for users with host UID != 1000.

**Per-user resource usage** (4 containers per user):
- Proxy: 128 MB RAM, 0.25 CPU
- PostgreSQL: 256 MB RAM, 0.5 CPU
- Channel: 256 MB RAM, 0.5 CPU
- Service (STT): 2 GB RAM, 2.0 CPU
- Total per user: ~2.6 GB RAM, 3.25 CPU (service is the heaviest)

**Important constraints** for multi-user:
- Each user needs their own Telegram bot token (Telegram allows only one `getUpdates` connection per bot)
- If using Gmail Pub/Sub, each user needs a separate subscription (shared subscriptions split messages)
- GCP OAuth consent screens in "Testing" mode auto-revoke refresh tokens after 7 days — users must publish to production for persistent tokens

## Backups

### CLI Commands

```bash
# Create a backup for a user
flowhelm admin backup mark

# List available backups
flowhelm admin backup --list mark

# Restore from a backup
flowhelm admin restore mark --from /var/backup/flowhelm/flowhelm-mark-20260410-143022.tar.gz
```

Backup archive contents:
- PostgreSQL dump (`pg_dump` via `podman exec flowhelm-db-{user}`)
- `~/.flowhelm/config.yaml`
- `~/.flowhelm/secrets/` (credentials.enc, vault key)
- `~/.flowhelm/skills/installed.json`

Archives are stored in `/var/backup/flowhelm/` as `flowhelm-{name}-{YYYYMMDD-HHMMSS}.tar.gz`.

### Manual / Cron

```bash
# Daily cron: backup all users
for user in /home/flowhelm-*/; do
  username=$(basename "$user" | sed 's/flowhelm-//')
  flowhelm admin backup "$username"
done
# Weekly: VM snapshots via your provider's snapshot feature
```
