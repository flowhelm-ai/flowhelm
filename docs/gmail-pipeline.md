# Gmail Pipeline

## Overview

FlowHelm uses a push-based Gmail notification pipeline with dual transport support. The default path is Gmail → Google Cloud Pub/Sub → REST synchronous pull → filter → orchestrator. An alternative IMAP IDLE transport is available for restricted Workspace accounts. No exposed ports. No webhooks. No inbound connections. Zero new npm dependencies.

See ADR-045 for the full rationale.

## Architecture

```
                  ┌─── Transport A (default) ──────────────────┐
User's Gmail inbox → Gmail Watch API → GCP Pub/Sub topic
                     │                    ↓ REST pull (every 5s)
                     │     PubSubPullDaemon → parse notification
                     │                    ↓
                     │            GmailClient.listHistory()
                     │                    ↓
                  ┌──┴── Transport B (alternative) ────────────┐
                  │  imap.gmail.com:993 (TLS)                  │
                  │  ImapIdleClient → IDLE → * N EXISTS        │
                  │       ↓ GmailClient.listMessages()         │
                  └────────────────────────────────────────────┘
                                    ↓
                         evaluateFilter(email, rules)
                                    ↓ passed?
                         normalizeEmail → InboundMessage
                                    ↓
                        MessageRouter → PG queue → Agent
                                    ↓
              ┌── notificationChannel set? ──┐
              │  Yes: forward to Telegram    │  No: reply via Gmail API
              └──────────────────────────────┘
```

## Dual Transport

| | Pub/Sub REST Pull | IMAP IDLE |
|---|---|---|
| Config value | `transport: 'pubsub'` (default) | `transport: 'imap'` |
| Latency | 5-10s (poll interval configurable) | 1-5s (server push) |
| GCP requirements | Project + OAuth app + Pub/Sub topic + service account | Project + OAuth app only |
| Auth | Service account JWT (Pub/Sub) + OAuth (Gmail API) | XOAUTH2 (IMAP + SMTP) |
| Dependencies | None (uses `fetch` + `node:crypto`) | None (uses `node:tls`) |
| Best for | Personal Gmail, unmanaged Workspace | Simpler setup, restricted Workspace |

## Credential Setup

Both transports (Pub/Sub and IMAP) require an OAuth 2.0 client for Gmail API access. The Pub/Sub transport additionally requires a GCP project with a service account. This section walks through creating everything from scratch.

### Prerequisites

- A Google account with Gmail
- [Google Cloud CLI (`gcloud`)](https://cloud.google.com/sdk/docs/install) installed (for Pub/Sub transport)
- `curl` and `jq` (for the OAuth token exchange step)

### Step 1: Create a GCP Project

Skip this step if you already have a GCP project you want to use, or if you're using the IMAP transport.

```bash
# Create a new project (pick any unique ID)
gcloud projects create flowhelm-gmail --name="FlowHelm Gmail"

# Set it as the active project
gcloud config set project flowhelm-gmail

# Link a billing account (required for API enablement, but no charges for our usage)
# List available billing accounts:
gcloud billing accounts list
# Link one:
gcloud billing projects link flowhelm-gmail --billing-account=YOUR_BILLING_ACCOUNT_ID
```

> **Note**: A billing account must be linked for API enablement to succeed, but actual cost is $0.00/month for typical email usage (50 emails/day = ~750 KB/month vs 10 GiB Pub/Sub free tier).

### Step 2: Enable APIs

```bash
# Gmail API (required for both transports)
gcloud services enable gmail.googleapis.com

# Pub/Sub API (only for pubsub transport)
gcloud services enable pubsub.googleapis.com
```

### Step 3: Create OAuth 2.0 Credentials

This creates the client ID and client secret used to authenticate as your Gmail account.

**Via Google Cloud Console** (recommended for first-time setup):

1. Go to [APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials)
2. Click **+ CREATE CREDENTIALS** > **OAuth client ID**
3. If prompted, configure the **OAuth consent screen** first:
   - User Type: **External** (or Internal if you have Workspace)
   - App name: `FlowHelm`
   - User support email: your email
   - Scopes: click **Add or Remove Scopes**, then add:
     - `https://www.googleapis.com/auth/gmail.modify` (read, send, and modify emails)
     - `https://www.googleapis.com/auth/gmail.readonly` (minimum for read-only mode)
   - If using IMAP transport, also add:
     - `https://mail.google.com/` (required for IMAP/SMTP XOAUTH2)
   - Test users: add your Gmail address
   - Save
4. Back on the Credentials page, click **+ CREATE CREDENTIALS** > **OAuth client ID**
5. Application type: **Desktop app** (or "Web application" — both work for the refresh token flow)
6. Name: `FlowHelm`
7. Click **Create**
8. Copy the **Client ID** and **Client Secret** — you'll need both

**Via `gcloud` CLI** (alternative):

```bash
# Create OAuth client (Desktop type)
gcloud auth application-default login  # ensure you're authenticated

# Unfortunately, gcloud doesn't directly create OAuth client IDs.
# Use the Console method above, or the REST API:
curl -X POST \
  "https://oauth2.googleapis.com/v2/projects/flowhelm-gmail/oauthClients" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{"displayName": "FlowHelm", "applicationType": "DESKTOP"}'
```

### Step 4: Obtain a Refresh Token

The refresh token is a long-lived credential that FlowHelm uses to obtain short-lived access tokens. You only need to do this once.

**Option A: Authorization code flow (recommended)**

```bash
# Set your credentials from Step 3
CLIENT_ID="your-client-id.apps.googleusercontent.com"
CLIENT_SECRET="your-client-secret"

# Scopes needed (space-separated for the URL, modify as needed)
# For Pub/Sub transport (Gmail API only):
SCOPES="https://www.googleapis.com/auth/gmail.modify"
# For IMAP transport (add IMAP/SMTP scope):
# SCOPES="https://www.googleapis.com/auth/gmail.modify https://mail.google.com/"

# 1. Open this URL in your browser and authorize:
echo "https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=http://localhost:8080&response_type=code&scope=${SCOPES}&access_type=offline&prompt=consent"

# 2. After authorizing, Google redirects to http://localhost:8080?code=AUTHORIZATION_CODE
#    Copy the 'code' parameter from the URL bar (it will fail to load — that's fine,
#    you just need the code from the URL).

# 3. Exchange the authorization code for a refresh token:
AUTH_CODE="paste-authorization-code-here"

curl -s -X POST https://oauth2.googleapis.com/token \
  -d "code=${AUTH_CODE}" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" \
  -d "redirect_uri=http://localhost:8080" \
  -d "grant_type=authorization_code" | jq .

# Response includes:
# {
#   "access_token": "ya29.xxx",
#   "expires_in": 3599,
#   "refresh_token": "1//0xxx",   <-- THIS IS WHAT YOU NEED
#   "scope": "...",
#   "token_type": "Bearer"
# }
```

> **Important**: The `prompt=consent` parameter forces Google to return a refresh token. Without it, Google may only return an access token if you've previously authorized this app. If you don't see `refresh_token` in the response, revoke the app at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and repeat.

**Option B: OAuth Playground (quick testing)**

1. Go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
2. Click the gear icon (top right) > check **Use your own OAuth credentials**
3. Enter your Client ID and Client Secret
4. In Step 1, add scope: `https://www.googleapis.com/auth/gmail.modify`
5. Click **Authorize APIs** > sign in > allow
6. In Step 2, click **Exchange authorization code for tokens**
7. Copy the **Refresh token**

### Step 5: Create Pub/Sub Resources (Pub/Sub transport only)

Skip this entire step if you're using the IMAP transport.

```bash
PROJECT_ID="flowhelm-gmail"

# Create topic
gcloud pubsub topics create flowhelm-gmail --project="${PROJECT_ID}"

# Create pull subscription
gcloud pubsub subscriptions create flowhelm-gmail-sub \
  --topic=flowhelm-gmail \
  --project="${PROJECT_ID}" \
  --ack-deadline=30 \
  --message-retention-duration=1h

# Grant Gmail's push service account permission to publish to the topic.
# This is Google's internal service account that delivers Gmail notifications.
gcloud pubsub topics add-iam-policy-binding flowhelm-gmail \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

### Step 6: Create a Service Account (Pub/Sub transport only)

The service account authenticates the Pub/Sub pull daemon. It only needs Subscriber access — it never reads email content.

```bash
PROJECT_ID="flowhelm-gmail"

# Create service account
gcloud iam service-accounts create flowhelm-pubsub \
  --project="${PROJECT_ID}" \
  --display-name="FlowHelm Pub/Sub Subscriber"

# Grant subscriber role on the subscription
gcloud pubsub subscriptions add-iam-policy-binding flowhelm-gmail-sub \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:flowhelm-pubsub@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber"

# Generate and download the key file
gcloud iam service-accounts keys create ~/flowhelm-sa-key.json \
  --iam-account="flowhelm-pubsub@${PROJECT_ID}.iam.gserviceaccount.com"

# Restrict permissions on the key file
chmod 600 ~/flowhelm-sa-key.json
```

The key file (`~/flowhelm-sa-key.json`) contains a JSON object with `client_email`, `private_key`, and `project_id`. FlowHelm uses these to create RS256-signed JWTs for Pub/Sub API authentication.

### Step 7: Run FlowHelm Setup

```bash
# Pub/Sub transport (default)
flowhelm setup gmail \
  --email user@gmail.com \
  --client-id YOUR_CLIENT_ID \
  --client-secret YOUR_CLIENT_SECRET \
  --refresh-token YOUR_REFRESH_TOKEN \
  --gcp-project flowhelm-gmail \
  --service-account-key ~/flowhelm-sa-key.json \
  --notification-channel telegram

# IMAP transport (no GCP required — skip Steps 1, 5, 6)
flowhelm setup gmail \
  --email user@gmail.com \
  --client-id YOUR_CLIENT_ID \
  --client-secret YOUR_CLIENT_SECRET \
  --refresh-token YOUR_REFRESH_TOKEN \
  --transport imap
```

The setup command:
1. Writes Gmail config to `~/.flowhelm/config.yaml`
2. Stores the refresh token at `~/.flowhelm/secrets/gmail-refresh-token` (mode 0600)
3. Recommends installing `google-email` and `google-calendar` skills

### Credential Summary

| Credential | Where it comes from | Who uses it | Stored at |
|---|---|---|---|
| OAuth Client ID | Step 3 (GCP Console) | Gmail API client | `~/.flowhelm/config.yaml` |
| OAuth Client Secret | Step 3 (GCP Console) | Gmail API client | `~/.flowhelm/config.yaml` |
| OAuth Refresh Token | Step 4 (auth code flow) | Gmail API client (auto-refreshes access tokens) | `~/.flowhelm/secrets/gmail-refresh-token` (mode 0600) |
| Service Account Key | Step 6 (`gcloud`) | Pub/Sub pull daemon (JWT → access token) | Path in config (`serviceAccountKeyPath`) |
| GCP Project ID | Step 1 (`gcloud`) | Pub/Sub pull daemon (subscription URL) | `~/.flowhelm/config.yaml` |

### Troubleshooting

**"Insufficient Permission" on Gmail API calls**: Your OAuth refresh token may not have the right scopes. Revoke the app at [myaccount.google.com/permissions](https://myaccount.google.com/permissions), then repeat Step 4 with the correct scopes.

**"Not Authorized" on Pub/Sub pull**: The service account may lack Subscriber role. Verify with:
```bash
gcloud pubsub subscriptions get-iam-policy flowhelm-gmail-sub --project=flowhelm-gmail
```

**No notifications arriving**: Gmail Watch may not be active. FlowHelm creates the watch on `connect()`. Check logs for watch creation. Also verify that `gmail-api-push@system.gserviceaccount.com` has Publisher role on the topic:
```bash
gcloud pubsub topics get-iam-policy flowhelm-gmail --project=flowhelm-gmail
```

**"refresh_token" missing from token response**: Google only returns a refresh token on the first authorization, or when `prompt=consent` is specified. Re-run Step 4 with `prompt=consent` in the URL, or revoke the app first.

**OAuth consent screen "unverified app" warning**: For personal use, click "Advanced" > "Go to FlowHelm (unsafe)" to proceed. Google only requires app verification for apps with >100 users.

### Cost Breakdown

| Resource | Free Tier | Typical Usage (50 emails/day) | Monthly Cost |
|---|---|---|---|
| Gmail API | 250 quota units/s | ~50 list + 50 get = 100 calls/day | $0.00 |
| Pub/Sub messages | 10 GiB/month | 50 notifications × 0.5 KB = 750 KB/month | $0.00 |
| Pub/Sub subscription | First 10 GiB free | Same as above | $0.00 |
| Service account | Free | N/A | $0.00 |
| **Total** | | | **$0.00** |

## Pub/Sub Transport — How It Works

The Pub/Sub pull daemon authenticates using a service account key file:
1. Load private key from `serviceAccountKeyPath`
2. Create RS256-signed JWT with `https://www.googleapis.com/auth/pubsub` scope
3. Exchange JWT for access token at `https://oauth2.googleapis.com/token`
4. Use access token for pull/ack API calls
5. Token is cached and refreshed 5 minutes before expiry

## IMAP Transport — How It Works

No GCP required. Uses standard IMAP IDLE (RFC 2177):
1. Connect to `imap.gmail.com:993` with TLS
2. Authenticate with XOAUTH2 SASL (same OAuth token as Gmail API)
3. SELECT INBOX
4. IDLE — server pushes `* N EXISTS` when new mail arrives
5. On new mail: DONE → fetch via Gmail REST API → filter → process → re-enter IDLE
6. IDLE refreshed every 29 minutes (RFC allows servers to drop after 30 min)

For sending email replies, the SMTP client connects to `smtp.gmail.com:465` with TLS and XOAUTH2.

## Email Filter Engine

All incoming emails pass through `evaluateFilter()` before reaching the orchestrator. Rules are evaluated in order — first rejection wins:

1. **Exclude senders** (deny list, regex patterns)
2. **Required labels** (must have at least one, default: `INBOX`)
3. **Starred only** (optional gate)
4. **Important contacts** (allow list, glob patterns like `*@company.com`)
5. **Minimum importance** (computed score threshold)

### Importance Scoring

Each email gets an importance score (0.0–1.0):

| Signal | Score |
|---|---|
| Base | +0.20 |
| STARRED | +0.30 |
| IMPORTANT | +0.20 |
| CATEGORY_PERSONAL | +0.15 |
| INBOX (no category) | +0.10 |
| Has subject | +0.05 |

## Cross-Channel Notification

When `gmail.notificationChannel` is set to `'telegram'` or `'whatsapp'`, the GmailAdapter delegates outbound messages to the specified channel adapter. This enables:

1. Email arrives → Gmail adapter normalizes it
2. Agent processes and generates a response/summary
3. Response is sent to Telegram (not back as email)
4. User sees the notification in Telegram and can reply
5. Agent uses gws CLI to send email replies when asked

## Gmail Watch Renewal

Gmail watches expire every 7 days. `GmailWatchManager` renews every 6 days via `setTimeout`. On renewal failure, it retries in 1 hour. The Gmail API idempotently replaces existing watches, so renewal is safe to call at any time.

## gws CLI Wrapper

The `GwsClient` class provides typed wrappers around the `gws` binary for agent-container operations:

### Gmail Operations
- `gmailList(query?, maxResults)` — List messages with Gmail search query
- `gmailGet(id, format)` — Get message details
- `gmailSend(to, subject, body)` — Send email
- `gmailSearch(query)` — Search messages
- `gmailLabels()` — List labels
- `gmailHistory(startHistoryId)` — List history

### Calendar Operations
- `calendarList(maxResults, timeMin?, timeMax?)` — List upcoming events
- `calendarCreate({summary, start, end, location?, description?})` — Create event
- `calendarDelete(eventId)` — Delete event

## Configuration

```yaml
channels:
  gmail:
    enabled: true
    emailAddress: user@gmail.com
    transport: pubsub  # or 'imap'

    # Pub/Sub settings
    gcpProject: my-project
    pubsubTopic: flowhelm-gmail
    pubsubSubscription: flowhelm-gmail-sub
    serviceAccountKeyPath: /path/to/sa-key.json
    pullInterval: 5000

    # IMAP settings (only used when transport: imap)
    imapHost: imap.gmail.com
    imapPort: 993
    smtpHost: smtp.gmail.com
    smtpPort: 465

    # OAuth (shared by both transports)
    oauthClientId: YOUR_CLIENT_ID
    oauthClientSecret: YOUR_CLIENT_SECRET
    # refresh token stored in ~/.flowhelm/secrets/gmail-refresh-token

    # Watch
    watchRenewalInterval: 518400000  # 6 days

    # Notification routing
    notificationChannel: telegram  # or 'whatsapp'

    # Filter rules
    filter:
      starredOnly: false
      importantContacts: ['*@company.com', 'boss@example.com']
      labels: ['INBOX']
      excludeSenders: ['noreply@.*', 'no-reply@.*']
      minImportance: 0
```

## File Listing

### Source Files
- `src/channels/gmail/gmail-client.ts` — Gmail REST API client
- `src/channels/gmail/pubsub-pull.ts` — Pub/Sub REST pull daemon
- `src/channels/gmail/filter.ts` — Email filter engine
- `src/channels/gmail/watch.ts` — Gmail Watch lifecycle
- `src/channels/gmail/imap-client.ts` — IMAP IDLE + SMTP client
- `src/channels/gmail/gws.ts` — gws CLI wrapper
- `src/channels/gmail/adapter.ts` — GmailAdapter (ChannelAdapter)
- `src/channels/gmail/index.ts` — Barrel exports

### Test Files
- `tests/gmail-client.test.ts` — 22 tests
- `tests/gmail-filter.test.ts` — 25 tests
- `tests/pubsub-pull.test.ts` — 8 tests
- `tests/gmail-adapter.test.ts` — 17 tests
- `tests/gmail-gws.test.ts` — 18 tests
- `tests/gmail-setup.test.ts` — 13 tests
- `tests/gmail-imap.test.ts` — 3 tests
- `tests/gmail-watch.test.ts` — 7 tests

## Design Alternatives Considered

| Aspect | Common Approach | FlowHelm |
|---|---|---|
| Library | `googleapis` npm package (~30MB) | `fetch` (built-in, zero deps) |
| Auth | Library auto-auth | Manual OAuth refresh + SA JWT (no library dependency) |
| Push mechanism | Inbox polling | Pub/Sub REST pull or IMAP IDLE (real-time) |
| Filtering | Process all emails | Configurable rules engine (importance scoring, glob patterns) |
| Dependencies | googleapis + gmail-mcp-server | Zero new npm deps |
| Transport options | Polling only | Pub/Sub + IMAP (user choice) |
| Cross-channel | None | notificationChannel routing (email → Telegram/WhatsApp) |
| Calendar | Separate integration | Same gws wrapper (unified Google Workspace) |
