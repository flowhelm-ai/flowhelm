# Voice Pipeline

## Overview

FlowHelm transcribes voice notes (Ogg/Opus files from Telegram) into text and injects the transcription into the normal message flow. From the agent's perspective, a voice note arrives as a text message — no special handling is needed in the system prompt or skills.

Transcription happens in the orchestrator, not the channel adapter. This design gives transcription access to the full config (API keys, fallback chain), routes API calls through the per-user MITM proxy for credential injection, and makes retries automatic via the existing queue mechanism.

Two backends are supported and can be combined in a primary → fallback chain:

| | OpenAI Whisper API | whisper.cpp (local) |
|---|---|---|
| Cost (25 min/day) | ~$4.50/month | $0.00 |
| Word error rate | ~5–8% | ~10–15% |
| Latency (30 s clip) | ~2 s | ~10–15 s on CPU |
| Offline | No | Yes |
| Privacy | Audio sent to OpenAI | Fully local |

---

## Architecture and Data Flow

```
Voice note (.ogg) arrives from Telegram
  │
  ▼
TelegramAdapter.normalizeVoiceMessage()
  │  ctx.getFile() → download URL
  │  downloadFile(file_path, 'ogg') → /tmp/flowhelm-{user}/voice-{uuid}.ogg
  │  sets InboundMessage.audioPath
  ▼
MessageRouter.route(msg)
  │  stores msg in PostgreSQL (audioPath column persisted)
  │  enqueues item in message_queue table
  ▼
Orchestrator.processQueueItem()
  │
  ├─ Step 0 (voice only): message.audioPath present AND transcriber configured?
  │    │
  │    ▼
  │   Transcriber.transcribe(audioPath, language)
  │    │
  │    ├─ Primary provider (openai_whisper or whisper_cpp)
  │    │   └─ On failure and fallback configured → try fallback provider
  │    │       └─ If fallback also fails → throw primary error
  │    │
  │    └─ Returns TranscriptionResult { text, provider, durationMs, language }
  │
  │  Merge: message.text = (caption + "\n\n" if present) + "[Voice message transcription]: " + text
  │  Cleanup: unlink(audioPath)     ← prevents disk accumulation
  │
  ├─ Step 1: Build memory context (~5K tokens)
  ├─ Step 2: Execute agent (CLI or SDK runtime)
  └─ Step 3: Store agent reply, send outbound message
```

If transcription fails (both providers fail), the orchestrator logs the error and falls back to:
- The caption text (if the user attached a text caption to the voice note), or
- The placeholder string `[Voice message could not be transcribed]`

Agent execution continues in both cases — a transcription failure never drops the message.

---

## Configuration

Configuration lives under the `voice` key in `~/.flowhelm/config.json` (or the equivalent YAML config). All fields have defaults so minimal config is needed to get started.

```json
{
  "voice": {
    "enabled": true,
    "provider": "openai_whisper",
    "fallback": "whisper_cpp",
    "openaiWhisper": {
      "model": "whisper-1",
      "language": "en"
    },
    "whisperCpp": {
      "modelPath": "~/.flowhelm/models/ggml-small.bin",
      "language": "en"
    }
  }
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | Master switch. Set to `true` to enable voice transcription. |
| `provider` | `"openai_whisper"` \| `"whisper_cpp"` | `"openai_whisper"` | Primary transcription backend. |
| `fallback` | `"openai_whisper"` \| `"whisper_cpp"` \| omit | — | Optional fallback. Tried automatically if primary fails. |
| `openaiWhisper.model` | string | `"whisper-1"` | Whisper API model name. |
| `openaiWhisper.language` | string | `"en"` | ISO 639-1 language code sent to the API. |
| `whisperCpp.modelPath` | string | `"~/.flowhelm/models/ggml-small.bin"` | Absolute path to a GGML model file. `~` is expanded. |
| `whisperCpp.language` | string | `"en"` | ISO 639-1 language code passed to the binary. |

### Choosing a provider

**Use `openai_whisper`** if you have an OpenAI API key and want fast, accurate transcription with minimal setup. The API key is injected at the network level by FlowHelm's MITM proxy — you do not need to set `OPENAI_API_KEY` in the environment.

**Use `whisper_cpp`** if you need offline operation, have strict data-privacy requirements, or want zero marginal cost. Expect 10–15 s latency per 30 s clip on a modern CPU. GPU acceleration is possible if you build whisper.cpp with CUDA/Metal support.

**Use both** (`"provider": "openai_whisper", "fallback": "whisper_cpp"`) for resilience: cloud-fast transcription when the API is reachable, local fallback during outages.

### Language detection

FlowHelm does not auto-detect language. Set the `language` field to the ISO 639-1 code matching your users' primary language. Both providers accept the same codes (`en`, `es`, `de`, `fr`, `pt`, `zh`, `ja`, etc.). Whisper's accuracy drops noticeably when the configured language does not match the spoken language.

---

## Installation: whisper.cpp

whisper.cpp is optional and only needed if you configure `whisper_cpp` as your primary or fallback provider.

### Automated setup: `flowhelm setup voice`

The easiest way to configure whisper.cpp is via the dedicated setup subcommand:

```bash
flowhelm setup voice
```

This walks you through model selection, downloads the model file, and writes the correct config with auto-tuned resource limits. It can also be run as part of the full `flowhelm setup` wizard (the Voice section) or standalone at any time to change your voice configuration.

The wizard offers two models:

| Model | File | Size | Memory Limit | CPU Limit | Threads | Quality | Speed |
|---|---|---|---|---|---|---|---|
| `small` | `ggml-small.bin` | 466 MB | 1536 MB | 2.0 cores | 4 | Good | Fast (~3-5x real-time) |
| `large-v3-turbo` | `ggml-large-v3-turbo.bin` | 1.6 GB | 4096 MB | 4.0 cores | 6 | Best (multilingual) | Slower (~1-2x real-time) |

**Auto-configured resources**: The wizard automatically sets the service container's `memoryLimit`, `cpuLimit`, and whisper.cpp `threads` based on the selected model. Thread count is clamped to `min(recommended, availableCores - 2, 16)` to reserve CPU headroom for other FlowHelm containers (proxy, channel, agent, database).

**Non-interactive mode** (for automation):

```bash
flowhelm setup \
  --voice whisper_cpp \
  --voice-model large-v3-turbo \
  --no-interactive
```

### Manual setup

If you prefer manual installation:

**1. Build from source (recommended)**

```bash
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
make -j$(nproc)
# Binary is at ./build/bin/whisper-cli
sudo install build/bin/whisper-cli /usr/local/bin/
```

**2. Download a GGML model**

```bash
mkdir -p ~/.flowhelm/models
# Small model (~466 MB) — good balance of speed and accuracy
wget https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin \
  -O ~/.flowhelm/models/ggml-small.bin

# Or large-v3-turbo (~1.6 GB) — best accuracy, multilingual
wget https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin \
  -O ~/.flowhelm/models/ggml-large-v3-turbo.bin
```

**3. Verify installation**

```bash
whisper-cli --version
# FlowHelm also tries `whisper` and `main` as fallback binary names
```

FlowHelm's `WhisperCppProvider.isAvailable()` checks both the binary (via `which`) and the model file (read permission) at startup. If either is missing, the provider is marked unavailable and will not be used.

### Memory requirements

Choose your model based on available system resources:

- **small** (recommended for most setups): Needs ~1.5 GB free memory for the service container. Works well on machines with 8+ GB total RAM.
- **large-v3-turbo** (recommended for multilingual or high-accuracy needs): Needs ~4 GB free memory for the service container. Best on machines with 16+ GB total RAM. Significantly better accuracy for non-English languages.

---

## Source Files

| File | Purpose |
|---|---|
| `src/service/types.ts` | `SttProvider` interface, `SttResult` type, `SttProviderName` union, HTTP API types |
| `src/service/stt-provider.ts` | `WhisperCppSttProvider` — spawns whisper.cpp via `child_process.execFile` |
| `src/service/openai-stt-provider.ts` | `OpenAiSttProvider` — OpenAI Whisper API via `fetch` multipart (zero deps) |
| `src/service/service-server.ts` | HTTP API: `/transcribe`, `/understand`, `/synthesize`, `/healthz` |
| `src/service/service-manager.ts` | Service container lifecycle (create, start, stop, health checks) |
| `src/service/service-client.ts` | HTTP client for orchestrator → service container calls |
| `src/service/main.ts` | Service container entrypoint (provider selection via `SERVICE_STT_PROVIDER`) |
| `src/service/index.ts` | Barrel exports |
| `src/orchestrator/orchestrator.ts` | Transcription hook in `processQueueItem()` (Step 0, before memory context) |
| `src/index.ts` | Wires service container and passes to orchestrator |
| `src/channels/telegram/adapter.ts` | `normalizeVoiceMessage()` — downloads OGG, sets `InboundMessage.audioPath` |
| `src/orchestrator/types.ts` | `InboundMessage.audioPath?: string` field |
| `src/orchestrator/database.ts` | Persists `audio_path` column in `messages` table |
| `src/config/schema.ts` | Zod schema for the `voice` config block and service STT provider enum |

**Tests** (60 tests across 4 files):

| File | Count | What is covered |
|---|---|---|
| `tests/transcriber.test.ts` | 13 | Primary succeeds, fallback activates on failure, both fail (throws primary error), logging, provider name accessors |
| `tests/whisper-api.test.ts` | 10 | Constructor defaults, `isAvailable()` with key/env/missing, API success, error responses, language override, whitespace trimming, custom base URL |
| `tests/whisper-cpp.test.ts` | 15 | Binary discovery order (`whisper-cli` → `whisper` → `main`), timestamp stripping, whitespace collapsing, empty output error, language override, model/audio file not found |
| `tests/openai-stt-provider.test.ts` | 22 | Provider name, isReady, file size/empty checks, mock HTTP server (success, auth, language override, error responses, rate limit, empty text, whitespace trimming), config schema, ServiceManager env vars |

---

## Provider Interface

Both providers implement `TranscriptionProvider`:

```typescript
export interface TranscriptionProvider {
  readonly name: VoiceProvider;
  transcribe(audioPath: string, language?: string): Promise<TranscriptionResult>;
  isAvailable(): Promise<boolean>;
}

export interface TranscriptionResult {
  text: string;
  provider: VoiceProvider;
  durationMs: number;
  language: string;
}
```

Adding a new backend (e.g., Google Speech-to-Text, Azure Cognitive Services) requires only:
1. A class implementing `TranscriptionProvider`
2. A new `VoiceProvider` union member in `transcriber.ts`
3. A case in the `createProvider()` switch in `index.ts`
4. A config block in `src/config/schema.ts`

No orchestrator changes are needed.

---

## Whisper API: Key Injection

The `WhisperApiProvider` resolves the API key in this priority order:

1. `options.apiKey` passed via constructor (config file value)
2. `process.env.OPENAI_API_KEY`

In production, the key is injected at the network level by FlowHelm's MITM proxy. The orchestrator process does not need `OPENAI_API_KEY` in its environment — the proxy intercepts the outbound HTTPS request to `api.openai.com` and injects the `Authorization` header using the credential rule stored in the per-user credential store.

A custom `baseUrl` is supported (e.g., for Azure OpenAI or compatible self-hosted APIs):

```json
{
  "voice": {
    "provider": "openai_whisper",
    "openaiWhisper": {
      "model": "whisper-1",
      "language": "en",
      "baseUrl": "https://my-azure-instance.openai.azure.com"
    }
  }
}
```

## whisper.cpp: Binary Discovery

`WhisperCppProvider` discovers the binary at transcription time (not startup) to handle late installations:

1. If `binaryPath` is set in config → tries that name only
2. Otherwise → tries `whisper-cli`, then `whisper`, then `main` (in order)

This covers the two common whisper.cpp build outputs: newer builds produce `whisper-cli`; older builds produce `main`.

**Output parsing**: whisper.cpp outputs either plain text or timestamped segments:
```
[00:00:00.000 --> 00:00:05.000]  Hello, how are you?
[00:00:05.000 --> 00:00:10.000]  I am fine, thanks.
```
The provider strips timestamp prefixes and collapses all whitespace, producing a single clean string: `Hello, how are you? I am fine, thanks.`

---

## Failure Modes and Recovery

| Failure | Behavior |
|---|---|
| Primary API returns 429 (rate limit) | Fallback activates if configured; otherwise transcription fails gracefully |
| `OPENAI_API_KEY` not set | `WhisperApiProvider` throws immediately; fallback activates if configured |
| whisper.cpp binary not in PATH | `WhisperCppProvider` throws `"whisper.cpp binary not found in PATH"` |
| GGML model file missing | `stat()` throws `ENOENT`; error propagates to fallback chain |
| Both providers fail | Primary error is thrown; orchestrator logs it and sets placeholder text |
| Transcription timeout (whisper.cpp) | Default 120 s timeout; `execFile` throws; error propagates to fallback |
| Audio file already deleted | `stat()` throws `ENOENT` before any network/process call |
| Disk full during download | Download in adapter fails; message is never enqueued; Telegram polling retries |

Audio files are deleted after a successful transcription (`unlink(audioPath)`) to prevent disk accumulation. If transcription throws, the file is **not** deleted — a future retry may still use it if the message is reprocessed. In practice, messages are not requeued on transcription failure (the orchestrator continues with placeholder text), so the file will persist until FlowHelm's temp directory is cleaned by the OS.

**Recommendation for production**: configure `TMPDIR` cleanup (e.g., systemd `RuntimeDirectory=` or a daily `find /tmp -name 'voice-*.ogg' -mtime +1 -delete` cron job) to bound disk usage.

---

## Text Format Injected into the Agent

When transcription succeeds, the agent receives a message in this format:

```
[Voice message transcription]: Hello, I need help with my invoice.
```

If the user attached a caption to the voice note:

```
urgent

[Voice message transcription]: Hello, I need help with my invoice.
```

The caption (if present) is prepended with a blank line separator. The `[Voice message transcription]:` prefix is intentional — it signals to the agent that this text originated from speech recognition and may contain transcription artifacts.

---

## Supported Audio Formats

Telegram delivers voice notes as Ogg/Opus files. The Whisper API and whisper.cpp both accept Ogg natively, so no format conversion is performed.

Both providers also accept: `mp3`, `mp4`, `m4a`, `wav`, `webm`, `mpeg`. This means the same pipeline can be reused for WhatsApp voice notes (AAC/m4a) or other channels without modification.

MIME type detection in `WhisperApiProvider` is based on file extension:

| Extension | MIME type |
|---|---|
| `.ogg` | `audio/ogg` |
| `.mp3` | `audio/mpeg` |
| `.wav` | `audio/wav` |
| `.mp4`, `.m4a` | `audio/mp4` |
| `.webm` | `audio/webm` |
| other | `application/octet-stream` |

---

## TTS Voice Replies

Text-to-speech replies are not implemented. This is a future phase feature. When implemented, Telegram requires Opus-encoded audio in an OGG container for the `sendVoice` API method.

---

## Design Decisions

FlowHelm's voice pipeline uses a provider interface with fallback chain, with several key design choices:

| Area | FlowHelm's Approach | Rationale |
|---|---|---|
| Transcription location | Orchestrator (config-aware, queue-backed retry) | Keeps adapters stateless; retries are free via message queue |
| Provider interface | Explicit TypeScript interface with `isAvailable()` check | Runtime provider selection based on config and availability |
| whisper.cpp output | Strips timestamps, collapses whitespace | Clean text for LLM consumption |
| Binary discovery | Tries `whisper-cli` → `whisper` → `main` | Handles different package manager installations |
| Audio cleanup | Always after success, never on failure | Preserves evidence for debugging failed transcriptions |
| API key injection | Via MITM proxy (no env var needed in prod) | Credential isolation — agent containers never see real API keys |

The decision to transcribe in the orchestrator (rather than the adapter) is documented in `docs/decisions.md`.
