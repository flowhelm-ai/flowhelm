# Podman Isolation Model

## Why Podman Is FlowHelm's Core Differentiator

Docker requires a root daemon (`dockerd`) that manages all containers for all users through a single process. A compromise of the Docker daemon compromises every container on the machine. Multi-tenant setups on Docker are fundamentally limited because every user's containers funnel through one shared, privileged process.

Podman eliminates this entirely. There is no daemon. Each Podman command is an independent process running as the invoking user. Each user's Podman instance operates with:
- Its own UID namespace (separate user ID ranges)
- Its own image storage (`~/.local/share/containers/`)
- Its own network namespace
- Its own cgroups slice

One user literally cannot see, list, inspect, or affect another user's containers at the OS level. This is not application-level isolation — it is kernel-enforced.

## Docker vs Podman: Detailed Comparison

### Architecture
```
Docker:
  All users → dockerd (root, PID 1-ish) → containers
  Single point of failure. Shared state. Privilege escalation path.

Podman:
  User A → podman (UID 1001) → containers (UID 100000-165535)
  User B → podman (UID 1002) → containers (UID 165536-231071)
  Completely independent. No shared state. No daemon to attack.
```

### Security Properties

| Property | Docker | Podman |
|---|---|---|
| Root daemon | Yes (dockerd runs as root) | No daemon at all |
| Default container UID | Root inside container | Mapped to unprivileged UID |
| User namespace isolation | Opt-in, complex config | Default, automatic |
| SELinux integration | Manual configuration | Automatic enforcement |
| Capability set | Broad by default | Minimal by default |
| Socket exposure | /var/run/docker.sock (root) | Per-user socket or none |
| Container escape impact | Root on host | Unprivileged user only |

### Multi-Tenant Properties

| Property | Docker | Podman |
|---|---|---|
| Container visibility | All users see all containers via daemon | Each user sees only their own |
| Image storage | Shared /var/lib/docker | Per-user ~/.local/share/containers |
| Network namespace | Shared daemon network | Per-user network namespace |
| Volume mounts | Any user can mount any path via daemon | Restricted to user's own permissions |
| Resource limits | Applied per-container via daemon | Applied per-user via cgroups v2 slice |
| Daemon crash | All containers die | No daemon to crash |

### Resource Efficiency

Docker's daemon consumes 100-300 MB RAM continuously, even when no containers are running. On a 4-user VPS with 8 GB RAM, that's 2-4% of total memory wasted on infrastructure.

Podman uses zero resources when idle. The `podman` binary runs only during container operations. Between operations, nothing is running. On a shared VPS hosting four people's agents, the server is genuinely quiet when agents are idle.

## FlowHelm Podman Configuration

### Per-User Setup (automated by `flowhelm admin add-user`)

```bash
# 1. Create user with subuid/subgid ranges
useradd --create-home \
        --shell /bin/bash \
        --home-dir /home/flowhelm-${USERNAME} \
        flowhelm-${USERNAME}

# 2. Allocate UID/GID sub-ranges (65536 IDs per user)
usermod --add-subuids ${SUBUID_START}-${SUBUID_END} flowhelm-${USERNAME}
usermod --add-subgids ${SUBGID_START}-${SUBGID_END} flowhelm-${USERNAME}

# 3. Enable lingering (allows user services to run without login)
loginctl enable-linger flowhelm-${USERNAME}

# 4. Initialize Podman for the user (runs as the user)
sudo -u flowhelm-${USERNAME} podman system migrate
```

### Container Launch Pattern

```bash
# Runs as flowhelm-mark (never root)
podman run \
  --name flowhelm-agent-mark-${TASK_ID} \
  --userns=keep-id:uid=1000,gid=1000 \
  --memory ${RAM_LIMIT} \
  --cpus ${CPU_LIMIT} \
  --pids-limit 256 \
  --read-only \
  --tmpfs /tmp:size=500m \
  --volume /home/flowhelm-mark/.flowhelm/agent:/workspace:Z \
  --env ANTHROPIC_API_KEY \
  --security-opt label=type:container_runtime_t \
  --security-opt no-new-privileges \
  flowhelm-agent:latest
```

Key flags:
- `--userns=keep-id:uid=1000,gid=1000`: maps the host user's UID/GID to container UID/GID 1000 (`node` user). This works for any host UID — the first user (UID 1000), second user (UID 1001), etc. — because the mapping target is explicit. See ADR-063 for why `keep-id` without the qualifier fails for non-first users.
- `--read-only`: container filesystem is immutable
- `--tmpfs /tmp`: writable scratch space with size limit
- `:Z`: SELinux relabeling for bind mounts
- `--security-opt no-new-privileges`: prevents privilege escalation
- `--security-opt label=type:container_runtime_t`: SELinux confinement

### Compliance Implications

**PCI-DSS**: Requires justification for root-level processes. Rootless Podman eliminates this — there are no root-level container processes to audit. The only root process is the admin CLI, which is run manually and does not handle data.

**SOC 2**: Requires access controls and separation of duties. Per-user UID namespaces provide cryptographic-grade separation at the kernel level. Audit logs per user are trivially isolated.

**HIPAA**: Requires technical safeguards for PHI. Podman's namespace isolation ensures that even a compromised container cannot access another user's health data. No shared daemon means no shared attack surface.

## Apple Container (macOS)

On macOS with Apple Silicon, FlowHelm uses Apple Container instead of Podman. Apple Container provides:
- Native macOS virtualization framework
- Lightweight VM-based isolation
- Apple Silicon optimization
- No Docker daemon dependency

The `src/container/runtime.ts` abstract interface ensures the orchestrator doesn't know which runtime is active. Both Podman and Apple Container implement the same lifecycle methods: `create()`, `start()`, `stop()`, `remove()`, `exec()`, `logs()`.

```typescript
// src/container/runtime.ts
export interface ContainerRuntime {
  create(config: ContainerConfig): Promise<ContainerId>;
  start(id: ContainerId): Promise<void>;
  stop(id: ContainerId, timeout?: number): Promise<void>;
  remove(id: ContainerId): Promise<void>;
  exec(id: ContainerId, command: string[]): Promise<ExecResult>;
  logs(id: ContainerId, tail?: number): Promise<string>;
  isHealthy(id: ContainerId): Promise<boolean>;
}
```

Runtime selection is automatic based on platform detection at startup.

## Installation Requirements

### Linux
```bash
# Ubuntu 24.04
sudo apt install -y podman podman-compose slirp4netns fuse-overlayfs
# Verify rootless support
podman info --format '{{.Host.Security.Rootless}}'
# Should output: true
```

### macOS
```bash
# Requires macOS Tahoe (26) or later
# Apple Container is built into macOS — no installation needed
```
