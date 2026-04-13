# Security Model

## Threat Model

FlowHelm protects against:
- Accidental cross-user data leakage
- Credential exposure between users
- Credential extraction via prompt injection (agents never hold real keys)
- Resource starvation from runaway processes
- Container escape to other users' data
- Prompt injection from malicious email content

FlowHelm does NOT protect against:
- Malicious VM admin (root can read anything)
- Kernel-level exploits (affects all users)
- Anthropic/Google/OpenAI server-side data access

## Seven Isolation Layers

### Layer 1: Linux Users
Separate UIDs, home directories `chmod 750`, credential files `chmod 600`.

### Layer 2: Podman UID Namespaces
Each user's Podman maps container UIDs to a unique sub-UID range (65536 IDs per user). Kernel-enforced separation.

**UID mapping implications**: In rootless Podman, the host user's UID is mapped to UID 0 (root) inside the container's user namespace. This means host-owned files on bind mounts appear as root-owned inside the container. However, this container "root" has no real capabilities on the host — it cannot access files outside its namespace, escalate privileges, or affect other users' containers. The practical consequence is that bind-mounted files from the host are read-only to non-root container users. FlowHelm solves this with a staging mount pattern (see below).

### Layer 3: Systemd Service Hardening
`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=tmpfs`, `BindPaths` only to own home.

### Layer 4: Per-User Podman Network
Each user's containers communicate on an isolated Podman network (`flowhelm-network-{user}`). No cross-user network traffic at the CNI/netavark level.

### Layer 5: Channel Container Credential Isolation
Channel credentials (Telegram bot tokens, Gmail OAuth tokens, WhatsApp session keys) live only in the `flowhelm-channel-{username}` container — never in the orchestrator, never in agent containers. The channel container is **trusted infrastructure** (our code, not arbitrary agent code), distinct from the agent container security boundary. It mounts `credentials.enc` read-write and decrypts in-memory at startup. The RW mount is required because WhatsApp's Baileys library continuously updates session state (signal keys, pre-keys) during normal operation — these updates are written back to the encrypted vault via `useVaultAuthState()` (ADR-057). All other channels (Telegram, Gmail) only read credentials at startup. The MITM proxy protects against compromised *agent* containers; the channel container needs direct credential access because protocols like IMAP XOAUTH2 and WhatsApp WebSocket require raw tokens (not HTTP headers). If an agent container is compromised, the attacker cannot reach channel credentials — they are in a separate container on the same Podman network with no shared filesystem or IPC. The orchestrator communicates with the channel container via HTTP (`POST /send` for outbound messages, `POST /gws` for Google Workspace operations via gws CLI); inbound messages flow through PostgreSQL (crash-safe). Google Workspace operations (email, contacts, calendar, drive) route through the channel container's gws CLI binary — the agent container never has the gws binary or OAuth tokens. See @docs/channel-container.md, ADR-054, ADR-057, and ADR-059.

### Layer 6: Credential Proxy Container (MITM TLS)
_(Previously Layer 5)_
Credentials live only in the proxy container — never in the orchestrator, never in agent containers. Stored as AES-256-GCM encrypted JSON at `~/.flowhelm/secrets/credentials.enc` (key file at `credentials.key`, mode 0400). The `ProxyManager` passes the decryption key to the proxy container at launch via env var. The proxy decrypts into memory, serves an HTTP forward proxy on port 10255, and injects real credentials into outbound requests matched by host pattern. Agents hold only placeholder keys. Per-host sliding window rate limits prevent runaway API spending. An append-only audit log records every proxied request (no bodies). See @docs/credential-proxy.md, ADR-012, and ADR-043.

**MITM TLS interception (Phase 4D-MITM)**: The proxy performs man-in-the-middle TLS termination for hosts that have a matching credential rule. For each such CONNECT request, the proxy terminates the agent's TLS using a per-domain certificate signed by a per-user CA, reads the plaintext HTTP request, injects the real credential header, and forwards over a new TLS connection to the destination. This eliminates credential exposure for third-party services (Google, OpenAI, etc.) — the agent container never holds real API keys, not even as environment variables. Hosts without credential rules are never intercepted; they pass through as raw TCP tunnels.

**Per-user CA isolation**: Each FlowHelm user gets an independent, auto-generated CA certificate. The CA private key is stored at `~/.flowhelm/secrets/ca.key` (mode 0400, owner-only read) and the CA certificate at `~/.flowhelm/secrets/ca.crt` (mode 0644). Compromise of one user's CA private key does not affect any other user — their CAs are completely independent, generated with separate RSA 2048-bit keypairs, and stored under separate Linux user home directories.

**CA key separation**: Only the CA certificate (public) is mounted into agent containers (read-only, at `/usr/local/share/ca-certificates/flowhelm-proxy-ca.crt`). The CA private key is mounted only into the proxy container (at `/secrets/ca.key`, read-only). An attacker who compromises an agent container can see the public CA cert but cannot forge certificates because the private key is not present.

**Anthropic auth tokens (Phase 9 resolved)**: When MITM TLS is active, agent containers receive placeholder credentials (`sk-ant-flowhelm-proxy-placeholder-00...`) that pass CLI startup validation but carry no real access. The MITM proxy replaces these with real credentials before requests reach upstream APIs. Real tokens never enter agent containers. Without MITM (no CA configured), the runtime falls back to forwarding real tokens for backward compatibility.

### Layer 7: Podman Container Security
`--security-opt no-new-privileges`, SELinux confinement, `--read-only` filesystem, `--pids-limit`, cgroups v2 resource limits.

**Multi-tenant isolation (Phase 10A, ADR-056)**: Each user gets a dedicated Linux user (`flowhelm-{name}`) with a unique sub-UID/GID range (65536 IDs). Podman rootless runs entirely in the user's UID namespace — one user's containers are invisible to another. Per-user systemd services (`flowhelm.service`) provide crash recovery. cgroups v2 resource limits (`systemctl set-property`) prevent one user from starving others. Port allocation via `/etc/flowhelm/ports.json` ensures no container port conflicts across users. Admin commands (`flowhelm admin`) run as root but never touch user data, credentials, or agent logic — only user lifecycle and resource enforcement.

**MITM CA trust in agent containers**: Agent containers trust the per-user FlowHelm CA via the `NODE_EXTRA_CA_CERTS` environment variable, which points to the mounted CA cert at `/usr/local/share/ca-certificates/flowhelm-proxy-ca.crt`. This *extends* the default system CA bundle rather than replacing it — the agent can still verify legitimate TLS certificates for all other hosts. On container startup, `update-ca-certificates` is also run to add the FlowHelm CA to the system trust store (for non-Node.js tools like `curl` and `git`). The MITM proxy only intercepts CONNECT requests to hosts with a matching credential rule; all other HTTPS traffic passes through as an unmodified TCP tunnel.

### Rootless Mount Staging Pattern

Podman rootless UID mapping creates a practical problem: host files on bind mounts need the correct UID mapping. FlowHelm uses `--userns=keep-id:uid=1000,gid=1000` (ADR-063) to map any host user (UID 1000, 1001, etc.) to container UID 1000 (`node` user). This makes read-only bind mounts (credentials, models, CA certs) accessible without `chown`. For writable directories like the agent's `.claude` working directory, FlowHelm uses a two-phase staging pattern:

1. **Pre-start (host side)**: Session files are written to a host staging directory. This directory is bind-mounted at `/home/flowhelm/.claude-host` inside the container.
2. **Post-start (container side)**: A `podman exec` runs `cp -a .claude-host/. .claude/` followed by `chown -R flowhelm:flowhelm .claude/`. This copies files from the root-owned bind mount into a container-owned directory where the `flowhelm` user has full read/write access.

This pattern is used for session restore on cold start and for provisioning Claude Code credentials. The container's actual working directory (`.claude`) is never a direct bind mount — it is always container-owned.

**Session backup reads from the container**: For the reverse direction (backup to PG), `asyncBackupSession()` reads session files via `podman exec` from inside the running container rather than from the host filesystem. This avoids UID mapping permission issues and ensures the backup captures the authoritative state of the session (the container's `.claude` directory, not the stale `.claude-host` bind mount).

### Session Data in PostgreSQL

Session state is backed up to the `agent_sessions` table as a JSONB map (`session_files` column) keyed by relative file path. The backup captures the full `~/.claude/projects/` directory tree inside the container, which includes:

- **Conversation transcripts** (`.jsonl`): Complete message history for the Claude Code session, including user messages, assistant responses, tool calls, and tool results.
- **Claude Code auto-memory** (`.md`): Claude Code's built-in memory files that it writes automatically during conversations (e.g., project context, user preferences discovered during the session).
- **Session metadata** (`.json`): Session index, subagent state, and tool result caches.

This data is stored per-chat (one active session per chat, UPSERT on `chat_id`) and retained for the configured retention period (default 7 days) after session end. The JSONB storage enables efficient restore without filesystem-level snapshots.

## Credential Lifecycle

```
1. User: flowhelm credentials add anthropic --host api.anthropic.com --header x-api-key
2. CredentialStore encrypts → ~/.flowhelm/secrets/credentials.enc (AES-256-GCM, chmod 600)
3. Orchestrator starts ProxyManager → creates flowhelm-proxy-{user} container
4. Proxy decrypts credentials into memory, serves HTTP forward proxy on :10255
5. Agent container launched with HTTP_PROXY=http://flowhelm-proxy-{user}:10255
6. Agent makes HTTP request with placeholder key on trusted Podman network
7. Proxy matches host → credential rule → swaps placeholder → forwards as HTTPS with real key
8. Per-host rate limit checked before forwarding (429 if exceeded)
9. Audit log records: timestamp, method, host, status, latency, credential name
10. Agent container exits → placeholder dies with it
11. Proxy continues running for next agent task (health-checked every 30s)
12. Real credential was NEVER in orchestrator or agent memory
```

### Subscription OAuth (CLI Runtime)

For subscription OAuth users (Personal and Team tiers using CLI runtime), credentials are obtained via one of three methods:

1. **Token Bridge (recommended)**: The `flowhelm setup` command generates an X25519 keypair, creates an ephemeral session on the auth bridge relay (`flowhelm.to`), and displays a QR code. The user scans the code on their phone/laptop, runs `claude setup-token`, and pastes the token into the bridge's web page. The browser encrypts the token using X25519 ECDH + AES-256-GCM with the VM's public key (passed via URL hash, never sent to the server). The VM polls for the encrypted blob, decrypts it with its private key, and stores the credential at `~/.claude/.credentials.json` (mode 0600).

   **Security properties**: The bridge server stores only ciphertext — it cannot decrypt because it has neither the VM's private key nor the browser's ephemeral private key. Sessions are ephemeral (10-minute TTL, in-memory, no database). Forward secrecy is provided by the browser's ephemeral keypair. See ADR-025 and @docs/auth-bridge.md.

2. **SSH Tunnel**: The user sets up SSH port forwarding (`ssh -L 9876:localhost:9876 vm-host`) and runs `claude login --port 9876` on the VM. The OAuth flow completes through the tunnel.

3. **Direct paste**: Fall back for when the bridge is unreachable. The user runs `claude setup-token` elsewhere and pastes the token directly into the FlowHelm terminal.

After authentication, the `claude` binary inside the container reads credentials from its standard location. No API key exists in this flow — the CLI handles token refresh internally.

### Encrypted Secrets Vault (ADR-055)

All secrets are stored in a single AES-256-GCM encrypted vault at `~/.flowhelm/secrets/credentials.enc`. The encryption key is a random 32-byte key at `~/.flowhelm/secrets/credentials.key` (chmod 400). This is the single master key — protecting it protects all secrets.

**What's inside `credentials.enc`**:

| Field | Purpose | Who reads it |
|---|---|---|
| `credentials[]` | HTTP proxy injection rules (API keys, OAuth tokens, channel secrets) | Proxy container (MITM), channel container (adapters) |
| `pinningBypass[]` | Hosts that skip MITM (cert pinning) | Proxy container |
| `secrets{}` | Non-HTTP secrets (DB password, future internal tokens) | Orchestrator only (distributes via env vars) |

**Plaintext files on disk** (cannot be encrypted — needed as files for container bind-mounts):

| File | Purpose | Protection |
|---|---|---|
| `credentials.key` | Master decryption key | chmod 400, per-user Linux ownership |
| `ca.key` | CA private key for MITM TLS cert signing | chmod 400, never leaves host |
| `ca.crt` | CA certificate (mounted into agent containers) | Public — agents need it to trust MITM proxy |

Legacy plaintext token files (`oauth-token`, `api-key`, `db-password`) are automatically migrated into `credentials.enc` on startup and can be deleted after migration.

**Secret distribution**: The orchestrator decrypts `credentials.enc` once at boot and distributes secrets to containers at creation time via env vars and file mounts. No container queries a secrets service at runtime. See ADR-055.

**Token forwarding to containers (Phase 9)**: When MITM TLS is active, `WarmContainerRuntime` passes placeholder credentials (`ANTHROPIC_API_KEY=sk-ant-flowhelm-proxy-placeholder-00...`) instead of real tokens. The `claude` CLI passes startup validation (the placeholder matches the `sk-ant-*` prefix pattern), but the key has no real access. The MITM proxy replaces it with the real key in flight. Without MITM, real tokens are still forwarded for backward compatibility.

### MITM TLS Credential Injection (Phase 4D-MITM, ADR-043)

The credential proxy performs MITM TLS interception for hosts with matching credential rules. When an agent makes an HTTPS request (via CONNECT) to a credential-matched host (e.g., `api.anthropic.com`), the proxy:

1. Terminates the agent's TLS using a per-domain certificate signed by the per-user FlowHelm CA
2. Reads the plaintext HTTP request
3. Injects the real credential header (e.g., `x-api-key`, `Authorization: Bearer`)
4. Opens a new TLS connection to the real destination server
5. Forwards the request with real credentials and pipes the response back

For hosts **without** credential rules, CONNECT requests pass through as raw TCP tunnels (no interception). The MITM path is strictly opt-in per host pattern.

**All credential types** (Anthropic OAuth, Anthropic API keys, Google OAuth, OpenAI Whisper keys) are injected via MITM — no real credentials enter agent containers. Agent containers receive format-valid placeholder tokens that pass CLI startup validation. The MITM proxy replaces placeholders with real credentials before requests reach upstream APIs. The `credentialMethod` config option controls which auth header type the agent uses (see @docs/credential-proxy.md).

The proxy still provides all non-MITM capabilities for all CONNECT requests:
- Audit connections: log target hostname, port, status, latency, credential name
- Enforce rate limits: per-host sliding window limits
- Block hosts: refuse to establish tunnels to unauthorized destinations

### MITM TLS Attack Surface Analysis

The MITM TLS proxy is a deliberate trade-off: it eliminates credential exposure in agent containers at the cost of concentrating sensitive material in the proxy container. This section documents the attack surface and mitigations.

**The proxy container is a high-value target.** It holds both the CA private key (to sign per-domain certificates) and the decrypted credentials (to inject into forwarded requests). The proxy container is hardened with:
- Read-only root filesystem (`--read-only`)
- Non-root user (UID 1000) inside the user's UID namespace
- `no-new-privileges` security option (prevents privilege escalation via setuid binaries)
- PIDs limit of 64 (prevents fork bombs)
- Memory limit of 64 MB (prevents memory exhaustion)
- Shell removed at build time (no interactive access even if code execution is achieved)
- Minimal Alpine + Node.js image (per-container `proxy-package.json` — only `zod` + `node-forge`, ADR-067)
- No inbound network listeners other than the proxy port (10255) on the isolated Podman network

**If an agent container is compromised**, the attacker can:
- Make API calls through the proxy to any host with a credential rule (the proxy injects real credentials). This is rate-limited per-host and audit-logged.
- See the FlowHelm CA certificate (public key only). This allows verifying but not forging certificates.

The attacker **cannot**:
- Extract real credentials from proxy memory. The proxy is a separate container with its own UID namespace and network stack. There is no shared filesystem or IPC channel between agent and proxy containers.
- Forge TLS certificates for MITM of other connections. The CA private key is not mounted into agent containers — only into the proxy container.
- Bypass rate limits. The proxy enforces per-host sliding window limits before forwarding.
- Access other users' proxies. Each user's proxy runs on an isolated Podman network (`flowhelm-network-{user}`).

**If the proxy container itself is compromised**, the attacker gains:
- All decrypted credentials for that user (in-memory only, not on disk inside the container).
- The CA private key for that user (could forge certificates for any domain, but only within that user's Podman network where agents trust the CA).
- The ability to intercept and modify all MITM-proxied traffic for that user's agents.

This is scoped to a single user. Other users' proxy containers, credentials, and CA keys are completely independent. The proxy's minimal image, read-only filesystem, and lack of shell make exploitation significantly harder than a typical container.

**TLS visibility is by design.** The MITM proxy sees plaintext API requests for credential-matched hosts. This is the fundamental mechanism for credential injection — there is no way to inject HTTP headers into an encrypted stream without terminating TLS. The trade-off is explicit: credentials stay out of agent containers (protecting against prompt injection extraction) at the cost of the proxy seeing request contents. The proxy does not log request or response bodies — only metadata (method, host, path, status, latency, credential name).

## MCP Memory Server Security

Agent containers access the memory database via an MCP server running in the orchestrator process. On Linux, the connection is over a Unix domain socket (UDS). On macOS, it uses TCP (see below). Security properties:

- **No direct database access**: The agent cannot execute arbitrary SQL. It can only call defined MCP tools (25 tools total: `search_semantic`, `search_external`, `recall_conversation`, `store_semantic`, `get_memory_stats`, `expand_memory`, `search_meta`, `expand_meta`, `trace_to_source`, identity/profile/admin tools), which use parameterized queries internally.
- **Per-user scoping**: The MCP server queries only the current user's PostgreSQL container. Cross-user memory access is impossible — each user has a separate database container on an isolated Podman network.
- **UDS isolation (Linux)**: The socket lives at `~/.flowhelm/ipc/{chatId}-memory.sock` within the user's home directory and is bind-mounted into only that user's agent containers.
- **TCP transport (macOS)**: Apple's virtiofs does not support Unix domain sockets through bind mounts, so on macOS (`process.platform === 'darwin'`) the MCP server listens on TCP `0.0.0.0:<OS-assigned port>` instead. Agent containers connect via `host.containers.internal:<port>`. The TCP port binds to `0.0.0.0` on the host, but it is **not exposed to the external host network or LAN**. The port is only reachable from within the container VM's virtual network (Podman machine's internal network or Apple Container's vmnet bridge at `192.168.64.0/24`). Each MCP server instance is scoped to a single chat -- the same per-user isolation guarantees apply as with UDS. On shared/public networks, the standard `pfctl` firewall rules recommended for the credential proxy (see macOS Isolation Model below) also block external access to these ephemeral MCP ports.
- **Write auditability**: Every memory created via `store_memory` includes `source_session` linking it to the originating task.
- **Rate limiting**: The MCP server enforces per-session rate limits to prevent exhaustive database enumeration via repeated semantic searches.
- **Read-only for existing memories**: The agent can create new memories but cannot modify or delete existing ones — only the orchestrator performs consolidation and pruning.

See ADR-023 in @docs/decisions.md, @docs/memory.md, and @docs/apple-container.md.

## Agent Profiles Are Not a Security Boundary

Agent profiles (see @docs/memory.md and ADR-034 in @docs/decisions.md) provide **logical scoping**, not security isolation. Profiles exist within a single user's PostgreSQL database and organize agent identity, personality, and long-term memory into separate namespaces — but all profiles within a user share the same database, credentials, and container resources. The security boundary is the **user** (Podman UID namespace + per-user PostgreSQL + per-user credential proxy), not the profile. The MCP `switch_chat_profile` tool allows an agent to reassign its chat to a different profile; this is a convenience feature for the user, not a privilege escalation risk, because all profiles belong to the same user and operate within the same isolation layers described above.

## Prompt Injection Defense

Email content is the primary injection vector. Defenses:
1. Claude's built-in resistance
2. Email content passed as data to tools, not system prompts
3. Credential proxy: even if injection succeeds, agent only has placeholders
4. Destructive actions require user confirmation via Telegram
5. Rate limiting at proxy level prevents mass operations
6. MCP memory server: agent can query memories but cannot delete or modify existing entries — limits blast radius of prompt injection affecting memory integrity
7. Memory writes via `store_memory` are auditable via `source_session` — compromised entries can be traced and removed

## macOS Isolation Model

On macOS, FlowHelm uses Apple Container (Tahoe 26+) or Podman via `podman machine` (pre-Tahoe). Both paths are **single-user only**. There is no `flowhelm admin add-user` on macOS — the single logged-in user owns all containers.

### Why macOS Cannot Support Multi-Tenant

FlowHelm's multi-tenant security on Linux relies on 5 kernel-level isolation mechanisms that macOS does not provide:

| Isolation Layer | Linux | macOS | Impact |
|---|---|---|---|
| **UID namespaces** | Each user gets 65,536 sub-UIDs via `/etc/subuid`. User A's containers run as UIDs 100000–165535, User B's as 165536–231071. They cannot see each other's processes or files at the kernel level. | All processes share one UID space. No sub-UID mapping, no `newuidmap`/`newgidmap`. | No kernel-enforced user separation — one user's containers could inspect another's. |
| **cgroups v2** | Per-user CPU, memory, and PID limits enforced via cgroups v2 slices. If User A exhausts RAM, their cgroup OOM-kills their processes, not the system. | No cgroups. Apple Container resource limits are advisory (VM-level hints). | No hard resource enforcement — one user could starve others. |
| **SELinux / MAC** | Podman uses SELinux labels (`:Z` mount flag) for mandatory access control. Even if a container escapes, SELinux blocks cross-user file access. | No MAC framework for containers. | No mandatory access control between users' containers. |
| **systemd lingering** | `loginctl enable-linger` keeps each user's containers alive after SSH logout, each with their own systemd user instance. | launchd is single-user by design. No per-user daemon isolation. | Cannot run independent service instances for multiple users. |
| **Per-user networks** | Each user gets a dedicated Podman network (`flowhelm-network-{username}`) with isolated DNS and routing. | Apple Container: all VMs share one `bridge100` vmnet bridge (`192.168.64.0/24`). Podman machine: one shared VM for all containers. | No network isolation between users' containers. |

Without these 5 layers, multi-tenant on macOS would be security theater — application-level isolation without kernel enforcement. FlowHelm does not offer features it cannot secure.

### macOS Isolation Properties

What macOS **does** provide for single-user deployments:

- **VM-based isolation** (Apple Container): Each container runs in its own lightweight VM via the macOS Virtualization.framework. This provides stronger per-container isolation than Linux namespaces — each container has its own kernel.
- **Podman machine isolation** (pre-Tahoe): All containers run inside a Fedora CoreOS Linux VM with SELinux, cgroups v2, and rootless mode. Within the VM, container isolation is equivalent to Linux — but the VM itself is single-user.
- **No user-defined networks**: All containers share the vmnet bridge (`192.168.64.0/24`). Network create/remove operations are no-ops. Container-to-container communication goes through the shared bridge.
- **Advisory resource limits**: Apple Container VMs do not enforce cgroups. Memory and CPU limits are passed to the CLI but are advisory — they are not hard-enforced like Podman's cgroups v2 limits.
- **Credential proxy binding**: The credential proxy binds to `0.0.0.0` on macOS because the `bridge100` IP is dynamic. On shared networks, a `pfctl` firewall rule should block external LAN access to the proxy port. See `generateFirewallBlockCommand()` in `src/container/apple-network.ts`.
- **Service manager**: launchd replaces systemd. The service plist (`~/Library/LaunchAgents/ai.flowhelm.plist`) provides KeepAlive, RunAtLoad, and crash restart.

See ADR-068 and ADR-069 in @docs/decisions.md and @docs/apple-container.md.

## Network Posture

**Linux**: Outbound only: Telegram API, WhatsApp WebSocket, Anthropic API, Google Pub/Sub (gRPC), Whisper API, googleapis.com. No inbound ports except SSH (key-only auth).

**macOS**: Same outbound posture. The credential proxy listens on `0.0.0.0:10255` (accessible on all interfaces). The MCP memory server also listens on `0.0.0.0:<ephemeral port>` when using TCP mode (virtiofs UDS limitation). Both are intended for container VM traffic only and are not reachable from external networks under normal conditions. On shared/public networks, add a `pfctl` rule to restrict access — see @docs/apple-container.md#credential-proxy-on-macos.

## Skill Isolation

Skills are user-installed agent capabilities (`flowhelm install <name>`) that extend what the agent can do. Security properties:

- **Per-user skill store**: Each user's skills are stored in their own `~/.flowhelm/skills/` directory. One user's skill installations cannot affect another user's agents.
- **Container-sandboxed execution**: Skills are synced into agent containers at launch and mounted read-only at `/workspace/.claude/skills/`. Skills execute inside the same container sandbox as the agent — same UID namespace, same resource limits, same network isolation.
- **No host filesystem access**: Skills cannot read or write the host filesystem. They can only access files inside the container.
- **Credential proxy protection**: Skills run inside agent containers where only placeholder credentials exist. Real API keys and tokens are injected by the credential proxy at network level. Even a malicious skill cannot extract raw credentials.
- **Registry-only MCP installs**: The `install_skill` MCP tool (chat-based administration) only fetches from the official registry (`flowhelm-ai/flowhelm-skills`). Arbitrary URLs are blocked. CLI users can install from local paths, but that requires SSH access.
- **Config update allowlist**: The `update_config` MCP tool only allows modifying a specific set of non-sensitive fields. Username, data directory, auth credentials, proxy config, and database settings are blocked from chat-based modification.

## Credential Proxy Design Principles

FlowHelm's credential proxy is designed around these security principles:

| Principle | Implementation |
|---|---|
| **Per-user isolation** | One proxy container per user on isolated Podman networks with independent CAs. One user's proxy failure/compromise cannot affect another user. |
| **Minimal attack surface** | Alpine + Node.js, 2 npm deps (`zod` + `node-forge` via `proxy-package.json`, ADR-067), read-only filesystem, no shell, no database access, no inbound network except proxy port on isolated network. |
| **Zero external dependencies** | node-forge for X.509 (pure JS, no native modules, no external processes). No separate gateway binary, no additional database, no dashboard process. |
| **Per-user CA** | Auto-generated RSA 2048 CA with dynamic per-domain leaf certs and in-memory LRU cache. Compromise of one user's CA does not affect others. |
| **Encrypted at rest** | AES-256-GCM encrypted JSON on host (`credentials.enc`), decrypted in-memory at proxy startup. No plaintext secrets on disk inside the container. |
| **Orchestrator-managed lifecycle** | Proxy is started, health-checked, and restarted by the orchestrator. SIGHUP for credential reload without downtime. No manual management. |
| **Native HTTP handling** | MITM uses Node's built-in HTTP server on decrypted TLS sockets (ADR-047) for reliable keep-alive, chunked encoding, and body streaming. |

## Compliance Positioning

- **PCI-DSS**: No root-level container processes (Podman rootless). No daemon. Credentials encrypted at rest with audit trail.
- **SOC 2**: Per-user UID namespaces, isolated credential proxy, append-only audit logs.
- **HIPAA**: Namespace isolation prevents cross-user PHI access. Credential proxy ensures keys never enter agent context where prompt injection could extract them.
