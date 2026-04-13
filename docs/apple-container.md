# macOS Container Runtimes

FlowHelm auto-selects the best container runtime for each macOS version. No user configuration needed.

## Runtime Selection

| macOS Version | CPU | Runtime | How it Works |
|---|---|---|---|
| Tahoe (26+) | Apple Silicon | **Apple Container** | Native VMs via Virtualization.framework |
| Sequoia (15), Sonoma (14) | Apple Silicon | **Podman** | Linux VM via `podman machine` (Apple Hypervisor) |
| Sequoia (15), Sonoma (14) | Intel | **Podman** | Linux VM via `podman machine` (QEMU) |

`install.sh` detects the macOS version and installs the correct runtime. `detectPlatform()` selects the runtime at startup. `flowhelm doctor` validates the active runtime. The `ContainerRuntime` interface ensures all FlowHelm code is runtime-agnostic — the orchestrator, lifecycle manager, proxy, database, channels, service container, and agent runtime all work identically on either runtime.

See ADR-068 (Apple Container) and ADR-069 (Dual-Runtime Strategy) in `docs/decisions.md`.

## Podman on macOS (Pre-Tahoe Fallback)

For macOS 14-15 (Sonoma, Sequoia), FlowHelm uses Podman with `podman machine`. This runs a Fedora CoreOS Linux VM under the hood — all Podman commands execute inside the VM, which provides SELinux, cgroups v2, rootless UID mapping, and named networks identically to Linux.

### Requirements (Podman path)

| Requirement | Minimum |
|---|---|
| macOS | 14+ (Sonoma) |
| CPU | Apple Silicon or Intel |
| Podman | 4.x+ (`brew install podman`) |
| Node.js | 22+ |

### Installation (Podman path)

```bash
# install.sh handles this automatically, or manually:
brew install podman
podman machine init
podman machine start

# Verify
podman machine list          # Should show "Currently running"
podman info --format '{{.Host.Security.Rootless}}'   # Should be "true"
podman info --format '{{.Host.Security.SELinuxEnabled}}'  # Should be "true"
```

### How Podman Machine Works

`podman machine` manages a lightweight Linux VM using Apple's Hypervisor.framework (on Apple Silicon) or QEMU (on Intel). The VM runs Fedora CoreOS with:

- **SELinux enabled** — `:Z` mount labels work correctly
- **cgroups v2** — resource limits are enforced
- **Rootless mode** — containers run as non-root inside the VM
- **virtiofs mounts** — host directories are shared transparently
- **Port forwarding** — published ports are forwarded to localhost

From FlowHelm's perspective, Podman on macOS behaves identically to Podman on Linux. The `PodmanRuntime` class is used for both — no conditional code paths.

### Diagnostics (Podman path)

`flowhelm doctor` on macOS with Podman checks:

| Check | What it verifies |
|---|---|
| Podman | Version 4.x+ installed |
| Podman rootless | Rootless mode active |
| Podman machine | VM initialized and running |
| macOS version | Detected version (warns pre-Tahoe) |
| Apple Silicon | arm64 architecture |
| launchd service | `ai.flowhelm` loaded |
| Config file | `~/.flowhelm/config.yaml` exists |
| Credential vault | `~/.flowhelm/secrets/credentials.enc` exists |
| Auth tokens | OAuth/API key validity |

## Apple Container on macOS (Tahoe+ Default)

For macOS 26+ (Tahoe) with Apple Silicon, FlowHelm uses Apple Container — native VM-based isolation via the Virtualization.framework. No Docker Desktop, no Podman machine, no Linux VM overhead.

### Requirements (Apple Container path)

| Requirement | Minimum |
|---|---|
| macOS | Tahoe (26+) |
| CPU | Apple Silicon (M1+) |
| Apple Container CLI | Installed from [apple/container releases](https://github.com/apple/container/releases) |
| Node.js | 22+ |

## Architecture

Apple Container runs each OCI container image in its own lightweight VM via the macOS Virtualization framework. This provides stronger isolation than Linux namespaces (Podman) since each container has its own kernel.

### Networking (vmnet)

All containers share a vmnet bridge network on the `192.168.64.0/24` subnet:

- **Bridge interface**: `bridge100` (created automatically when a container starts)
- **Host gateway**: `192.168.64.1` (the Mac's IP on the bridge)
- **Container IPs**: Assigned by DHCP from the vmnet pool

Unlike Podman, Apple Container does not support named user-defined networks. FlowHelm's network operations (`createNetwork`, `removeNetwork`, `networkExists`) are no-ops on macOS — the vmnet bridge handles all container connectivity.

### Internet Access (NAT)

Containers need IP forwarding and NAT to reach the internet:

```bash
# Enable IP forwarding
sudo sysctl -w net.inet.ip.forwarding=1

# Make persistent
echo "net.inet.ip.forwarding=1" | sudo tee -a /etc/sysctl.conf

# Add NAT rule
echo "nat on en0 from 192.168.64.0/24 to any -> (en0)" | sudo pfctl -ef -

# Make NAT persistent
echo "# FlowHelm Apple Container NAT" | sudo tee -a /etc/pf.conf
echo "nat on en0 from 192.168.64.0/24 to any -> (en0)" | sudo tee -a /etc/pf.conf
```

`flowhelm doctor` checks for IP forwarding and reports a fix suggestion if it's disabled. `flowhelm setup` can configure these rules automatically (requires sudo).

### DNS (IPv4-first)

Apple Container's vmnet resolver has an IPv6 DNS issue. FlowHelm automatically injects `NODE_OPTIONS=--dns-result-order=ipv4first` into every container's environment to force IPv4 DNS resolution. This is handled by `AppleContainerRuntime.buildCreateArgs()` — no manual configuration needed.

## Differences from Podman

| Feature | Podman (Linux) | Apple Container (macOS) |
|---|---|---|
| Isolation | Linux namespaces + cgroups | VM (Virtualization.framework) |
| Mount syntax | `--volume /host:/container:ro,Z` | `--mount type=bind,source=...,target=...,readonly` |
| SELinux labels | `:Z` for private relabeling | Not applicable |
| User namespaces | `--userns auto` | Not applicable (VM isolation) |
| Resource limits | Enforced via cgroups v2 | Advisory (VM-level) |
| Networks | User-defined (`podman network create`) | Shared vmnet bridge (no-op) |
| Service manager | systemd | launchd |
| Multi-tenant | Yes (per-user UID namespaces) | No (single-user, development mode) |
| Read-only rootfs | `--read-only` flag | Not supported |
| Container DNS | Podman's built-in DNS | vmnet + IPv4-first workaround |
| UDS via bind mounts | Supported (bind-mount `.sock` files) | Not supported (virtiofs limitation) — FlowHelm uses TCP fallback for MCP |

## Mount Syntax

Apple Container uses `--mount` syntax instead of Podman's `--volume`:

```bash
# Podman
podman create --volume /host/path:/container/path:ro,Z image

# Apple Container
container create --mount type=bind,source=/host/path,target=/container/path,readonly image
```

FlowHelm handles this automatically — `AppleContainerRuntime.buildCreateArgs()` translates `MountConfig` objects into the correct syntax for each runtime. SELinux labels (`:Z`) and the chown flag (`:U`) are Podman-only and silently skipped on macOS.

## Service Management (launchd)

On macOS, FlowHelm uses launchd instead of systemd:

| Operation | systemd (Linux) | launchd (macOS) |
|---|---|---|
| Service file | `~/.config/systemd/user/flowhelm.service` | `~/Library/LaunchAgents/ai.flowhelm.plist` |
| Enable | `systemctl --user enable flowhelm` | `launchctl load ~/Library/LaunchAgents/ai.flowhelm.plist` |
| Start | `systemctl --user start flowhelm` | `launchctl load ...` (RunAtLoad=true) |
| Stop | `systemctl --user stop flowhelm` | `launchctl unload ~/Library/LaunchAgents/ai.flowhelm.plist` |
| Restart | `systemctl --user restart flowhelm` | `launchctl kickstart -k gui/$(id -u)/ai.flowhelm` |
| Logs | `journalctl --user -u flowhelm -f` | `tail -f ~/.flowhelm/logs/flowhelm.log` |
| Status | `systemctl --user status flowhelm` | `launchctl list \| grep flowhelm` |

The launchd plist includes:
- `KeepAlive=true` — restart automatically on crash
- `RunAtLoad=true` — start on login
- `ThrottleInterval=5` — minimum 5 seconds between restarts
- `ProcessType=Interactive` — prioritize responsiveness

## virtiofs UDS Limitation and MCP TCP Fallback

Apple's virtiofs implementation (used by both Apple Container and Podman machine on macOS) does not support Unix domain sockets through bind mounts. On Linux, the MCP memory server listens on a UDS at `~/.flowhelm/ipc/{chatId}-memory.sock`, which is bind-mounted into agent containers. This approach fails silently on macOS -- the socket file appears in the container filesystem but connections to it hang or error.

**TCP fallback on macOS**: When `process.platform === 'darwin'`, the orchestrator creates the MCP server with `port: 0` (OS-assigned ephemeral port) instead of a UDS path. After `start()`, the server's `assignedPort` getter returns the actual port. The orchestrator passes this port to the `AgentTask` as `mcpPort`, and the agent runtime generates a TCP-mode MCP config with `FLOWHELM_MCP_HOST=host.containers.internal` and `FLOWHELM_MCP_PORT=<assignedPort>`.

Inside the container, the `stdio-to-uds-bridge.cjs` script checks for `FLOWHELM_MCP_HOST` and `FLOWHELM_MCP_PORT` environment variables. If both are set, it connects via `net.createConnection({ host, port })` (TCP). Otherwise, it connects via `net.createConnection({ path })` (UDS). The IPC directory bind mount is skipped entirely on macOS since no socket file is used.

`host.containers.internal` is a standard hostname resolved by both Podman machine VMs and Apple Container VMs to the host's IP address. This works identically on both macOS container runtimes.

**Security**: The TCP port binds to `0.0.0.0` inside the orchestrator process on the host. However, this port is only accessible from within the container VM's virtual network (Podman machine's internal network or Apple Container's vmnet bridge). It is not exposed to the external host network or LAN. Each MCP server instance serves a single chat's memory scope -- the same per-user isolation guarantees apply as with UDS. See `docs/security-model.md` for the full analysis.

**Files modified**: `src/orchestrator/mcp-server.ts` (TCP listen mode, `assignedPort` getter), `src/orchestrator/types.ts` (`mcpPort` on `AgentTask`), `src/orchestrator/orchestrator.ts` (darwin detection, port 0), `src/agent/mcp-config.ts` (`tcpHost`/`tcpPort` options), `src/agent/warm-container-runtime.ts` (IPC mount skip, TCP config), `container-image/stdio-to-uds-bridge.cjs` (TCP/UDS auto-detection).

## Credential Proxy on macOS

The credential proxy must bind to `0.0.0.0` on macOS because the bridge100 IP is dynamic and only exists while containers are running. This exposes the proxy on all network interfaces.

**On private/home networks**: No additional configuration needed.

**On shared/public networks**: Add a firewall rule to block external LAN access:

```bash
# Block external access to proxy port
echo "block in on en0 proto tcp to any port 10255" | sudo pfctl -ef -

# Verify
curl -sf http://$(ipconfig getifaddr en0):10255 && echo "EXPOSED" || echo "BLOCKED"
```

See `generateFirewallBlockCommand()` in `src/container/apple-network.ts`.

## Installation

```bash
# macOS install (via Homebrew + npm)
curl -fsSL https://flowhelm.ai/install.sh | bash

# Or manually:
brew install node@22
npm install -g flowhelm
# Install Apple Container CLI from https://github.com/apple/container/releases
flowhelm setup
flowhelm doctor
```

## Diagnostics

`flowhelm doctor` on macOS checks:

| Check | What it verifies |
|---|---|
| macOS version | ≥26 (Tahoe) |
| Apple Silicon | arm64 architecture |
| Apple Container | `container` CLI installed |
| IP forwarding | `net.inet.ip.forwarding=1` |
| launchd service | `ai.flowhelm` loaded |
| Config file | `~/.flowhelm/config.yaml` exists |
| Credential vault | `~/.flowhelm/secrets/credentials.enc` exists |
| Auth tokens | OAuth/API key validity |

## Troubleshooting

### Apple Container CLI not found

```bash
# Check installation
container --version

# Install from GitHub releases
# https://github.com/apple/container/releases
```

### Containers can't reach the internet

```bash
# Check IP forwarding
sysctl net.inet.ip.forwarding
# Should be: net.inet.ip.forwarding: 1

# Enable if not
sudo sysctl -w net.inet.ip.forwarding=1

# Check NAT rules
sudo pfctl -s nat
# Should show: nat on en0 from 192.168.64.0/24 ...
```

### bridge100 not found

The bridge100 interface only exists while an Apple Container is running. Start a container first:

```bash
container run --rm alpine echo "bridge test"
ifconfig bridge100
```

### DNS resolution fails inside containers

FlowHelm injects `NODE_OPTIONS=--dns-result-order=ipv4first` automatically. If you're running containers manually, add it to the environment:

```bash
container run --env NODE_OPTIONS=--dns-result-order=ipv4first image
```

### launchd service not starting

```bash
# Check if loaded
launchctl list | grep flowhelm

# Load manually
launchctl load ~/Library/LaunchAgents/ai.flowhelm.plist

# Check logs
tail -f ~/.flowhelm/logs/flowhelm.log
tail -f ~/.flowhelm/logs/flowhelm.error.log
```

## File Listing

### Source files

| File | Purpose |
|---|---|
| `src/container/apple-runtime.ts` | `AppleContainerRuntime` — wraps `container` CLI |
| `src/container/podman-runtime.ts` | `PodmanRuntime` — wraps `podman` CLI (used on Linux and macOS pre-Tahoe) |
| `src/container/apple-network.ts` | vmnet network checks and setup commands |
| `src/container/platform.ts` | Platform detection, macOS version, runtime selection, `getPodmanMachineState()` |
| `src/container/index.ts` | Barrel exports and `createRuntime()` factory |
| `src/admin/launchd-generator.ts` | launchd plist generation |
| `src/admin/doctor.ts` | Runtime-aware diagnostic checks (Podman vs Apple Container) |
| `src/admin/status.ts` | Platform-aware status reporting |
| `src/admin/setup-wizard.ts` | Setup wizard with macOS runtime detection and guidance |
| `scripts/install.sh` | Dual-path macOS install (Apple Container or Podman) |

### Test files

| File | Tests |
|---|---|
| `tests/apple-container.test.ts` | AppleContainerRuntime (65 tests) |
| `tests/apple-platform.test.ts` | Platform detection, launchd, network (19 tests) |
| `tests/doctor.test.ts` | Doctor checks including macOS+Podman and macOS+Apple Container paths |
| `tests/setup-wizard.test.ts` | Setup wizard including macOS platform detection display |
| `tests/status.test.ts` | Status reporting with platform override |

## Design Decisions

- **ADR-068**: Apple Container Runtime — see `docs/decisions.md`
- **ADR-069**: Dual-Runtime macOS Strategy — see `docs/decisions.md`
- **Single-user on macOS**: macOS lacks the 5 kernel-level isolation layers required for multi-tenant (UID namespaces, cgroups v2, SELinux, systemd lingering, per-user networks). See `docs/security-model.md#why-macos-cannot-support-multi-tenant` for the full breakdown.
- **vmnet no-ops**: Network create/remove are no-ops since vmnet is OS-managed. This keeps the `ContainerRuntime` interface identical across runtimes.
- **Advisory resource limits**: Apple Container VMs don't enforce cgroups. Memory/CPU limits are passed to the CLI but are advisory.
- **Podman machine as first-class fallback**: On pre-Tahoe macOS, `podman machine` runs Fedora CoreOS with SELinux, cgroups v2, and rootless mode — functionally equivalent to Linux Podman.
- **Auto-detection over configuration**: `detectPlatform()` probes macOS version, CPU, and CLI availability. Users never choose a runtime manually.
