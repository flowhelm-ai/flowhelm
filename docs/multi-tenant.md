# Multi-Tenant Admin Orchestrator

## Why Multi-Tenancy Is FlowHelm's Moat

Most AI agent orchestrators are single-user. Multi-agent alternatives that share one process have documented session isolation failures. FlowHelm solves multi-tenancy from first principles: each user gets their own Linux user, Podman rootless instance with separate UID namespaces, credential proxy container, PostgreSQL database container, systemd service, and three-tier memory system. No shared daemon. No shared state. No shared credentials.

Target: friends sharing a VPS, small teams, university lab groups, freelancers.

## Trust Model

- **Admin trusts users** not to be actively malicious (friend/team tool, not SaaS)
- **Users trust admin** (admin has root on VM)
- **System enforces**: data isolation, credential isolation, resource limits, container namespace separation
- **System does NOT protect against**: malicious admin, kernel exploits

## Admin CLI

```bash
flowhelm admin init                              # First-time VM setup
flowhelm admin add-user <name> [options]         # Provision isolated user
flowhelm admin remove-user <name> --archive      # Remove with data archive
flowhelm admin status                            # Resource dashboard
flowhelm admin set-limits <name> --ram-limit 4G  # Live limit change
flowhelm admin restart <name>                    # Per-user restart
flowhelm admin logs <name> [--tail 100]          # Per-user logs
```

## User Onboarding

```
1. Admin: flowhelm admin add-user mark --ssh-key ~/.ssh/mark.pub
2. System creates: Linux user flowhelm-mark, home dir, sub-UIDs, Podman init,
   Podman network flowhelm-network-mark, systemd service, port allocation
3. Mark SSHs in → runs: flowhelm setup
4. Interactive config: Telegram bot, Gmail, voice, API key
5. Identity setup: flowhelm setup identity --agent-role "..." --user-name "..."
6. Agent starts via systemd. Proxy container launches.
```

### Identity Setup (Step 5)

After channel configuration, users set up their agent's identity and their own profile. This fills the `agent_identity`, `agent_personality`, `user_identity`, and `user_personality` tables so the agent has a persona and knows who it's serving from the first message.

```bash
# During initial setup
flowhelm setup identity \
  --agent-role "Personal assistant" \
  --agent-tone "Friendly, concise" \
  --agent-expertise "email,scheduling,research" \
  --user-name "Mark Johnson" \
  --user-role "CTO" \
  --user-timezone "Europe/Helsinki"

# Or configure later via CLI
flowhelm identity agent set --role "Personal assistant" --tone "Friendly"
flowhelm personality agent set --dimension communication_style --content "Concise, bullet points"

# Or configure from any connected channel (zero token cost)
/identity set agent role=Personal assistant
/identity set user name=Mark
/personality set agent communication_style=Concise, bullet points
```

If identity is not configured at setup time, the agent still functions — it just lacks a defined persona. On the first channel message, the agent's response includes a prompt: "I don't have a configured persona yet. You can set one with `/identity set agent role=...`". See `docs/memory.md` for the full identity layer documentation.

## Implementation

The admin CLI is implemented as four modular components (ADR-056):

| Module | File | Purpose |
|---|---|---|
| Port Registry | `src/admin/port-registry.ts` | JSON file-based port allocation (`/etc/flowhelm/ports.json`), sequential blocks of 10 ports per user |
| Service Generator | `src/admin/service-generator.ts` | Systemd user unit files (`~/.config/systemd/user/flowhelm.service`) |
| Resource Limits | `src/admin/resource-limits.ts` | Read/set per-user cgroups v2 limits via `systemctl set-property` |
| User Manager | `src/admin/user-manager.ts` | Full user lifecycle: Linux user, sub-UID, Podman, network, systemd, SSH |
| Admin CLI | `src/admin/cli.ts` (admin section) | CLI dispatch for all `flowhelm admin` commands |

### Port Allocation

Each user gets 10 sequential ports from a configurable base (default: 10000):

| Offset | Service | Example (user 1) | Example (user 2) |
|---|---|---|---|
| +0 | Proxy | 10000 | 10010 |
| +1 | Channel | 10001 | 10011 |
| +2 | Service | 10002 | 10012 |
| +3 | Database | 10003 | 10013 |
| +4-9 | Reserved | 10004-10009 | 10014-10019 |

The registry at `/etc/flowhelm/ports.json` tracks allocations and detects conflicts.

### Files

| File | Purpose |
|---|---|
| `src/admin/port-registry.ts` | PortRegistry class |
| `src/admin/service-generator.ts` | ServiceGenerator functions |
| `src/admin/resource-limits.ts` | cgroups v2 resource management |
| `src/admin/user-manager.ts` | UserManager class |
| `src/admin/cli.ts` | All CLI commands (skills, identity, setup, admin) |
| `tests/admin.test.ts` | 62 tests for admin modules |
| `tests/cli-identity.test.ts` | 44 tests for identity/personality/setup CLI |

## Resource Planning

| Users | Minimum VM | Recommended VM |
|---|---|---|
| 1 | 2 vCPU, 4 GB RAM, 30 GB SSD | 4 vCPU, 8 GB RAM, 50 GB SSD |
| 2 | 4 vCPU, 8 GB RAM, 50 GB SSD | 4 vCPU, 8 GB RAM, 80 GB SSD |
| 3-4 | 8 vCPU, 16 GB RAM, 80 GB SSD | 8 vCPU, 16 GB RAM, 160 GB SSD |
| 5+ | Separate VMs recommended | — |

Per-user idle: ~550-580 MB (orchestrator ~300 MB incl. embedding model + proxy ~20 MB + PostgreSQL ~100-130 MB + Podman overhead ~50 MB). Active: ~1.1-1.6 GB (add agent container ~500 MB-1 GB). See the resource budget table in @docs/implementation-plan.md.

Podman adds zero daemon overhead when idle — no always-running process consuming memory.
