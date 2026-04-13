# Credential Proxy

## Problem

AI agent containers run LLM-generated code. This code can be manipulated via prompt injection to exfiltrate environment variables, read files, or make unauthorized API calls. If the agent container holds real API keys (Anthropic, Google, OpenAI), a successful injection leaks those credentials.

A common approach is to hold credentials in the orchestrator process and inject via `--env` at container launch. Problem: credentials live in agent container memory. The orchestrator itself handles untrusted inbound messages (Telegram, WhatsApp), making it an attack surface.

Alternative approaches exist using external gateway services (separate database, dashboard, Rust gateway) — but these add three additional processes, a database, and a separate release cycle. FlowHelm avoids this complexity entirely.

## FlowHelm's Solution: Per-User Proxy Container

Each user gets a dedicated, minimal Podman container that holds their decrypted credentials and acts as an HTTP proxy. Agent containers route all outbound HTTPS through this proxy. The proxy swaps placeholder credentials for real ones at the network layer.

```
Per-user Podman network (flowhelm-network-mark):

┌──────────────────────────────────────────────────────┐
│  flowhelm-proxy-mark (always running, ~20 MB)        │
│                                                      │
│  Reads: /secrets/credentials.enc, /secrets/ca.key    │
│  Decryption key: env var at launch                   │
│  Listens: :10255 (HTTP proxy)                        │
│                                                      │
│  On CONNECT request:                                 │
│  1. Match host → credential rule                     │
│  ┌─ Rule found (MITM) ──────────────────────────┐    │
│  │ 2. Reply 200 → TLS terminate (per-domain CA) │    │
│  │ 3. Read plaintext HTTP                       │    │
│  │ 4. Inject real credential header             │    │
│  │ 5. HTTPS to real server → pipe back          │    │
│  │ 6. Log to audit file                         │    │
│  └──────────────────────────────────────────────┘    │
│  ┌─ No rule (passthrough) ──────────────────────┐    │
│  │ 2. Raw TCP tunnel to destination             │    │
│  │ 3. Log tunnel metadata                       │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  Has: credentials, CA key, proxy + MITM logic        │
│  Does NOT have: shell, tools, Claude,                │
│  Telegram libs, message parsers,                     │
│  any attack surface from untrusted input             │
└──────────────────────┬───────────────────────────────┘
                       │ Podman network
             ┌─────────┴──────────┐
             │                    │
    ┌────────▼────────┐  ┌────────▼────────┐
    │    agent-1      │  │    agent-2      │  (ephemeral, per-task)
    │                 │  │                 │
    │ HTTPS_PROXY=    │  │ HTTPS_PROXY=    │
    │ flowhelm-mark-  │  │ flowhelm-mark-  │
    │ proxy:10255     │  │ proxy:10255     │
    │                 │  │                 │
    │ Trusts FlowHelm │  │ Trusts FlowHelm │
    │ CA (mounted)    │  │ CA (mounted)    │
    │                 │  │                 │
    │ No real keys    │  │ No real keys    │
    └─────────────────┘  └─────────────────┘
```

## Why Per-User Container, Not Other Options

### vs. Embedded in orchestrator (original V2 proposal)
The orchestrator parses untrusted messages from Telegram, WhatsApp, Gmail. If a library vulnerability in grammY or Baileys is exploited, the attacker lands in a process that holds real credentials. Separating the proxy into its own container means the orchestrator never touches credentials.

### vs. Per-agent sidecar (one proxy per agent container)
Agent tasks are ephemeral (seconds to minutes). Starting a proxy container for each task adds ~2s latency and doubles container count. The proxy must be warm and ready. One per user, always running, serves all that user's agent containers with zero startup overhead.

### vs. Single proxy per VM (shared across users)
Defeats multi-tenant isolation. One proxy holding all users' credentials is the exact shared-state problem we eliminate everywhere else.

### vs. External gateway service (separate process + database)
An external MITM gateway would require its own database, dashboard, and release cycle — three additional processes. FlowHelm's proxy is self-contained: ~200 lines of code, runs in a 20 MB container, has no database, and is fully managed by the orchestrator lifecycle. No external dependencies, no separate deployment.

## Credential Storage

```
~/.flowhelm/secrets/
├── credentials.enc          # AES-256-GCM encrypted JSON (ALL secrets)
├── credentials.key          # 32-byte master encryption key (chmod 400)
├── ca.key                   # Per-user CA private key (chmod 400)
└── ca.crt                   # Per-user CA certificate (chmod 644)

~/.flowhelm/logs/proxy/
├── proxy-audit.log          # Proxied request log (append-only, metadata only)
└── proxy-cost.log           # API usage/token counts (append-only, JSON-lines)
```

`credentials.enc` is the single encrypted vault for all secrets. It contains HTTP proxy injection rules (`credentials[]`), cert pinning bypass lists (`pinningBypass[]`), and general-purpose secrets (`secrets{}`) — including the PostgreSQL password. The encryption key at `credentials.key` (mode 0400) is the single master key. See ADR-055.

The `CredentialStore` class auto-generates the key on first use. The orchestrator decrypts `credentials.enc` at boot and distributes secrets to containers at creation time:

- **Proxy container**: receives `PROXY_DECRYPTION_KEY` (hex-encoded key) + `credentials.enc` mount. Decrypts and uses `credentials[]` for MITM injection. Ignores `secrets{}`.
- **Channel container**: receives `CREDENTIAL_KEY` (hex-encoded key) + `credentials.enc` mount + `DB_PASSWORD` env var. Decrypts and uses channel credentials from `credentials[]`. Gets DB password via env var (not from decrypting secrets).
- **DB container**: receives `POSTGRES_PASSWORD` env var (extracted from `secrets["db-password"]`).
- **Agent containers**: never see `credentials.enc`. Only get proxy URL + CA cert + placeholder API key.

No container queries a secrets service at runtime. This is a file-based encrypted vault (like SOPS/age), not a runtime secrets platform (like Vault/Doppler).

### Credential Rules Schema

Defined in `src/proxy/credential-schema.ts` using Zod. Stored as encrypted JSON in `credentials.enc`.

```json
{
  "credentials": [
    {
      "name": "Anthropic",
      "hostPattern": "api.anthropic.com",
      "header": "x-api-key",
      "value": "sk-ant-primary-key",
      "values": ["sk-ant-key-1", "sk-ant-key-2", "sk-ant-key-3"],
      "rateLimit": { "requests": 100, "windowSeconds": 3600 },
      "rules": {
        "methods": ["POST"],
        "pathPrefixes": ["/v1/messages", "/v1/complete"],
        "maxBodySize": 4194304
      },
      "expiresAt": 1712534400000
    },
    {
      "name": "Google OAuth",
      "hostPattern": "*.googleapis.com",
      "header": "Authorization",
      "value": "Bearer ya29.real-token-here",
      "rateLimit": { "requests": 250, "windowSeconds": 60 }
    }
  ],
  "pinningBypass": ["pinned.googleapis.com"],
  "secrets": {
    "db-password": "random-24-byte-base64url-value"
  }
}
```

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Human-readable credential name (max 128 chars) |
| `hostPattern` | Yes | Exact host or `*.domain.com` wildcard |
| `header` | Yes | HTTP header to inject (e.g., `x-api-key`, `Authorization`) |
| `value` | Yes | Primary credential value |
| `values` | No | Multiple values for round-robin distribution (overrides `value` when present) |
| `rateLimit` | No | `{ requests, windowSeconds }` sliding window limit |
| `rules` | No | `{ methods?, pathPrefixes?, maxBodySize? }` request-level restrictions |
| `expiresAt` | No | Unix timestamp (ms) for expiration warnings |
| `pinningBypass` | No | Top-level array of hostnames that skip MITM (cert pinning) |
| `secrets` | No | Top-level key-value map for non-HTTP secrets (DB password, internal tokens) |

Host patterns support exact match (`api.anthropic.com`) and wildcard prefix (`*.googleapis.com`). The wildcard matches any subdomain but not the bare domain itself.

## Proxy Container Spec

The proxy container is built from `container-image/Containerfile.proxy`:
- Base: Alpine Linux + Node.js 22
- Total image size: ~20-30 MB
- RAM usage: ~15-30 MB
- Shell removed at build time (security hardening)
- Read-only filesystem (`--read-only`), writable tmpfs for `/tmp` (10 MB)
- Bind-mounted logs directory (`~/.flowhelm/logs/proxy/` → `/var/log/flowhelm`) for persistent audit and cost logs
- Runs as non-root user (uid 1000) inside user's UID namespace
- `no-new-privileges` security option
- Health check: `GET /healthz` every 15s, 3 retries

The `ProxyManager` (`src/proxy/proxy-manager.ts`) handles the full lifecycle:

```bash
# Equivalent to what ProxyManager.start() does:
podman create \
  --name flowhelm-proxy-mark \
  --network flowhelm-network-mark \
  --memory 64m \
  --cpus 0.25 \
  --pids-limit 64 \
  --read-only \
  --userns keep-id \
  --tmpfs /tmp:size=10m,mode=1777 \
  --volume /home/flowhelm-mark/.flowhelm/secrets/credentials.enc:/secrets/credentials.enc:ro,Z \
  --volume /home/flowhelm-mark/.flowhelm/secrets/ca.key:/secrets/ca.key:ro,Z \
  --volume /home/flowhelm-mark/.flowhelm/secrets/ca.crt:/secrets/ca.crt:ro,Z \
  --volume /home/flowhelm-mark/.flowhelm/logs/proxy:/var/log/flowhelm:Z \
  --env PROXY_DECRYPTION_KEY=${key_hex} \
  --env PROXY_PORT=10255 \
  --security-opt no-new-privileges \
  flowhelm-proxy:latest \
  node /app/main.js
```

The manager starts health checks every 30s (configurable) and auto-restarts the container on failure.

## Rate Limiting

Per-host, per-window rate limits prevent runaway agents from burning API credits or triggering provider bans. When a limit is hit:
1. Proxy returns 429 to the agent container
2. Agent sees "rate limited" and reports to orchestrator
3. Orchestrator notifies user via Telegram: "⏸️ Anthropic rate limit hit (100/hr). Next window in 23 min."
4. Message re-queued for later processing

## Audit Log

Every proxied request is logged (append-only):
```
2026-04-03T14:22:01Z POST api.anthropic.com /v1/messages 200 1.2s credential=Anthropic
2026-04-03T14:22:05Z POST api.openai.com /v1/audio/transcriptions 200 2.1s credential=OpenAI
2026-04-03T14:22:08Z GET gmail.googleapis.com /gmail/v1/users/me/messages 200 0.4s credential=Google
```

No request/response bodies are logged — only method, host, path, status, latency, and which credential was used. This is sufficient for debugging and cost tracking without leaking sensitive data.

## Proxy Entrypoint (`src/proxy/main.ts`)

The proxy container runs `node proxy-server.js` as its entrypoint, which is the compiled output of `src/proxy/main.ts`. On startup, the entrypoint:

1. **Reads the decryption key** from the `PROXY_DECRYPTION_KEY` environment variable (hex-encoded, passed by `ProxyManager` at container creation).
2. **Loads credentials**: reads `/secrets/credentials.enc` (bind-mounted from host) and decrypts using AES-256-GCM with the decryption key. Credentials are parsed into `CredentialRule[]` and held in memory.
3. **Falls back to passthrough mode**: if no decryption key is set or no credentials file exists (e.g., first boot before any credentials are stored), the proxy starts with an empty ruleset. It still provides CONNECT tunneling, rate limiting (if any rules are later loaded), and audit logging — it just has no credentials to inject.
4. **Registers rate limits** from credential rules that specify them.
5. **Starts the HTTP proxy server** on the configured port (default 10255).

The proxy handles graceful shutdown on `SIGTERM` / `SIGINT`, draining active connections before exiting.

## MITM TLS Interception

The original proxy design (Phase 4D) had a fundamental limitation: HTTPS CONNECT tunnels are end-to-end encrypted, so the proxy could not inspect or modify traffic inside them. Credential injection only worked for plaintext HTTP requests within the Podman network. This forced auth tokens (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`) to be forwarded as environment variables directly into agent containers — the exact attack surface the proxy was designed to eliminate.

MITM TLS interception solves this. For any host with a matching credential rule, the proxy terminates the agent's TLS connection, reads the plaintext HTTP request, injects the real credential header, and forwards over a new TLS connection to the real server. Hosts without credential rules remain raw TCP passthrough — the proxy never intercepts traffic it has no business reading.

### Virtual HTTP Server Architecture (ADR-047)

The MITM handler uses Node's built-in HTTP server on the decrypted TLS socket rather than manual HTTP parsing. After the TLS handshake completes, the handler creates a virtual `http.Server` (never bound to a port) and feeds the TLS socket to it via `server.emit('connection', tlsSocket)`. Node's HTTP parser then handles all protocol framing natively — keep-alive, chunked Transfer-Encoding, Content-Length, request boundaries, and backpressure.

This is the natural approach for HTTP-over-existing-socket in Node.js: the HTTP server sets up its parser and listeners, then processes requests as decrypted data arrives. Each request arrives as a standard `(IncomingMessage, ServerResponse)` callback pair, identical to how the main proxy's forward-proxy handler works. The forwarding logic — `req.pipe(proxyReq)` for request bodies, `proxyRes.pipe(res)` for responses — uses the same battle-tested streaming patterns as the rest of Node's HTTP stack.

**Why this matters**: Claude Code CLI reuses TLS connections for multiple API calls (HTTP keep-alive). A proxy that only handles one request per CONNECT tunnel would break after the first API call. By delegating connection lifecycle to Node's HTTP server, keep-alive is handled automatically — the server calls the request handler for each new request on the same connection, exactly as it does for normal HTTP connections.

```
Agent container                    Proxy container                     Real server
─────────────────                  ─────────────────                   ───────────
CONNECT api.anthropic.com:443
    ──────────────────────────────►
                                   Match host → credential rule found
                                   ◄── 200 Connection Established ──►
TLS ClientHello (SNI: api.anthropic.com)
    ──────────────────────────────►
                                   TLS ServerHello (cert signed by FlowHelm CA)
    ◄──────────────────────────────
TLS handshake complete
                                   [Virtual HTTP server on decrypted socket]
POST /v1/messages HTTP/1.1         handleMitmRequest() callback:
Host: api.anthropic.com              - Select credential by headers
x-api-key: placeholder               - Inject real credential
    ──────────────────────────────►   - Strip competing auth headers
                                     - req.pipe(proxyReq) → upstream
                                                                       POST /v1/messages
                                                                       x-api-key: sk-ant-...
                                       ──────────────────────────────►
                                                                       200 OK (streaming)
                                       ◄──────────────────────────────
                                     proxyRes.pipe(res) → agent
    ◄──────────────────────────────
200 OK (streaming)
                                   [Keep-alive: server waits for next request]
POST /v1/messages HTTP/1.1         handleMitmRequest() called again
    ──────────────────────────────►   ...same flow...
```

### Header-Aware Credential Selection

When multiple credential rules match the same host (e.g., both OAuth and API key rules for `api.anthropic.com`), the MITM handler selects the correct one based on the agent's actual HTTP headers. If the agent sends an `authorization` header, the OAuth credential rule is selected; if it sends `x-api-key`, the API key rule is selected. This is determined by the `credentialMethod` config option (see Credential Method Configuration below), which controls which placeholder the agent receives.

### Request Flow (Passthrough)

For hosts without credential rules (or when no credentials are configured), CONNECT requests are handled as raw TCP tunnels. The proxy cannot see traffic content — it only logs tunnel metadata (host, port, duration) and enforces rate limits if applicable.

### ALPN Negotiation

ALPN is forced to `http/1.1` during the MITM TLS handshake. Claude Code CLI and the Agent SDK use HTTP/1.1 for Anthropic API calls. HTTP/2 multiplexing would complicate per-request header injection, so it is intentionally not supported for MITM'd connections. Passthrough tunnels are unaffected and support any protocol.

## CA Certificate Management

Each FlowHelm user gets a dedicated Certificate Authority. Compromise of one user's CA does not affect other users — the per-user isolation model extends to cryptographic trust boundaries.

### Auto-Generation

The CA is generated on first proxy start by `ensureCA()` in `src/proxy/ca-manager.ts`. If CA files already exist on disk, they are loaded instead.

| Property | Value |
|---|---|
| Algorithm | RSA 2048-bit |
| Validity | 10 years |
| Subject | `CN=FlowHelm Proxy CA ({username}), O=FlowHelm` |
| Extensions | `basicConstraints: CA=true (critical)`, `keyUsage: keyCertSign, cRLSign (critical)` |
| Signature | SHA-256 |

### File Locations

```
~/.flowhelm/secrets/
├── ca.key    # RSA private key (mode 0400 — owner read only)
└── ca.crt    # Self-signed CA certificate (mode 0644 — world readable)
```

The CA key is bind-mounted into the proxy container at `/secrets/ca.key` (read-only). The CA cert is mounted at `/secrets/ca.crt` and also into agent containers for trust (see Agent CA Trust below).

### Per-Domain Certificates

When the MITM handler intercepts a CONNECT request, it generates a per-domain certificate signed by the user's CA:

| Property | Value |
|---|---|
| Algorithm | RSA 2048-bit |
| Validity | 7 days |
| Subject | `CN={hostname}` |
| SAN | `DNS:{hostname}` |
| Extensions | `basicConstraints: CA=false`, `keyUsage: digitalSignature, keyEncipherment (critical)`, `extKeyUsage: serverAuth` |
| Issuer | User's FlowHelm CA |

Per-domain certs are cached in memory using an LRU cache (`CertCache` in `src/proxy/cert-cache.ts`):

| Parameter | Value |
|---|---|
| Max entries | 200 |
| TTL | 7 days |
| Eviction | LRU (least recently used evicted when full) |
| Expiry | Lazy on access (expired entries removed on `get`/`getOrCreate`) |

This means the RSA key generation cost (the most expensive operation) is paid once per domain per 7-day window, not once per connection.

## Rootless Podman UID Mapping

The proxy container uses `--userns=keep-id` to solve the rootless Podman UID mapping problem.

### The Problem

In default rootless Podman, the host user's UID (e.g., flowhelm-mark at uid 1000) maps to container uid 0 (root). All other container UIDs map to subordinate host UIDs (100000+). This means:
- A non-root container process (e.g., `node` at uid 1000) maps to host uid ~101000
- Files owned by the host user (uid 1000) appear as owned by root (uid 0) inside the container
- The non-root process cannot read files owned by uid 0 without world-readable permissions

For the proxy container, the secrets files (`credentials.enc`, `ca.key`) are owned by the host user and have restrictive permissions (0400, 0600). A non-root container process under default UID mapping cannot read them.

### The Fix

`--userns=keep-id` maps the host user's UID directly to the same UID inside the container:

```
Default rootless mapping:          keep-id mapping:
Host uid 1000 → Container uid 0   Host uid 1000 → Container uid 1000
Host uid 100000+ → Container 1+   Host uid 0 → subordinate
```

With `keep-id`, the `node` user (uid 1000 in the `node:22-alpine` image) maps directly to the host user (uid 1000). Bind-mounted files owned by the host user are readable by the container process without any permission changes.

### Configuration

Set in `ProxyManager.buildContainerConfig()`:
```typescript
userNamespace: 'keep-id',  // maps host uid → container uid 1:1
```

The `Containerfile.proxy` uses `USER node` (uid 1000, pre-existing in `node:22-alpine`).

### Tmpfs and Bind Mounts

With `keep-id`, tmpfs mounts are still created as root-owned. Since Podman's `--tmpfs` flag doesn't support `uid`/`gid` options, the `/var/log/flowhelm` directory uses a **host bind mount** instead of tmpfs:

| Mount | Type | Source | Mode | Rationale |
|---|---|---|---|---|
| `/tmp` | tmpfs | (RAM) | 1777 | Standard scratch space. Mode 1777 is safe — single-user container. |
| `/var/log/flowhelm` | bind | `~/.flowhelm/logs/proxy/` | Host owner | Persistent audit/cost logs. Owned by host user, writable via keep-id. |
| `/secrets/*` | bind | `~/.flowhelm/secrets/*` | ro | Credentials and CA. Read-only, owned by host user. |

## Agent CA Trust

Agent containers must trust the FlowHelm CA so that TLS libraries (Node.js, curl, git) accept the MITM certificates without errors. Trust is established at container creation time by `WarmContainerRuntime`.

### Mount

The CA certificate is bind-mounted from the host into the agent container:

```
Host: ~/.flowhelm/secrets/ca.crt
  → Container: /usr/local/share/ca-certificates/flowhelm-proxy-ca.crt (read-only)
```

### Node.js Trust

The `NODE_EXTRA_CA_CERTS` environment variable is set to `/usr/local/share/ca-certificates/flowhelm-proxy-ca.crt`. This extends (not replaces) the default CA bundle for all Node.js processes in the container, including:

- `claude` CLI binary (Node.js-based)
- Agent SDK runner (`sdk-runner.js`)
- Any Node.js tools or MCP servers

### System Trust (curl, git, wget)

After container start, `WarmContainerRuntime` runs:

```bash
update-ca-certificates 2>/dev/null; true
```

This registers the FlowHelm CA in the system CA store (`/etc/ssl/certs/ca-certificates.crt`), which is used by curl, git, wget, and other system tools that rely on OpenSSL/LibreSSL. The command is run best-effort — if it fails (e.g., permission denied), `NODE_EXTRA_CA_CERTS` still covers the primary use case (claude CLI and Agent SDK).

## Credential Migration

The `migrateAuthTokens()` method on `CredentialStore` migrates plaintext auth token files into the encrypted credential store. This is the bridge between the initial setup (where `flowhelm setup` writes raw tokens) and the MITM proxy (which reads credential rules from `credentials.enc`).

### Migration Rules

| Source file | Credential rule name | Host pattern | Header | Value format |
|---|---|---|---|---|
| `~/.flowhelm/secrets/oauth-token` | `anthropic-oauth` | `api.anthropic.com` | `Authorization` | `Bearer {token}` |
| `~/.flowhelm/secrets/api-key` | `anthropic-api-key` | `api.anthropic.com` | `x-api-key` | `{key}` (raw) |

### Behavior

- **When**: Called during orchestrator startup (`src/index.ts`), before the proxy is started.
- **Idempotent**: Skips if a credential rule with the same name already exists in `credentials.enc`.
- **Source files untouched**: The plaintext `oauth-token` and `api-key` files are read but not deleted. They serve as the source of truth until Phase 9 removes them.
- **Empty/missing files**: Silently skipped (no error).
- **Logging**: Prints `[flowhelm] Migrated {file} -> credential rule "{name}"` for each migration performed.

Once migrated, the proxy can intercept HTTPS CONNECT requests to `api.anthropic.com` and inject the real `Authorization` or `x-api-key` header via MITM. When MITM is active, the agent container receives placeholder credentials instead of real tokens (see Placeholder Credentials section above).

## Subscription Auth and Passthrough Mode

For subscription OAuth users (Personal and Team tiers using CLI runtime), there are two modes of operation depending on whether credential migration has been performed:

**With MITM (post-migration):** The OAuth token is stored as an `Authorization: Bearer` credential rule for `api.anthropic.com`. When the claude CLI makes HTTPS requests to the Anthropic API, the proxy intercepts via MITM and injects the real token. The agent container does not need `CLAUDE_CODE_OAUTH_TOKEN` in its environment.

**Without MITM (backward compatibility):** If no credential rule exists for `api.anthropic.com` (migration not yet run, or credentials not yet configured), the proxy falls back to passthrough. In this mode, `WarmContainerRuntime` forwards real tokens from the host environment. This is a backward compatibility path — with MITM active, placeholder credentials are used instead.

The proxy still provides value in passthrough mode:

- **Connection auditing**: Every CONNECT tunnel is logged (target host, port, status, latency, matching credential name if any).
- **Rate limiting**: Per-host sliding window limits apply to CONNECT requests. If a credential rule matches the tunnel's target host, its rate limit is enforced before the tunnel is established.
- **Host blocking**: The proxy can refuse to establish tunnels to unauthorized destinations, acting as an egress firewall for agent containers.

### Placeholder Credentials (Phase 9)

Phase 9 completed the credential migration. When MITM TLS is active (`caCertPath` is set), `WarmContainerRuntime` calls `getPlaceholderEnv()` which detects the auth method and sets the correct placeholder:

| Auth method | Env var set | CLI behavior | Proxy injects |
|---|---|---|---|
| OAuth (`CLAUDE_CODE_OAUTH_TOKEN`) | `CLAUDE_CODE_OAUTH_TOKEN=flowhelm-proxy-placeholder-oauth-token` | CLI sends `Authorization: Bearer placeholder` + `anthropic-beta: oauth-2025-04-20` | Real `Authorization: Bearer sk-ant-oat01-...` |
| API key (`ANTHROPIC_API_KEY`) | `ANTHROPIC_API_KEY=sk-ant-flowhelm-proxy-placeholder-00...` | CLI sends `x-api-key: placeholder` | Real `x-api-key: sk-ant-api03-...` |
| Neither (fallback) | `ANTHROPIC_API_KEY=sk-ant-flowhelm-proxy-placeholder-00...` | Same as API key | Depends on stored credential rule |

**Critical**: Only ONE placeholder must be set per container — never both. If both are present, the CLI prioritizes `ANTHROPIC_API_KEY` and sends `x-api-key`, which may conflict with the stored credential rule (if it's OAuth). The `credentialMethod` config controls which placeholder is injected.

The placeholder must match the auth method so the CLI sends the correct HTTP header. The MITM proxy also strips competing auth headers (e.g., removes `x-api-key` when injecting `Authorization`) to prevent Anthropic from seeing conflicting auth.

When MITM is not active (no CA configured), the runtime falls back to forwarding real tokens from the host environment for backward compatibility.

### Credential Method Configuration

The `credentialMethod` option in `config.yaml` determines which auth mechanism the agent uses:

```yaml
agent:
  runtime: cli          # or sdk
  credentialMethod: oauth  # or api_key, or omit for auto-detect
```

| Value | Placeholder set | Required credential rule | Compatible runtimes |
|---|---|---|---|
| `oauth` | `CLAUDE_CODE_OAUTH_TOKEN` (placeholder) | `Authorization: Bearer` for `api.anthropic.com` | CLI only |
| `api_key` | `ANTHROPIC_API_KEY` (placeholder) | `x-api-key` for `api.anthropic.com` | CLI, SDK |
| *(omitted)* | Auto-detect: prefers OAuth if token exists, else API key | Depends on detection | CLI, SDK (SDK forces `api_key`) |

**SDK runtime constraint**: The Agent SDK only supports API key auth (`x-api-key`). If `runtime: sdk` and `credentialMethod: oauth` are both set, FlowHelm exits with a fatal error at startup. When `credentialMethod` is omitted with SDK runtime, it defaults to `api_key`.

Three credential scenarios are supported and tested:

1. **CLAUDE_CODE_OAUTH_TOKEN + CLI runtime**: User has a subscription OAuth token. CLI sends `Authorization: Bearer` header. MITM injects real OAuth token.
2. **ANTHROPIC_API_KEY + CLI runtime**: User has an API key. CLI sends `x-api-key` header. MITM injects real API key.
3. **ANTHROPIC_API_KEY + SDK runtime**: SDK runner sends `x-api-key` header. MITM injects real API key.

## Implementation Status

**Phase 4D (complete):** Per-user proxy container with encrypted credential storage, HTTP forward proxy, sliding window rate limiting, and append-only audit log. See ADR-012.

**Phase 7 (complete):** MITM TLS interception for CONNECT requests with matching credential rules. Per-user CA auto-generation, per-domain cert signing with LRU caching, agent CA trust via bind mount + `NODE_EXTRA_CA_CERTS` + `update-ca-certificates`. Credential migration from plaintext auth files into encrypted credential rules. Agents no longer require real credentials in environment variables (Phase 1 env var forwarding retained for backward compatibility).

**Source files:**
- `src/proxy/main.ts` — Proxy container entrypoint (SIGHUP reload, expiry checks, metrics/cost wiring)
- `src/proxy/credential-schema.ts` — Zod-validated credential rules schema (with `values`, `rules`, `expiresAt`, `pinningBypass`)
- `src/proxy/credential-store.ts` — AES-256-GCM encryption, key management, `migrateAuthTokens()`, `CredentialStore` class
- `src/proxy/rate-limiter.ts` — Sliding window per-host rate limiter
- `src/proxy/audit-log.ts` — Append-only request metadata log
- `src/proxy/proxy-server.ts` — HTTP CONNECT proxy with credential injection, MITM, rules enforcement, `/metrics` endpoint
- `src/proxy/proxy-manager.ts` — `ProxyManager` container lifecycle (Startable), CA mount, `reloadCredentials()` via SIGHUP
- `src/proxy/ca-manager.ts` — Per-user CA generation, per-domain cert signing, persistence
- `src/proxy/cert-cache.ts` — LRU cache with TTL for per-domain TLS certificates
- `src/proxy/mitm-handler.ts` — MITM TLS termination via virtual HTTP server pattern, header-aware credential selection, rules enforcement, key rotation, cost parsing
- `src/proxy/key-rotator.ts` — Multi-key round-robin selector (Phase 9)
- `src/proxy/metrics.ts` — Request/latency metrics with percentile tracking (Phase 9)
- `src/proxy/placeholders.ts` — Placeholder credential constants for agent containers (Phase 9)
- `src/proxy/cost-log.ts` — Append-only cost/usage JSON-lines log (Phase 9)
- `container-image/Containerfile.proxy` — Alpine + Node.js 22 container image
- `tests/proxy-refinements.test.ts` — Phase 9 tests (43 tests)

**Phase 9 (complete):** SIGHUP warm-restart, multi-key round-robin, request-level rules enforcement, certificate pinning bypass, `/metrics` JSON endpoint, placeholder credentials (real keys removed from agent containers), cost tracking via file log, credential expiration detection with warnings. See ADR-046.
