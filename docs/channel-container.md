# Channel Container Architecture

## Overview

The `flowhelm-channel-{username}` container is a unified, always-on container that hosts all channel adapters (Telegram, Gmail, WhatsApp, Slack, etc.) for a single user. It moves all channel I/O and channel credentials out of the orchestrator process, making the orchestrator a pure message broker + memory system with zero external network connections and zero channel credentials.

**Phase**: 11 (see `docs/implementation-plan.md`)
**ADR**: ADR-054 (see `docs/decisions.md`)
**Container name**: `flowhelm-channel-{username}`
**Port**: 9000 (configurable)

## Motivation

The orchestrator currently hosts channel adapters in-process. This means:

1. **Credential exposure**: Orchestrator holds Gmail OAuth tokens and Telegram bot tokens it doesn't need for its core job (routing, memory, identity).
2. **Mixed concerns**: Always-on channel I/O (Telegram polling, IMAP IDLE, Pub/Sub pull) shares a process with agent lifecycle, memory consolidation, and message routing.
3. **No structural isolation**: If the orchestrator process is compromised, channel credentials are exposed. Token scoping is the only protection.

Anthropic's Claude Managed Agents architecture (released 2026-04-08) validates this decomposition. They separate the "brain" (Harness) from "hands" (Sandboxes/Tools) with a dedicated credential proxy between them. Their key insight: **structural isolation** (not just token scoping) ensures untrusted environments physically cannot reach credentials.

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Per-User Podman Network: flowhelm-network-{username}            │
│                                                                   │
│  ┌─────────────────────────┐   ┌──────────────────────────┐     │
│  │ flowhelm-channel-{user} │   │ flowhelm-proxy-{user}    │     │
│  │ :9000                   │   │ :10255                    │     │
│  │                         │   │ MITM credential injection │     │
│  │ Telegram adapter        │   └──────────────────────────┘     │
│  │ Gmail adapter           │                                     │
│  │ (future: WhatsApp,      │   ┌──────────────────────────┐     │
│  │  Slack, etc.)           │   │ flowhelm-service-{user}  │     │
│  │                         │   │ :8787 (STT/Vision)       │     │
│  │ HTTP API:               │   └──────────────────────────┘     │
│  │   POST /send            │                                     │
│  │   POST /gws             │   ┌──────────────────────────┐     │
│  │   GET  /healthz         │   │ flowhelm-agent-{user}-*  │     │
│  │   GET  /status          │   │ (warm, via proxy)        │     │
│  └───────┬─────────────────┘   └──────────────────────────┘     │
│          │                                                        │
│          │ writes inbound to PG                                   │
│          ▼                                                        │
│  ┌─────────────────────────┐   ┌──────────────────────────┐     │
│  │ flowhelm-db-{username}  │◄──│ Orchestrator (host)      │     │
│  │ :5432                   │   │ Memory, identity, agent  │     │
│  │ PG 18 + pgvector        │   │ NO channel credentials   │     │
│  │ LISTEN/NOTIFY           │   │ Calls channel:9000/send  │     │
│  └─────────────────────────┘   └──────────────────────────┘     │
└──────────────────────────────────────────────────────────────────┘
```

## Comparison with Claude Managed Agents

```
Anthropic Managed Agents          FlowHelm (after Phase 11)
─────────────────────────         ─────────────────────────
Session (event log)         ←→    flowhelm-db-{user} (PG: messages, memory, queue)
Harness (agentic loop)      ←→    Orchestrator + MCP server (routing, memory, identity)
Sandbox (code execution)    ←→    flowhelm-agent-{user}-* (warm containers)
Tools (external services)   ←→    flowhelm-channel-{user} (channel I/O tools)
Credential vault + proxy    ←→    flowhelm-proxy-{user} (MITM TLS, AES-256-GCM vault)
```

Key alignment:
- Both use a dedicated proxy for structural credential isolation
- Both treat the session log (PG) as the durable source of truth
- Both keep the orchestration layer recoverable from persistent state

Key difference: Anthropic uses lazy sandbox provisioning (containers spin up only on tool calls). FlowHelm uses warm containers (always alive, 60min idle). Correct for our use case: always-on personal agents need sub-second response.

## Communication Protocol

### Inbound: Channel Container -> Orchestrator (PostgreSQL direct write)

The channel container connects to `flowhelm-db-{user}:5432` on the same Podman network and writes directly to PostgreSQL:

1. Channel adapter receives message (Telegram poll, IMAP notification, etc.)
2. Normalize to `InboundMessage`
3. `ChannelDbWriter.upsertChat()` — ensure chat row exists (FK prerequisite)
4. `ChannelDbWriter.storeMessage()` — INSERT into `memory_working` with `session_id = NULL`
5. `ChannelDbWriter.enqueueMessage()` — INSERT into `queue`
6. PG trigger fires `NOTIFY new_message`
7. Orchestrator's existing `queue.subscribe()` picks it up (zero changes to dequeue logic)

**Why PG and not HTTP?** Crash-safe: if the orchestrator is down when a message arrives, it's safely queued in PG and will be processed when it restarts. Reuses 100% of existing LISTEN/NOTIFY infrastructure. No new HTTP server needed on the orchestrator.

**Session backfill**: Messages are written with `session_id = NULL` because session management is memory-layer logic (stays in orchestrator). The orchestrator backfills with a single UPDATE immediately after dequeue:

```sql
UPDATE memory_working SET session_id = $sessionId
WHERE id = $messageId AND session_id IS NULL
```

### Outbound: Orchestrator -> Channel Container (HTTP POST)

The orchestrator calls the channel container's HTTP API:

```
POST http://flowhelm-channel-{user}:9000/send
Content-Type: application/json

{
  "channel": "telegram",
  "userId": "tg:123",
  "text": "Hello from your agent!",
  "replyToMessageId": "msg-456"
}
```

Low latency (~1ms container-to-container on Podman network). Matches the proven ServiceClient pattern exactly.

## HTTP API Reference

### POST /send

Send a message to any channel.

**Request**:
```json
{
  "channel": "telegram" | "gmail" | "whatsapp",
  "userId": "tg:123",
  "text": "Message text",
  "replyToMessageId": "optional-msg-id"
}
```

**Response**: `200 OK` with `{ "success": true }` or `4xx/5xx` with error.

### POST /gws

Execute any Google Workspace CLI command. Replaces the previous `/email/send`, `/gmail/search`, `/gmail/read`, and `/contacts/*` endpoints with a single generic endpoint that delegates to the gws CLI binary (Apache 2.0, by ex-Googlers, ~24k stars).

The channel container holds the gws binary and OAuth credentials. On each request, it refreshes the OAuth access token, sets `GOOGLE_WORKSPACE_CLI_TOKEN`, and executes the gws command.

**Request**:
```json
{
  "command": "gmail +send --to bob@example.com --subject \"Hello\" --body \"Hi Bob\"",
  "timeout": 30000
}
```

**Response**: `200 OK` with:
```json
{
  "success": true,
  "output": "{\"id\":\"msg-id\",\"threadId\":\"thread-id\"}",
  "exitCode": 0
}
```

Common gws commands:
- Send email: `gmail +send --to X --subject Y --body Z`
- Search email: `gmail users messages list --params '{"q":"from:alice"}'`
- Read email: `gmail +read --id MESSAGE_ID`
- Search contacts: `people people searchContacts --params '{"query":"John","readMask":"names,emailAddresses,phoneNumbers"}'`
- Create contact: `people people createContact --json '{"names":[{"displayName":"Alice"}]}'`
- Calendar: `calendar events list --params '{"calendarId":"primary"}'`
- Drive: `drive files list --params '{"pageSize":10}'`

**Implementation notes:**
- The gws binary is the **musl** build (`x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl`) — required for Alpine-based containers. The glibc build fails with `ld-linux-x86-64.so.2: not found`.
- The `HOME` env var is set to `/tmp` when executing gws. The gws CLI caches API discovery documents under `$HOME/.cache/gws/`. Without this, the read-only root filesystem causes a `Read-only file system (os error 30)` error. This is not a credential issue — just API schema caching.
- The `GOOGLE_WORKSPACE_CLI_TOKEN` env var receives a fresh OAuth2 access token (1h expiry) from the `gwsTokenProvider`, which calls `GmailClient.getAccessToken()` to auto-refresh from the stored refresh token.

See ADR-059 for the design rationale.

### GET /healthz

Health check.

**Response**: `200 OK` with:
```json
{
  "status": "ok" | "degraded",
  "channels": {
    "telegram": "connected" | "disconnected" | "not_configured",
    "gmail": "connected" | "disconnected" | "not_configured"
  },
  "uptimeMs": 123456
}
```

### GET /status

Detailed channel status.

**Response**: `200 OK` with per-channel connection details, error counts, last message timestamps.

## Credential Flow

The channel container is **trusted infrastructure** (our code, not arbitrary agent code). The MITM proxy protects against compromised *agent* containers. The security boundary is between agent containers and everything else, not between infrastructure containers.

Channel credentials:
- `credentials.enc` mounted read-only at `/secrets/credentials.enc`
- Decryption key passed via `CREDENTIAL_KEY` env var (same pattern as proxy container)
- Channel container decrypts in-memory at startup, never writes decrypted secrets to disk

### Per-Channel Credential Handling

| Channel | Credential Type | How Obtained | Protocol |
|---|---|---|---|
| Telegram | Bot token | Decrypted from vault | HTTP API (grammY polling) |
| Gmail (API) | OAuth access token | Refresh via OAuth endpoint | HTTPS REST API |
| Gmail (IMAP) | OAuth access token | Same refresh, used for XOAUTH2 SASL | Raw TLS to imap.gmail.com |
| Gmail (Pub/Sub) | Service account JWT | Signed with SA private key | HTTPS REST API |
| WhatsApp | Session credentials | Baileys pairing | WebSocket |
| Slack | Bot token + app token | Decrypted from vault | WebSocket (Bolt) |

Note: IMAP XOAUTH2 needs raw access tokens over a TLS socket, not HTTP. This is why the channel container decrypts credentials directly rather than routing through the MITM proxy. The MITM proxy is designed for HTTP CONNECT tunnels.

## Database Access

The `ChannelDbWriter` is a thin PostgreSQL adapter (~80 lines of SQL) using the `postgres` library directly. It is NOT the full `FlowHelmDatabase` — minimal coupling by design.

### Methods

| Method | SQL | Purpose |
|---|---|---|
| `resolveDefaultProfileId()` | `SELECT id FROM agent_profiles WHERE is_default = true LIMIT 1` | Cached at startup for FK resolution |
| `upsertChat(...)` | `INSERT INTO chats ... ON CONFLICT DO UPDATE` | Ensure chat row exists before queue insert |
| `storeMessage(...)` | `INSERT INTO memory_working (...)` | Store normalized message (session_id = NULL) |
| `enqueueMessage(...)` | `INSERT INTO queue (...)` | Enqueue for orchestrator processing (triggers NOTIFY) |

### FK Constraints

The `queue` and `memory_working` tables both have foreign keys to `chats(id)`. The channel container must upsert the chat row before inserting messages or queue entries.

## Container Specification

```
Name:     flowhelm-channel-{username}
Image:    flowhelm-channel:latest
Memory:   256m (configurable)
CPU:      0.5 (configurable)
PIDs:     128
Network:  flowhelm-network-{username}
Port:     9000 (configurable)

Mounts:
  ~/.flowhelm/secrets/credentials.enc  → /secrets/credentials.enc (RO)
  ~/.flowhelm/secrets/ca.crt           → /secrets/ca.crt (RO)
  ~/.flowhelm/downloads/               → /downloads (RW)
  ~/.flowhelm/logs/channels/           → /var/log/flowhelm (RW)

Environment:
  CREDENTIAL_KEY     — hex-encoded 32-byte AES decryption key
  CHANNEL_PORT       — HTTP server port (default: 9000)
  DB_HOST            — flowhelm-db-{username}
  DB_PORT            — 5432
  DB_USER            — flowhelm
  DB_PASSWORD        — from encrypted vault (secrets["db-password"] in credentials.enc)
  DB_NAME            — flowhelm
  TELEGRAM_ENABLED   — true/false
  GMAIL_ENABLED      — true/false
  GMAIL_TRANSPORT    — pubsub/imap
  ... (channel-specific config as env vars)
  NODE_ENV           — production

Security:
  --security-opt no-new-privileges
  --userns=keep-id
  --read-only (with /tmp tmpfs 50m)
```

## Startup Order

```
1. CredentialStore           ← decrypt credentials.enc, get DB password (ADR-055)
2. flowhelm-proxy-{user}    ← credentials for agent containers
3. flowhelm-db-{user}       ← PG with password from encrypted vault
4. flowhelm-channel-{user}  ← needs DB, reads channel credentials
5. flowhelm-service-{user}  ← optional, for STT
6. Orchestrator              ← connects to DB, subscribes to NOTIFY
7. flowhelm-agent-{user}-*  ← created on-demand by orchestrator
```

The channel container retries PG connection with a deadline (same pattern as the orchestrator).

## Voice Message Handling

1. Telegram adapter (in channel container) downloads audio to `/downloads/voice-{id}.ogg`
2. `audioPath` in InboundMessage uses the host-relative path
3. Orchestrator reads from host path, sends to service container for STT
4. Orchestrator deletes audio file after transcription

The `/downloads/` directory is a shared bind mount:
- Channel container: RW (writes downloaded media)
- Service container: RO (reads for transcription)
- Orchestrator (host): delete (cleanup after processing)

## Cross-Channel Notification Routing

Gmail → Telegram notifications become simpler with the channel container: both adapters are in the same process. GmailAdapter's `notificationAdapter` references the local TelegramAdapter instance. Zero network hop, no inter-container communication needed.

## Failure Modes

| Failure | Impact | Recovery |
|---|---|---|
| Channel container crash | No message reception | Auto-restart via ChannelManager (30s health check). Messages already in PG queue are preserved. |
| PG connection lost | Can't store or enqueue messages | Retry with exponential backoff. Messages buffered in adapter (grammY has internal buffer). |
| Orchestrator down | Messages queued but not processed | PG queue preserves messages. Orchestrator processes on restart (crash recovery). |
| Single channel adapter crash | Other channels unaffected | Per-adapter error isolation. Health check reports degraded status. |
| Credential expiration | Channel disconnects | ChannelManager can send SIGHUP for credential reload (same as proxy). |

## Source Files

| File | Purpose |
|---|---|
| `src/channels/channel-types.ts` | Shared HTTP API types (SendRequest, HealthResponse, etc.) |
| `src/channels/channel-db.ts` | Thin PG adapter (ChannelDbWriter) |
| `src/channels/channel-server.ts` | HTTP server inside channel container |
| `src/channels/channel-client.ts` | HTTP client used by orchestrator |
| `src/channels/channel-manager.ts` | Container lifecycle (create, health, restart) |
| `src/channels/credential-reader.ts` | Decrypt credentials.enc for channel secrets |
| `src/channels/main.ts` | Channel container entrypoint |
| `container-image/Containerfile.channel` | Container image definition |
| `src/channels/telegram/adapter.ts` | Telegram adapter (modified for PG writes) |
| `src/channels/gmail/adapter.ts` | Gmail adapter (modified for PG writes) |

## Testing

- Unit tests: ChannelServer, ChannelDbWriter, ChannelClient (~30 tests)
- Integration tests: Telegram adapter + PG, Gmail adapter + PG (~20 tests)
- Orchestrator refactor tests: ChannelClient mock, session backfill (~10 tests)
- VM deployment: Full stack test with all containers on flowhelm-network
