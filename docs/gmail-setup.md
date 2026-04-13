# Gmail Setup Guide

Step-by-step instructions for connecting FlowHelm to Gmail. Both transports (Pub/Sub and IMAP) require a GCP project for OAuth credentials. The Pub/Sub transport additionally requires Pub/Sub resources and a service account.

## What you need at the end

| Credential | IMAP transport | Pub/Sub transport |
|---|---|---|
| GCP Project | Yes | Yes |
| OAuth Client ID | Yes | Yes |
| OAuth Client Secret | Yes | Yes |
| OAuth Refresh Token | Yes | Yes |
| Pub/Sub topic + subscription | No | Yes |
| Service account key JSON | No | Yes |

## Step 1: Create a GCP Project

1. Go to [console.cloud.google.com/projectcreate](https://console.cloud.google.com/projectcreate)
2. Project name: `FlowHelm Gmail` (or any name)
3. Project ID: `flowhelm-test` (or any unique ID)
4. Click **Create**
5. Wait for the project to be created, then select it from the project dropdown at the top

> Skip this step if you already have a GCP project you want to use.

## Step 2: Enable APIs

1. Go to [console.cloud.google.com/apis/library](https://console.cloud.google.com/apis/library)
2. Make sure your project is selected in the dropdown at the top
3. Enable each of these APIs (search → click → **Enable**):

| API | Required for |
|---|---|
| **Gmail API** | Email read/write, IMAP XOAUTH2 |
| **Google People API** | Contact lookup and name resolution |
| **Google Calendar API** | Calendar queries and event creation |
| **Google Drive API** | File access and document search |
| **Google Tasks API** | Task management |
| **Cloud Pub/Sub API** | Real-time email notifications (Pub/Sub transport only) |

## Step 3: Configure OAuth Consent Screen

1. Go to [console.cloud.google.com/apis/credentials/consent](https://console.cloud.google.com/apis/credentials/consent)
2. User Type:
   - **Google Workspace users**: Select **Internal** (recommended). Refresh tokens never expire, no Google verification required, only users within your organization can authenticate.
   - **Personal Gmail users**: Select **External** (Internal is not available for personal accounts).
3. Click **Create**
4. Fill in the form:
   - App name: `FlowHelm`
   - User support email: your email
   - Developer contact: your email
5. Click **Save and Continue**
6. On the **Scopes** page, click **Add or Remove Scopes**
7. In the filter box, search for and check these scopes:
   - `https://mail.google.com/` — full IMAP/SMTP access (needed for IMAP XOAUTH2)
   - `https://www.googleapis.com/auth/contacts` — contact lookup and name resolution
   - `https://www.googleapis.com/auth/calendar` — calendar queries and event creation
   - `https://www.googleapis.com/auth/drive` — file access and document search
   - `https://www.googleapis.com/auth/tasks` — task management
8. Click **Update** → **Save and Continue**
9. **External only**: On the **Test users** page, click **Add Users**, enter your Gmail address → click **Add** → **Save and Continue**
10. Click **Back to Dashboard**
11. **External only**: Click **Publish App** to move from Testing to Production. In Testing mode, refresh tokens expire after 7 days. Publishing requires Google verification for sensitive scopes (can take a few weeks). Alternatively, stay in Testing mode and re-authenticate weekly when FlowHelm's auth monitor flags expiry.

## Step 4: Create OAuth Client ID

1. Go to [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
2. Click **+ Create Credentials** → **OAuth client ID**
3. Application type: **Desktop app**
4. Name: `FlowHelm`
5. Click **Create**
6. A dialog shows your credentials. **Copy and save both values:**
   - **Client ID**
   - **Client Secret**
7. Click **OK**

## Step 5: Get a Refresh Token

The refresh token is a long-lived credential that FlowHelm uses to get short-lived access tokens automatically. You only do this once.

### Option A: OAuth Playground (recommended)

1. Go to [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground/)
2. Click the **gear icon** (top right of the page)
3. Check **Use your own OAuth credentials**
4. Paste your **Client ID** and **Client Secret** from Step 4
5. Close the settings panel
6. In the left panel under **Step 1**, find the text input box labeled "Input your own scopes"
7. Paste these scopes (all on one line, space-separated):
   ```
   https://mail.google.com/ https://www.googleapis.com/auth/contacts https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/tasks
   ```
8. Click **Authorize APIs**
9. Sign in with your Gmail account
10. If you see "Google hasn't verified this app", click **Advanced** → **Go to FlowHelm (unsafe)**
11. Click **Allow** on the consent screen
12. You're now on **Step 2**. Click **Exchange authorization code for tokens**
13. Copy the **Refresh token** value from the response (starts with `1//`)

> **If refresh_token is missing**: Go to [myaccount.google.com/permissions](https://myaccount.google.com/permissions), remove the FlowHelm app, and repeat from step 8.

### Option B: Command line

```bash
CLIENT_ID="YOUR_CLIENT_ID.apps.googleusercontent.com"
CLIENT_SECRET="GOCSPX-YOUR_CLIENT_SECRET"
SCOPES="https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.readonly https://mail.google.com/ https://www.googleapis.com/auth/contacts https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/tasks"

# 1. Open this URL in your browser:
echo "https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=http://localhost:8080&response_type=code&scope=${SCOPES}&access_type=offline&prompt=consent"

# 2. Authorize the app. The browser redirects to http://localhost:8080?code=XXXXX
#    The page won't load — that's fine. Copy the 'code' value from the URL bar.

# 3. Exchange the code for tokens:
AUTH_CODE="paste-the-code-here"

curl -s -X POST https://oauth2.googleapis.com/token \
  -d "code=${AUTH_CODE}" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}" \
  -d "redirect_uri=http://localhost:8080" \
  -d "grant_type=authorization_code" | jq .

# The response contains "refresh_token": "1//0xxx" — copy that value.
```

## Step 6: Create Pub/Sub Resources (Pub/Sub transport only)

# FlowHelm Google Cloud Setup — Command Reference

## Prerequisites
Make sure `gcloud` is installed, then authenticate:

```bash
gcloud auth login
```

## Project Setup

```bash
gcloud config set project flowhelm-test
gcloud auth application-default set-quota-project flowhelm-test
```

## Variables (set once, reuse across all commands)

```bash
PROJECT_ID="flowhelm-test"
```

## Step 6: Create Pub/Sub Resources

```bash
# Create topic
gcloud pubsub topics create flowhelm-test --project="${PROJECT_ID}"

# Create pull subscription
gcloud pubsub subscriptions create flowhelm-test-sub \
  --topic=flowhelm-test \
  --project="${PROJECT_ID}" \
  --ack-deadline=30 \
  --message-retention-duration=1h

# Grant Gmail push service permission to publish
gcloud pubsub topics add-iam-policy-binding flowhelm-test \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"
```

## Step 7: Create Service Account

```bash
# Create service account
gcloud iam service-accounts create flowhelm-pubsub \
  --project="${PROJECT_ID}" \
  --display-name="FlowHelm Pub/Sub Subscriber"

# Grant subscriber role
gcloud pubsub subscriptions add-iam-policy-binding flowhelm-test-sub \
  --project="${PROJECT_ID}" \
  --member="serviceAccount:flowhelm-pubsub@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber"

# Download key file
gcloud iam service-accounts keys create ~/flowhelm-sa-key.json \
  --iam-account="flowhelm-pubsub@${PROJECT_ID}.iam.gserviceaccount.com"

chmod 600 ~/flowhelm-sa-key.json
```

## Resulting Resources

| Item                  | Value                                      |
|-----------------------|--------------------------------------------|
| Project ID            | `flowhelm-test`                            |
| Pub/Sub Topic         | `flowhelm-test`                            |
| Pub/Sub Subscription  | `flowhelm-test-sub`                        |
| Service Account       | `flowhelm-pubsub@flowhelm-test.iam.gserviceaccount.com` |
| Service Account Key   | `/path/to/flowhelm-sa-key.json`     |

## Step 8: Configure FlowHelm

Once you have all credentials, provide them to configure the Gmail channel.

### For IMAP transport (Steps 1-5 only)

You need:
- Gmail address
- OAuth Client ID (from Step 4)
- OAuth Client Secret (from Step 4)
- Refresh Token (from Step 5)

### For Pub/Sub transport (Steps 1-7)

You need everything from IMAP, plus:
- GCP Project ID (from Step 1)
- Service account key JSON file (from Step 7)

## Cost

All GCP resources used by FlowHelm fall within the permanent free tier for typical email volume (under 50 emails/day):

| Resource | Free Tier | Typical Usage | Cost |
|---|---|---|---|
| Gmail API | 250 quota units/s | ~100 calls/day | $0.00 |
| Pub/Sub | 10 GiB/month | ~750 KB/month | $0.00 |
| Service account | Unlimited | 1 | $0.00 |
