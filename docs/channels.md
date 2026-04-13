# Channels

## Two-Layer Architecture (ADR-011, ADR-027)

Every service integration in FlowHelm has two distinct components:

| Layer | Lives in | Runs in | Purpose |
|---|---|---|---|
| **Channel adapter** | `src/channels/` (main repo) | `flowhelm-channel-{user}` container | Transport: receives/sends messages, always-on when configured |
| **Skill** | `flowhelm-ai/flowhelm-skills/` | Agent container | Capability: teaches the agent HOW to use the service |

**Channel adapters** are infrastructure — always present in the codebase (ADR-011), activated by providing credentials in config. Unconfigured adapters don't start (zero resource cost). All adapters run inside the unified `flowhelm-channel-{username}` container (Phase 11, ADR-054), not in the orchestrator process. This gives the orchestrator zero channel credentials and zero external network connections. See @docs/channel-container.md for the full channel container architecture.

**Skills** are optional agent knowledge — installed by the user via `flowhelm install <name>`. A user might enable the Gmail channel adapter (for email notifications) but choose not to install the `google-email` skill (because they don't want the agent composing emails). This separation gives users control over what their agent can do.

See @docs/skills.md for the full skills architecture.

## Transport Abstraction Pattern (ADR-058)

**Mandatory for all integrations.** Every channel adapter uses a third architectural layer: an abstract **transport interface** that decouples adapter business logic from the underlying library or protocol. This follows the Ports & Adapters (Hexagonal Architecture) pattern.

```
  Adapter (business logic)           Transport Interface          Concrete Implementation
  ─────────────────────────          ───────────────────          ──────────────────────
  TelegramAdapter            ─→     TelegramTransport     ←─    GrammyTransport
  GmailAdapter               ─→     GmailTransport        ←─    GmailApiTransport
  WhatsAppAdapter            ─→     WhatsAppTransport     ←─    BaileysTransport
```

**Transport responsibilities**: connection lifecycle, protocol-specific I/O, message sending/receiving, file downloads, connection state.

**Adapter responsibilities**: filtering, normalization (transport types → `InboundMessage`), access control, cross-channel routing, `ChannelAdapter` interface compliance.

**Testing**: Every channel has a `MockTransport` class implementing the transport interface with test helpers (`simulateMessage()`, `simulateError()`, etc.). Adapter tests use mock transports exclusively — no real library dependencies.

**Adding a new channel**: Implement `{Channel}Transport` interface in `transport.ts` + `{Channel}Adapter` in `adapter.ts`. The transport delivers normalized message types (not raw library types). Factory functions accept an optional transport override for testing.

**Files per channel**:
| File | Purpose |
|---|---|
| `transport.ts` | Abstract interface + concrete implementation |
| `adapter.ts` | Business logic + factory function |
| `index.ts` | Barrel exports |

This pattern also applies to future non-channel integrations (tool providers, calendar backends, etc.) where the underlying library or API might change. See ADR-058 for the full rationale.

## Supported Channels

| Channel | Library | Adapter Phase | Companion Skill | Skill teaches agent... |
|---|---|---|---|---|
| Telegram | grammY | Phase 6 | `telegram` | Inline keyboards, MarkdownV2, media groups, polls, chat actions |
| WhatsApp | Baileys | Phase 12 | `whatsapp` | Message formatting, media messages, platform conventions, group behavior |
| Gmail | gws CLI + Pub/Sub | Phase 8 | `google-email` | Email etiquette + compose, search, label, filter, drafts via gws CLI |
| Calendar | gws CLI | Phase 8 | `google-calendar` | Events, availability, RSVPs, recurring events via gws CLI |
| Voice | Whisper API / whisper.cpp | Phase 7 | `voice` | Transcription handling, multi-language, confidence |
| Discord | discord.js | Planned | `discord` | — |
| Slack | Bolt | Planned | `slack` | — |

## JID Format

Every chat gets a channel-prefixed identifier (JID) to prevent cross-channel collision:

| Channel | JID Format | Examples |
|---|---|---|
| Telegram | `tg:{chatId}` | `tg:123456789` (DM), `tg:-1001234567890` (group) |
| WhatsApp | `wa:{number}@s.whatsapp.net` | `wa:+14155551234@s.whatsapp.net` |
| Gmail | `gmail:{email}` | `gmail:user@example.com` |

## Channel Adapter Interface

All channels implement the `ChannelAdapter` interface defined in `src/orchestrator/types.ts`:

```typescript
export interface ChannelAdapter {
  readonly name: string;
  readonly type: ChannelType;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => void): void;
  isConnected(): boolean;
}
```

The orchestrator is channel-agnostic — it processes `InboundMessage` regardless of origin. The `MessageRouter` handles registration, inbound processing (normalize → store → enqueue), and outbound delivery (send → store bot message → extract memories).

## Telegram (Implemented — Phase 6, ADR-037)

**Source**: `src/channels/telegram/adapter.ts`
**Library**: [grammY](https://grammy.dev/)
**Transport**: Long-polling (outbound only, no exposed ports)

### Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) on Telegram
2. Copy the bot token
3. Add to FlowHelm config:

```yaml
channels:
  telegram:
    botToken: "123456:ABC-DEF..."
    allowedUsers: [789012345]  # Telegram user IDs (empty = allow all)
```

### Features

| Feature | Status | Details |
|---|---|---|
| Text messages | Implemented | Normalized to `InboundMessage.text` |
| Voice notes | Implemented | Downloaded as OGG to `{dataDir}/downloads/`, set as `audioPath` for voice pipeline |
| Photos | Implemented | Highest resolution selected, downloaded as JPG to `{dataDir}/downloads/` |
| Outbound text | Implemented | MarkdownV2 with automatic plain text fallback |
| Message splitting | Implemented | Auto-split at 4096 chars, smart break points (newline > space > hard) |
| Access control | Implemented | `allowedUsers` whitelist; empty = allow all |
| `/start` welcome | Implemented | Intercepted at adapter level — replies with friendly greeting, not forwarded to agent (ADR-064) |
| Reconnection | Implemented | Exponential backoff (base 1s, max 60s, configurable) |
| Inline keyboards | Via skill | `flowhelm install telegram` |
| Typing indicators | Planned | Phase 7 integration |

### Message Normalization

| Telegram field | InboundMessage field | Notes |
|---|---|---|
| `message.message_id` | `id` | String-converted |
| `chat.id` | `userId` | Prefixed as `tg:{chatId}` |
| `from.first_name + last_name` | `senderName` | Falls back to username, then user ID |
| `message.text` or `caption` | `text` | Voice notes have no text (transcription in Phase 7) |
| Voice file path | `audioPath` | Downloaded OGG file via Telegram File API |
| Photo file path | `imagePath` | Downloaded JPG (highest resolution) |
| `message.date * 1000` | `timestamp` | Telegram uses seconds, FlowHelm uses milliseconds |

### Access Control

- **Empty `allowedUsers`** (default): All users can message the bot
- **Non-empty**: Only listed Telegram user IDs are allowed. Others get "Access denied."
- Find your Telegram user ID: message [@userinfobot](https://t.me/userinfobot)

### Polling and 409 Conflict Handling

`GrammyTransport` uses a manual `fetch`-based polling loop instead of Grammy's built-in `bot.start()` / `bot.stop()`. This avoids the 409 Conflict cycling problem: Grammy's `bot.stop()` sends a final `getUpdates` call to confirm offsets, which creates a new Telegram polling session that conflicts with the next `bot.start()`. By controlling the polling loop directly, FlowHelm guarantees exactly one `getUpdates` request at a time. If a 409 response is received (stale session from a previous lifecycle), the transport waits for the stale session to expire naturally (one polling timeout period) and retries, rather than escalating to the adapter and triggering another stop/start cycle.

### Reconnection

Exponential backoff: `min(baseDelay * 2^(attempt-1), maxDelay)`. Resets on success.

### Companion Skill

`flowhelm install telegram` — teaches agent Telegram-specific formatting, inline keyboards, media groups, polls, chat actions, pinning

### Files

| File | Purpose |
|---|---|
| `src/channels/telegram/adapter.ts` | TelegramAdapter class, `/start` interception, helpers, factory |
| `src/channels/telegram/index.ts` | Barrel exports |
| `src/channels/index.ts` | Top-level channel barrel |
| `tests/telegram-adapter.test.ts` | 43 tests |

## WhatsApp (Implemented — Phase 12, ADR-057)

**Source**: `src/channels/whatsapp/adapter.ts`
**Library**: [Baileys](https://github.com/WhiskeySockets/Baileys) (`@whiskeysockets/baileys`)
**Transport**: WebSocket (outbound only, no exposed ports)

### Architecture

WhatsApp support uses a two-layer abstraction:

| Layer | File | Purpose |
|---|---|---|
| `WhatsAppTransport` (interface) | `transport.ts` | Abstract WebSocket transport — connect, send, receive, QR codes |
| `BaileysTransport` (implementation) | `transport.ts` | Baileys-specific implementation of `WhatsAppTransport` |
| `WhatsAppAdapter` | `adapter.ts` | ChannelAdapter — normalization, access control, reconnection |
| `useVaultAuthState` | `auth-state.ts` | Vault-backed auth state (replaces `useMultiFileAuthState`) |

To swap Baileys for another library: implement `WhatsAppTransport` with a different backend. Zero changes to `WhatsAppAdapter`.

### Setup

1. Enable WhatsApp in config:

```yaml
channels:
  whatsapp:
    enabled: true
    allowedNumbers: ["14155551234"]  # Phone numbers (empty = allow all)
    printQrInTerminal: true
```

2. On first connect, scan the QR code with your phone (WhatsApp → Linked Devices → Link a Device)
3. Session is persisted in the encrypted vault (`credentials.enc`) — no re-scan needed until ~2 weeks of inactivity

### Auth State Storage

All WhatsApp session data is stored in the encrypted credential vault (`credentials.enc`), NOT as filesystem files:

| Data | Vault Key | Updated When |
|---|---|---|
| Auth credentials (noise key, signal identity, pre-keys) | `secrets["whatsapp-auth-creds"]` | Every `creds.update` event |
| Signal keys (sessions, sender keys, app state) | `secrets["wa-key:{type}:{id}"]` | Every `keys.set()` call |

This provides AES-256-GCM encryption at rest, consistent with all other FlowHelm credentials (API keys, OAuth tokens, Telegram bot token). See `src/channels/whatsapp/auth-state.ts` for the implementation.

### Features

| Feature | Status | Details |
|---|---|---|
| Text messages | Implemented | Normalized to `InboundMessage.text` |
| Voice notes | Implemented | Downloaded as OGG to `{dataDir}/downloads/`, set as `audioPath` for service STT |
| Photos | Implemented | Downloaded to `{dataDir}/downloads/`, set as `imagePath` |
| Outbound text | Implemented | Plain text with auto-split at 4096 chars |
| Access control | Implemented | `allowedNumbers` whitelist; empty = allow all |
| Reconnection | Implemented | Exponential backoff (base 1s, max 60s, configurable) |
| QR code pairing | Implemented | Terminal display on first connect |
| Message captions | Implemented | Image captions set as `text` on `InboundMessage` |
| Reply context | Implemented | `quotedMessageId` preserved for reply threading |

### Message Normalization

| Baileys field | InboundMessage field | Notes |
|---|---|---|
| `key.id` | `id` | Message ID |
| `key.remoteJid` | `userId` | Prefixed as `wa:{chatJid}` |
| `key.participant` | `metadata.senderJid` | Group sender; equals chatJid for DMs |
| `pushName` | `senderName` | Falls back to number if no push name |
| `message.conversation` | `text` | Plain text; also checks `extendedTextMessage` |
| Audio download buffer | `audioPath` | Saved as OGG file in downloads dir |
| Image download buffer | `imagePath` | Saved as JPG/PNG file in downloads dir |
| `messageTimestamp * 1000` | `timestamp` | Baileys uses seconds, FlowHelm uses milliseconds |

### Access Control

- **Empty `allowedNumbers`** (default): All numbers can message the bot
- **Non-empty**: Only listed phone numbers are allowed. Others are silently ignored.
- Numbers are matched against the sender JID's number portion (e.g., `14155551234`)

### Reconnection

Exponential backoff: `min(baseDelay * 2^(attempt-1), maxDelay)`. Resets on successful connection.

### Risk

Baileys is an unofficial WhatsApp Web API. Potential account ban for detected automation, though rare for personal use. Recommendation: use Telegram as primary channel, WhatsApp for convenience.

### Companion Skill

`flowhelm install whatsapp` — teaches agent WhatsApp-specific formatting, media handling, platform conventions, group behavior

### Files

| File | Purpose |
|---|---|
| `src/channels/whatsapp/transport.ts` | Abstract `WhatsAppTransport` + `BaileysTransport` |
| `src/channels/whatsapp/auth-state.ts` | Vault-backed auth state |
| `src/channels/whatsapp/adapter.ts` | WhatsAppAdapter class |
| `src/channels/whatsapp/index.ts` | Barrel exports |
| `tests/whatsapp-adapter.test.ts` | 42 tests |

## Gmail (Notification Channel)

Not a chat channel — a notification source. The Gmail pipeline (see @docs/gmail-pipeline.md) pushes email notifications into the message queue, which the orchestrator routes to Telegram/WhatsApp for delivery to the user.

- Companion skill: `flowhelm install google-email` — teaches agent email etiquette + full Gmail API operations via gws CLI (compose, search, label, filter, drafts)
- Related skill: `flowhelm install google-calendar` — teaches agent Google Calendar operations via gws CLI (events, availability, RSVPs)

## Setup Flow

Each channel's setup command recommends installing the companion skill:

```
$ flowhelm setup telegram
  ... [bot token configuration] ...

✓ Telegram channel configured.

Recommended: Install the telegram skill for rich Telegram features?
  flowhelm install telegram
  (inline keyboards, media groups, formatting, polls)

Install now? [Y/n]
```

The skill install is always optional. The channel adapter works without it — the agent simply won't have specialized knowledge of platform-specific features.

## Channel Command Interception (Phase 10C)

Users can manage identity and personality directly from any connected channel by sending `/`-prefixed commands. These are intercepted by the orchestrator's `ChannelCommandHandler` in `processQueueItem()` **before** reaching the agent — zero API token cost, instant response.

**Source**: `src/orchestrator/channel-commands.ts`

| Command | Example | What it does |
|---|---|---|
| `/identity show` | `/identity show` | Display agent + user identity |
| `/identity set agent` | `/identity set agent role=Assistant` | Set agent identity field |
| `/identity set user` | `/identity set user name=Mark` | Set user identity field |
| `/personality show` | `/personality show` | Display all personality dimensions |
| `/personality set agent` | `/personality set agent humor=Dry` | Set agent personality dimension |
| `/personality set user` | `/personality set user work_patterns=9-6` | Set user personality dimension |
| `/personality reset` | `/personality reset agent humor` | Delete a dimension (let agent re-infer) |
| `/profile list` | `/profile list` | List agent profiles |
| `/profile show` | `/profile show` | Show current chat's profile |
| `/profile switch` | `/profile switch work-assistant` | Switch chat to a different profile |
| `/help` | `/help` | List all available commands |

Commands are case-insensitive. Unrecognized commands pass through to the agent as normal messages. See `docs/memory.md` for the full identity layer documentation.
