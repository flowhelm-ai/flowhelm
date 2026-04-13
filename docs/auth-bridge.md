# Auth Bridge Service

## Overview

FlowHelm Auth Bridge is a lightweight, self-hostable service running at `flowhelm.to` that enables Tailscale-like authentication for headless VMs. Users scan a QR code or open a short link on their phone/laptop, complete Claude subscription authentication there, and the FlowHelm VM receives the credentials securely via end-to-end encryption.

The bridge solves a fundamental OAuth constraint: Claude Code CLI's OAuth flow redirects to `http://localhost:PORT/callback`, which requires a browser on the same machine. On a headless VM, there is no browser. The bridge mediates the credential transfer without ever seeing the plaintext token.

## Why This Exists

Claude Code CLI uses OAuth 2.0 Authorization Code with PKCE. The redirect URI is `http://localhost:{random_port}/callback`. This works when the user has a browser on the same machine. On a headless VM (where FlowHelm runs), there is no browser.

Existing solutions:
- **SSH port forwarding**: Works but requires SSH knowledge (`ssh -L PORT:localhost:PORT ...`)
- **`claude setup-token`**: Generates a long-lived token on a machine with a browser, user pastes into the VM terminal
- **API keys**: No OAuth needed, but costs $3-15/day

The Auth Bridge provides a fourth option: a QR code the user scans, authenticates on their phone, and the VM receives credentials automatically. Like Tailscale's `tailscale up` flow.

## Architecture

```
User's Phone/Laptop              flowhelm.to                   FlowHelm VM (headless)
─────────────────                ────────────                  ──────────────────────
                                                               1. flowhelm setup auth
                                                                  → generates X25519 keypair
                                                                  → POST /api/session
                                                                    { publicKey: base64 }
                                                                  → receives { token: "x3K9m" }
                                                                  → displays QR code for
                                                                    flowhelm.to/x3K9m
                                                                  → starts polling
                                                                    GET /api/session/{token}/poll

2. User scans QR code
   → opens flowhelm.to/x3K9m
   → 302 redirect to
     flowhelm.to/a/{token}#pk={key}

                                 3. Serves static HTML page:
                                    "Authenticate FlowHelm"
                                    
                                    Instructions:
                                    a) Run: claude setup-token
                                    b) Paste token below
                                    
                                    [input field]
                                    [Connect button]

4. User runs claude setup-token
   on their laptop/phone
   (browser opens → OAuth →
   token displayed)

5. User pastes token into the
   web page input field

6. JavaScript in browser:
   → reads public key from
     URL hash (#pk=...)
   → generates ephemeral X25519
     keypair
   → derives shared secret via
     ECDH (user_priv + vm_pub)
   → encrypts token with
     AES-256-GCM using shared
     secret
   → POST /api/session/{token}
     { encrypted: base64,
       ephemeralPublicKey: base64,
       nonce: base64 }

                                 7. Stores encrypted blob
                                    (opaque bytes, cannot
                                    decrypt — no private key)

                                                               8. Poll returns encrypted blob
                                                                  → VM decrypts with its
                                                                    X25519 private key:
                                                                    ECDH(vm_priv + ephemeral_pub)
                                                                    → shared secret
                                                                    → AES-256-GCM decrypt
                                                                  → Plaintext token obtained
                                                                  → Stores in credentials
                                                                  → "✓ Authenticated"
                                                                  → DELETE /api/session/{token}
```

## Security Properties

1. **End-to-end encryption**: The plaintext token is encrypted in the user's browser with the VM's public key. flowhelm.to receives and stores only ciphertext. The private key never leaves the VM.

2. **Forward secrecy**: The user's browser generates an ephemeral X25519 keypair per session. Even if the VM's long-term key is compromised later, past sessions cannot be decrypted (the ephemeral private key is discarded after encryption).

3. **No plaintext at rest**: flowhelm.to stores encrypted blobs with TTL. Even a database breach reveals nothing useful.

4. **Single-use sessions**: Each session token is valid for one credential transfer. After the VM retrieves the encrypted blob, the session is deleted.

5. **Short-lived**: Sessions expire after 10 minutes. Unclaimed sessions are garbage collected.

6. **Rate limited**: Per-IP rate limiting prevents brute-force enumeration of session tokens.

7. **Public key in URL hash**: The `#pk=...` fragment is never sent to the server (per HTTP spec). The server cannot see the public key.

## Short URL Design

### Character Set

To prevent user confusion when reading or typing short URLs, the following characters are excluded:

| Excluded | Reason |
|---|---|
| `0` (zero) | Confused with `O` (uppercase O) and `o` (lowercase o) |
| `O` (uppercase O) | Confused with `0` (zero) |
| `o` (lowercase o) | Confused with `0` (zero) |
| `1` (one) | Confused with `l` (lowercase L) and `I` (uppercase I) |
| `l` (lowercase L) | Confused with `1` (one) and `I` (uppercase I) |
| `I` (uppercase I) | Confused with `1` (one) and `l` (lowercase L) |

**Safe character set** (56 characters):

```
Digits:    2 3 4 5 6 7 8 9                          (8)
Uppercase: A B C D E F G H J K L M N P Q R S T U V W X Y Z  (24)
Lowercase: a b c d e f g h i j k m n p q r s t u v w x y z  (24)
                                                    Total: 56
```

### Token Length: 5 Characters

With 56 characters and 5 positions: `56^5 = 550,731,776` (~551 million possible tokens).

**Collision analysis**: At peak load (100 concurrent sessions), the probability of generating a duplicate is `100 / 551M = 0.000018%` — negligible. Collisions are also checked at creation time.

**Brute-force analysis**: With rate limiting at 10 requests/second per IP, and 50 active sessions:
- Per request: `50 / 551M = 9.1 x 10^-8` chance of hitting a valid session
- In 10 minutes (6,000 requests): `1 - (1 - 9.1e-8)^6000 ≈ 0.055%`
- With distributed IPs (botnet): Cloudflare/proxy DDoS protection mitigates

5 characters is sufficient. The combination of short TTL (10 min), rate limiting, and E2E encryption makes the attack surface minimal. Even if an attacker guesses a valid token, they cannot decrypt the stored blob without the VM's private key. And if they submit their own encrypted blob, the VM will fail to produce a valid Claude token from it.

### URL Structure

| URL | Purpose |
|---|---|
| `flowhelm.to/{token}` | Short link — 302 redirects to `flowhelm.to/a/{token}#pk={publicKey}` |
| `flowhelm.to/a/{token}` | Auth page — static HTML with token input and E2E encryption |
| `flowhelm.to/qr/{token}` | QR code — returns UTF-8 block characters for terminal display |
| `flowhelm.to/api/session` | POST — create new session |
| `flowhelm.to/api/session/{token}/poll` | GET — VM polls for encrypted credential |
| `flowhelm.to/api/session/{token}` | POST — browser submits encrypted credential |
| `flowhelm.to/api/session/{token}` | DELETE — VM cleans up after successful auth |

The short URL `flowhelm.to/{token}` is what appears in the QR code and terminal output. It is extremely short (e.g., `flowhelm.to/x3K9m` — 21 characters total). The redirect appends the public key in the URL hash, which is never sent to the server.

## API Specification

### POST /api/session

Create a new auth session.

**Request**:
```json
{
  "publicKey": "base64-encoded-X25519-public-key"
}
```

**Response** (201):
```json
{
  "token": "x3K9m",
  "expiresAt": 1743890400000
}
```

**Rate limit**: 5 requests per minute per IP.

### GET /api/session/{token}/poll

VM polls for the encrypted credential. Returns immediately (no long-polling for simplicity).

**Response** (200, credential available):
```json
{
  "status": "ready",
  "encrypted": "base64-AES-256-GCM-ciphertext",
  "ephemeralPublicKey": "base64-X25519-ephemeral-public-key",
  "nonce": "base64-12-byte-nonce"
}
```

**Response** (200, waiting):
```json
{
  "status": "pending"
}
```

**Response** (404): Session expired or does not exist.

**Rate limit**: 30 requests per minute per IP. VM polls every 2 seconds (30 polls in 1 minute).

### POST /api/session/{token}

Browser submits the encrypted credential.

**Request**:
```json
{
  "encrypted": "base64-AES-256-GCM-ciphertext",
  "ephemeralPublicKey": "base64-X25519-ephemeral-public-key",
  "nonce": "base64-12-byte-nonce"
}
```

**Response** (200):
```json
{
  "status": "ok"
}
```

**Rate limit**: 3 requests per minute per IP (the browser only needs to submit once).

### DELETE /api/session/{token}

VM cleans up after successful auth.

**Response** (200):
```json
{
  "status": "deleted"
}
```

### GET /qr/{token}

Returns a UTF-8-encoded QR code for terminal display.

**Response** (200, Content-Type: text/plain; charset=utf-8):
```
█▀▀▀▀▀█ ▄▀▄▀█ █▀▀▀▀▀█
█ ███ █ █▀▀▄▄ █ ███ █
█ ▀▀▀ █ ▀█▄▀▄ █ ▀▀▀ █
▀▀▀▀▀▀▀ █▀█▀█ ▀▀▀▀▀▀▀
▄▀▄██▀▄ ▄▀▀▄▀ ▀▄█▀▄▀▄
▀▀▀▀▀▀▀ ▀ ▀ ▀▀▀▀▀▀▀▀
█▀▀▀▀▀█ ▄█▀▀▄ █▀▀▀▀▀█
█ ███ █ █▄▀█▀ █ ███ █
█ ▀▀▀ █ ▀▄█▀▄ █ ▀▀▀ █
▀▀▀▀▀▀▀ ▀▀▀▀▀ ▀▀▀▀▀▀▀
```

The QR code encodes the short URL `https://flowhelm.to/{token}`. Rendered using Unicode block characters (`█`, `▀`, `▄`, ` `) at 2 modules per terminal row for compact display.

**Implementation**: From-scratch QR code generator (no external libraries). Byte-mode encoding, Error Correction Level M (15% recovery), Version 2-4 depending on URL length. The generator is part of the auth bridge server — same codebase, same deployment.

## E2E Encryption Details

### Key Exchange: X25519 ECDH

1. **VM generates**: X25519 keypair (`vmPrivateKey`, `vmPublicKey`)
2. **VM sends**: `vmPublicKey` (base64) in POST /api/session
3. **Server stores**: `vmPublicKey` alongside the session (for the redirect)
4. **Browser generates**: Ephemeral X25519 keypair (`ephPrivateKey`, `ephPublicKey`)
5. **Browser computes**: `sharedSecret = X25519(ephPrivateKey, vmPublicKey)`
6. **Browser encrypts**: `AES-256-GCM(sharedSecret, nonce, plaintext_token)`
7. **Browser sends**: `{ encrypted, ephPublicKey, nonce }` to server
8. **Browser discards**: `ephPrivateKey` (never stored)
9. **VM computes**: `sharedSecret = X25519(vmPrivateKey, ephPublicKey)` (same shared secret)
10. **VM decrypts**: `AES-256-GCM-decrypt(sharedSecret, nonce, ciphertext)`

All cryptographic operations use the Web Crypto API:
- **Browser**: `window.crypto.subtle` (available in all modern browsers)
- **VM (Node.js)**: `crypto.subtle` (available in Node.js 18+)

### Why X25519 + AES-256-GCM

- **X25519**: Industry standard for key exchange. 32-byte keys. Used by TLS 1.3, Signal, WireGuard.
- **AES-256-GCM**: Authenticated encryption. Prevents tampering. 12-byte nonce, 16-byte auth tag.
- **No RSA**: X25519 + AES-GCM is faster, smaller, and more secure than RSA-OAEP for this use case.

### What the Server Sees

The server stores: `{ token, vmPublicKey, expiresAt, encrypted?, ephPublicKey?, nonce? }`. The `vmPublicKey` is needed only for the redirect URL hash. The `encrypted`, `ephPublicKey`, and `nonce` fields are opaque bytes — the server cannot derive the shared secret because it has neither the VM's private key nor the browser's ephemeral private key.

## QR Code Generator

### Design

From-scratch implementation. No external libraries. Supports QR Code Version 2 (25x25) through Version 4 (33x33), which can encode URLs up to ~78 characters in Byte mode with Error Correction Level M.

The URL `https://flowhelm.to/x3K9m` is 26 characters — fits comfortably in Version 2.

### Encoding Steps

1. **Data analysis**: Byte mode (0100) for URL characters
2. **Data encoding**: Character count indicator + encoded data + terminator
3. **Error correction**: Reed-Solomon codes (Level M, 15% recovery)
4. **Module placement**: Finder patterns (3 corners), timing patterns, format information
5. **Masking**: Apply all 8 mask patterns, select the one with lowest penalty score
6. **Output**: 2D boolean matrix → UTF-8 block characters

### Terminal Rendering

Each QR module is a square. To render compactly in a terminal (where characters are ~2:1 height:width), we use Unicode half-block characters to encode 2 vertical modules per character row:

| Top module | Bottom module | Character |
|---|---|---|
| Black | Black | `█` (U+2588, Full Block) |
| Black | White | `▀` (U+2580, Upper Half Block) |
| White | Black | `▄` (U+2584, Lower Half Block) |
| White | White | ` ` (Space) |

A Version 2 QR code (25x25 modules) renders as 13 terminal rows by ~27 columns (including quiet zone). Highly readable even on small terminals.

## Server Implementation

The official Token Bridge relay at `flowhelm.to` is a Cloudflare Workers deployment maintained by the FlowHelm team. Every FlowHelm installation worldwide uses this relay by default — users do **not** need to host their own bridge. The relay is free to operate (well within Cloudflare's free tier) and provides global edge availability with zero maintenance.

A self-hosted Node.js version is available for enterprise operators or privacy-conscious users who want a private relay, but this is entirely optional.

### Tech Stack Comparison

| Aspect | Official Relay (Cloudflare Workers) | Self-Hosted (Node.js, optional) |
|---|---|---|
| Runtime | Cloudflare Workers (V8 isolates) | Node.js 22+ |
| HTTP server | Workers `fetch()` handler | `node:http` (zero deps) |
| Session storage | Workers KV with automatic TTL expiry | In-memory `Map` + TTL cleanup timer |
| Rate limiting | KV counter-per-window (eventually consistent) | In-memory sliding window (per-process) |
| TLS | Cloudflare built-in | Caddy reverse proxy (Let's Encrypt) |
| DDoS | Cloudflare built-in | Cloudflare free proxy (recommended) |
| QR code | From-scratch (shared code, identical output) | From-scratch (shared code, identical output) |
| Source | `services/auth-bridge-workers/` | `services/auth-bridge/` |

## Official Relay: Cloudflare Workers (flowhelm.to)

This is what runs at `flowhelm.to` and serves every FlowHelm user. **Cost: $0/month** (free tier covers ~200 sessions/day). Global edge, zero maintenance.

```
Internet → Cloudflare Edge (TLS + DDoS) → Worker (V8 isolate) → KV (session storage)
```

### Prerequisites

- Cloudflare account (free tier)
- `flowhelm.to` domain added to Cloudflare (or any domain you own)
- Node.js 18+ installed locally (for `wrangler` CLI)

### Step-by-Step Deployment

**1. Install wrangler and authenticate:**

```bash
cd services/auth-bridge-workers
npm install
npx wrangler login
```

This opens a browser for Cloudflare OAuth. Approve the request.

**2. Create the KV namespace:**

```bash
# Production namespace
npx wrangler kv namespace create SESSIONS

# Preview namespace (for wrangler dev)
npx wrangler kv namespace create SESSIONS --preview
```

Each command outputs an ID. Copy them.

**3. Update `wrangler.toml` with the KV IDs:**

```toml
[[kv_namespaces]]
binding = "SESSIONS"
id = "abc123..."          # from step 2 (production)
preview_id = "def456..."  # from step 2 (preview)

[vars]
BASE_URL = "https://flowhelm.to"
```

**4. Deploy:**

```bash
npx wrangler deploy
```

Output: `Published flowhelm-bridge (https://flowhelm-bridge.<your-subdomain>.workers.dev)`

**5. Set up custom domain:**

In the Cloudflare dashboard:
1. Go to **Workers & Pages** → **flowhelm-bridge** → **Settings** → **Domains & Routes**
2. Click **Add** → **Custom domain**
3. Enter `flowhelm.to` (or your domain)
4. Cloudflare automatically creates the DNS record and provisions TLS

Alternatively, add a route in `wrangler.toml`:
```toml
[[routes]]
pattern = "flowhelm.to/*"
zone_name = "flowhelm.to"
```
Then run `npx wrangler deploy` again.

**6. Verify:**

```bash
curl https://flowhelm.to/health
# {"status":"ok"}
```

### Local Development

```bash
cd services/auth-bridge-workers
npm install
npx wrangler dev --local --port 3456
```

Uses local KV emulation. No Cloudflare auth needed for local dev.

### Workers Billing Breakdown

Each auth session uses ~5 Worker requests + ~5-10 KV operations.

| Monthly users | Requests | KV reads | KV writes | **Total cost** |
|---|---|---|---|---|
| 10 | ~50 | ~30 | ~50 | **$0** |
| 100 | ~500 | ~300 | ~500 | **$0** |
| 1,000 | ~5,000 | ~3,000 | ~5,000 | **$0** |
| 10,000 | ~50,000 | ~30,000 | ~50,000 | **$0** |

Free tier limits: 100K requests/day, 100K KV reads/day, 1K KV writes/day. The bridge will stay well within free tier for any realistic usage — users only authenticate once during `flowhelm setup`, not on every request.

The $5/month paid Workers plan (if you ever need it) gives: 10M requests/month, unlimited KV reads, 1M KV writes/month.

## Self-Hosted Relay (Optional — Coolify / VM)

For enterprise operators or privacy-conscious users who want a private relay instead of the official `flowhelm.to`. Users must set `bridgeUrl` in their FlowHelm config to point to their self-hosted instance.

**Cost: $4-8/month** (VM). Predictable, no per-request billing. Full control.

```
Internet → Cloudflare (free proxy/DDoS) → Your VM (Caddy + Node.js)
```

### Prerequisites

- Linux VM (Hetzner CX22 ~$4/mo, DigitalOcean $6/mo, or any VPS)
- Docker or Podman installed on the VM
- Domain pointed to the VM's IP

### Step-by-Step Deployment with Coolify

**1. Install Coolify** on your VM (if not already):

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

Open `http://<vm-ip>:8000` and complete initial setup.

**2. Create a new Application in Coolify:**

- Source: **Git Repository** → your FlowHelm repo URL
- Branch: `main`
- Build Pack: **Dockerfile**
- Dockerfile Location: `services/auth-bridge/Containerfile`
- Base Directory: `services/auth-bridge`
- Port: `3456`

**3. Set environment variables** in Coolify's app settings:

| Variable | Value |
|---|---|
| `PORT` | `3456` |
| `BASE_URL` | `https://flowhelm.to` |

**4. Configure domain** in Coolify:

- Add `flowhelm.to` as the domain
- Enable HTTPS (Coolify handles Let's Encrypt automatically)

**5. Deploy** — click Deploy in Coolify.

**6. DNS**: Point `flowhelm.to` A record to your VM's IP. Optionally proxy through Cloudflare (orange cloud) for free DDoS protection.

### Alternative: Bare VM (systemd + Caddy)

```bash
# On the VM
cd /opt/flowhelm-bridge
git clone https://github.com/flowhelm-ai/flowhelm.git .
cd services/auth-bridge
npm install
npm run build

# Caddy config (/etc/caddy/Caddyfile)
cat > /etc/caddy/Caddyfile << 'EOF'
flowhelm.to {
    reverse_proxy localhost:3456
}
EOF

# systemd service
cat > /etc/systemd/system/flowhelm-bridge.service << 'EOF'
[Unit]
Description=FlowHelm Auth Bridge
After=network.target

[Service]
Type=simple
User=flowhelm
WorkingDirectory=/opt/flowhelm-bridge/services/auth-bridge
Environment=PORT=3456
Environment=BASE_URL=https://flowhelm.to
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl enable --now flowhelm-bridge
systemctl restart caddy
```

### Verify (either deployment method)

```bash
# Health check
curl https://flowhelm.to/health

# Full lifecycle test
TOKEN=$(curl -s -X POST https://flowhelm.to/api/session \
  -H 'Content-Type: application/json' \
  -d '{"publicKey":"dGVzdA=="}' | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

echo "Session token: $TOKEN"
curl -s "https://flowhelm.to/api/session/$TOKEN/poll"    # pending
curl -s "https://flowhelm.to/qr/$TOKEN"                  # QR code
curl -s -X DELETE "https://flowhelm.to/api/session/$TOKEN"  # cleanup
```

## Anti-Bot Measures

1. **Cloudflare proxy** (free, both deployments): DDoS protection, bot detection, challenge pages.

2. **Rate limiting per IP**: Enforced at the application level.
   - Session creation: 5/min per IP, 1000/hour globally
   - Polling: 30/min per IP
   - Token submission: 3/min per IP
   - QR generation: 30/min per IP

3. **Session TTL**: 10 minutes. Unclaimed sessions auto-delete.

4. **No valuable data**: Even if a bot enumerates all sessions, the encrypted blobs are useless without the VM's private key.

5. **CORS restrictions**: Credential submission only accepted from the configured origin.

## CLI Integration

### `flowhelm setup auth` Flow

```
=== FlowHelm Authentication ===

How would you like to authenticate with Claude?

  1. API key (recommended for always-on production)
     Pay-per-use. Get a key at console.anthropic.com
     Works with both CLI and SDK runtimes.

  2. Claude subscription (Pro/Max plan)
     Use your existing subscription. At your own risk —
     Anthropic may restrict third-party subscription usage.
     Works with CLI runtime only.

> 2

=== Subscription Authentication ===

Choose authentication method:

  a. Token Bridge (recommended)
     Scan a QR code on your phone, authenticate there.
     Credentials are transferred securely via E2E encryption.

  b. SSH Tunnel (advanced)
     Authenticate via SSH port forwarding from a machine
     with a browser.

> a

Creating secure session...

╔══════════════════════════════════════════════╗
║                                              ║
║  Scan this QR code or open the link below:   ║
║                                              ║
║  █▀▀▀▀▀█ ▄▀▄▀█ █▀▀▀▀▀█                     ║
║  █ ███ █ █▀▀▄▄ █ ███ █                     ║
║  █ ▀▀▀ █ ▀█▄▀▄ █ ▀▀▀ █                     ║
║  ▀▀▀▀▀▀▀ █▀█▀█ ▀▀▀▀▀▀▀                     ║
║  ▄▀▄██▀▄ ▄▀▀▄▀ ▀▄█▀▄▀▄                     ║
║  ...                                         ║
║                                              ║
║  https://flowhelm.to/x3K9m                   ║
║                                              ║
║  Session expires in 10 minutes.              ║
║                                              ║
╚══════════════════════════════════════════════╝

Waiting for authentication... (polling every 2s)
```

After successful auth:
```
✓ Token received and decrypted.
✓ Subscription: Max (user@example.com)
✓ Credentials stored at ~/.claude/.credentials.json

FlowHelm will use your Claude subscription for agent tasks.
Note: Anthropic may restrict subscription usage with third-party
tools. If this stops working, switch to API key authentication
with: flowhelm setup auth --api-key
```

### Credential Storage After Auth

The `claude setup-token` command outputs a plain text token string (e.g., `sk-ant-oat01-...`). This is the OAuth access token, not a JSON structure.

FlowHelm stores this token in `~/.claude/.credentials.json` using the format the `claude` binary expects — wrapped under a `claudeAiOauth` key:
```json
{
  "claudeAiOauth": {
    "accessToken": "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt": "2027-02-18T07:00:00.000Z",
    "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
    "subscriptionType": "max",
    "rateLimitTier": "max"
  }
}
```

Note: The Token Bridge flow receives only the access token string from `claude setup-token`. The `refreshToken`, `expiresAt`, `scopes`, `subscriptionType`, and `rateLimitTier` fields are populated by FlowHelm from the token's metadata or set to sensible defaults. The `claude` binary handles token refresh internally.

FlowHelm also copies `~/.claude.json` account metadata if available.

When spawning agent containers, the orchestrator can inject credentials in two ways:

**Option 1: Environment variable** (simpler):
```bash
podman run ... \
  --env CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-... \
  flowhelm-agent:latest
```

The `claude` binary reads the `CLAUDE_CODE_OAUTH_TOKEN` environment variable directly, bypassing the credentials file entirely. This is the preferred approach for container injection because it avoids file mounting and works cleanly with Podman's `--env` flag.

**Option 2: File bind-mount** (alternative):
```bash
podman run ... \
  --volume ~/.claude/.credentials.json:/home/node/.claude/.credentials.json:ro,Z \
  --volume ~/.claude.json:/home/node/.claude.json:ro,Z \
  flowhelm-agent:latest
```

The `claude -p` binary inside the container reads credentials from its standard location. Client attestation passes because it is the real `claude` binary.

## Design Alternatives Considered

| Aspect | Terminal Paste Approach | FlowHelm Token Bridge |
|---|---|---|
| Subscription auth | `claude setup-token` → paste into terminal | QR code scan → E2E encrypted relay → VM receives automatically |
| API key auth | External vault service (Rust + PG + web UI) | Built-in credential proxy (~20 MB container, zero external deps) |
| Credential transfer | Plaintext paste in terminal or web UI | E2E encrypted via X25519 + AES-256-GCM |
| Headless UX | "Run setup-token elsewhere, paste here" | QR code scan on phone → VM receives automatically |
| External dependency | Separate service (binary + database + dashboard) | Self-hostable relay (~1000 lines, no database) |
| Security of token in transit | Plaintext in terminal/SSH session | E2E encrypted; relay server sees only ciphertext |

## Failure Modes

**flowhelm.to is down**: Fall back to Method 2 (SSH tunnel) or direct terminal paste. The CLI detects the failure and shows alternatives:
```
Could not reach flowhelm.to. Falling back to manual authentication.

Run "claude setup-token" on a machine with Claude Code, then paste
the token here:

Token: █
```

**Session expires before user completes auth**: CLI shows timeout message and offers to create a new session.

**Browser JavaScript disabled**: The auth page requires JavaScript for E2E encryption. If disabled, the page shows a message: "JavaScript is required for secure credential transfer. Alternatively, paste the token directly into your FlowHelm terminal."

**Invalid/expired token pasted**: The CLI validates the token after decryption. If invalid, it shows an error and offers to retry.

**Network interruption during polling**: The CLI retries polling with exponential backoff (2s → 4s → 8s → 16s → timeout).

## Implementation Phase

This service is implemented in **Phase 4C** (after Phase 4B: Agent Identity Layer, before Phase 5: Agent Runtime Integration). Phase 5 depends on having a working authentication mechanism.

### Files

**Self-hosted (Node.js) — `services/auth-bridge/`**:

| File | Responsibility |
|---|---|
| `server.ts` | HTTP server (node:http), routing, CORS, CLI entry point |
| `store.ts` | In-memory session store with TTL cleanup |
| `token.ts` | Short URL token generator (56-char safe alphabet) |
| `rate-limit.ts` | Per-IP sliding window rate limiter |
| `qr.ts` | From-scratch QR code generator (Reed-Solomon, masking, UTF-8 rendering) |
| `static/index.html` | Browser auth page (WebCrypto X25519 + AES-256-GCM) |
| `Containerfile` | Alpine + Node.js 22 container image |
| `package.json` | Project manifest (zero runtime deps, typescript devDep) |
| `tsconfig.json` | TypeScript config for Node.js 22 |

**Cloudflare Workers — `services/auth-bridge-workers/`**:

| File | Responsibility |
|---|---|
| `src/index.ts` | Workers fetch handler, routing, CORS |
| `src/store.ts` | KV-backed session store with automatic TTL |
| `src/token.ts` | Token generator (Web Crypto API) |
| `src/rate-limit.ts` | KV counter-per-window rate limiter |
| `src/qr.ts` | QR code generator (identical to Node.js version) |
| `src/page.ts` | Inlined auth page HTML (no filesystem on Workers) |
| `wrangler.toml` | Cloudflare Workers configuration |
| `package.json` | Project manifest (wrangler + workers-types devDeps) |
| `tsconfig.json` | TypeScript config for Workers |

**CLI client — `src/auth/`**:

| File | Responsibility |
|---|---|
| `bridge-client.ts` | VM-side: keypair gen, session creation, polling, X25519 decryption |
| `credential-store.ts` | Read/write ~/.claude/.credentials.json (mode 0600) |
| `api-key.ts` | Validate sk-ant-* format, store in ~/.flowhelm/secrets/ |
| `setup-flow.ts` | Three-option auth menu (API key, Token Bridge, SSH Tunnel) |
| `index.ts` | Barrel exports |

**Tests**:

| File | Tests |
|---|---|
| `tests/auth-bridge-server.test.ts` | 50 tests: Node.js token, store, rate limiter, QR, HTTP server |
| `tests/auth.test.ts` | 34 tests: API key, credential store, X25519 round-trip, config schema |
| `tests/auth-bridge-workers.test.ts` | 23 tests: Workers token, KV store, KV rate limiter, QR parity |

See @docs/decisions.md ADR-025 for the authentication strategy rationale.
