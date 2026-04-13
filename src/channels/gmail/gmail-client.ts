/**
 * Gmail REST API client.
 *
 * Pure fetch-based — no googleapis dependency. Handles OAuth token
 * refresh automatically. Provides typed wrappers around the Gmail API
 * endpoints needed for the notification pipeline.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface GmailClientOptions {
  /** User's Gmail address. */
  emailAddress: string;
  /** OAuth client ID. */
  clientId: string;
  /** OAuth client secret. */
  clientSecret: string;
  /** OAuth refresh token (stored securely in secrets dir). */
  refreshToken: string;
  /** Optional fetch override (for testing). */
  fetchFn?: typeof fetch;
}

export interface OAuthTokens {
  accessToken: string;
  expiresAt: number;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string;
  payload: GmailMessagePayload;
}

export interface GmailMessagePayload {
  mimeType: string;
  headers: GmailHeader[];
  body?: { data?: string; size: number };
  parts?: GmailMessagePayload[];
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailHistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds: string[] } }>;
}

export interface GmailWatchResponse {
  historyId: string;
  expiration: string;
}

export interface GmailMessageListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate: number;
}

export interface GmailHistoryResponse {
  history?: GmailHistoryRecord[];
  historyId: string;
  nextPageToken?: string;
}

/** Attachment metadata extracted from MIME parts (no binary data). */
export interface AttachmentMeta {
  /** Original filename (from Content-Disposition or MIME part name). */
  filename: string;
  /** MIME type (e.g., "application/pdf", "image/png"). */
  mimeType: string;
  /** Size in bytes (from the MIME part body). */
  size: number;
  /** Gmail attachment ID (used to fetch the actual data via API). */
  attachmentId?: string;
}

/** Parsed email for downstream processing. */
export interface ParsedEmail {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: number;
  labelIds: string[];
  isStarred: boolean;
  isImportant: boolean;
  bodyText?: string;
  /** Raw headers map (lowercase keys) for automated filtering. */
  headers: Record<string, string>;
  /** Attachment metadata (filenames, types, sizes — no binary data). */
  attachments: AttachmentMeta[];
}

const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before expiry

// ─── Client ────────────────────────────────────────────────────────────────

export class GmailClient {
  readonly emailAddress: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly fetchFn: typeof fetch;
  private tokens: OAuthTokens | null = null;

  constructor(options: GmailClientOptions) {
    this.emailAddress = options.emailAddress;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.refreshToken = options.refreshToken;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  // ── Token Management ─────────────────────────────────────────────────

  /** Get a valid access token, refreshing if necessary. */
  async getAccessToken(): Promise<string> {
    if (this.tokens && Date.now() < this.tokens.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.tokens.accessToken;
    }
    await this.refreshAccessToken();
    if (!this.tokens) throw new Error('Token refresh did not produce tokens');
    return this.tokens.accessToken;
  }

  /** Force-refresh the access token using the refresh token. */
  async refreshAccessToken(): Promise<void> {
    const response = await this.fetchFn(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OAuth token refresh failed (${String(response.status)}): ${text}`);
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.tokens = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }

  // ── Gmail API ────────────────────────────────────────────────────────

  /**
   * List new messages since a historyId.
   * Returns message IDs that were added to the specified labels.
   */
  async listHistory(startHistoryId: string, labelIds?: string[]): Promise<GmailHistoryResponse> {
    const params = new URLSearchParams({ startHistoryId });
    if (labelIds) {
      for (const label of labelIds) {
        params.append('labelIds', label);
      }
    }
    params.set('historyTypes', 'messageAdded');

    return this.apiGet<GmailHistoryResponse>(`/users/me/history?${params.toString()}`);
  }

  /** Get full message details by ID. */
  async getMessage(
    messageId: string,
    format: 'metadata' | 'full' = 'metadata',
  ): Promise<GmailMessage> {
    return this.apiGet<GmailMessage>(`/users/me/messages/${messageId}?format=${format}`);
  }

  /** List messages matching a query. Used by the inbound pipeline for initial fetch. */
  async listMessages(query?: string, maxResults = 10): Promise<GmailMessageListResponse> {
    const params = new URLSearchParams({ maxResults: String(maxResults) });
    if (query) params.set('q', query);
    return this.apiGet<GmailMessageListResponse>(`/users/me/messages?${params.toString()}`);
  }

  /**
   * Create a Gmail Watch on the user's inbox.
   * Sends notifications to the specified Pub/Sub topic.
   */
  async createWatch(
    topicName: string,
    labelIds: string[] = ['INBOX'],
  ): Promise<GmailWatchResponse> {
    return this.apiPost<GmailWatchResponse>('/users/me/watch', {
      topicName,
      labelIds,
      labelFilterBehavior: 'INCLUDE',
    });
  }

  /** Stop the current Gmail Watch. */
  async stopWatch(): Promise<void> {
    await this.apiPost('/users/me/stop', {});
  }

  /**
   * Send an email.
   * The raw parameter is the base64url-encoded RFC 2822 message.
   * Used by the adapter for outbound notifications (e.g., email replies).
   */
  async sendMessage(raw: string): Promise<{ id: string; threadId: string }> {
    return this.apiPost<{ id: string; threadId: string }>('/users/me/messages/send', { raw });
  }

  /** Get the user's Gmail profile (email, historyId, etc). */
  async getProfile(): Promise<{ emailAddress: string; historyId: string; messagesTotal: number }> {
    return this.apiGet('/users/me/profile');
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  private async apiGet<T>(path: string): Promise<T> {
    const token = await this.getAccessToken();
    const response = await this.fetchFn(`${GMAIL_API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gmail API GET ${path} failed (${String(response.status)}): ${text}`);
    }
    return response.json() as Promise<T>;
  }

  private async apiPost<T = void>(path: string, body: unknown): Promise<T> {
    const token = await this.getAccessToken();
    const response = await this.fetchFn(`${GMAIL_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gmail API POST ${path} failed (${String(response.status)}): ${text}`);
    }
    // Some endpoints (stop) return 204 No Content
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return response.json() as Promise<T>;
    }
    return undefined as T;
  }
}

// ─── Email Parsing Utilities ────────────────────────────────────────────────

/** Extract a header value from a Gmail message payload. */
export function getHeader(payload: GmailMessagePayload, name: string): string {
  const header = payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return header?.value ?? '';
}

/** Parse a Gmail API message into a simplified ParsedEmail. */
export function parseGmailMessage(msg: GmailMessage): ParsedEmail {
  // Build lowercase header map for automated filtering
  const headers: Record<string, string> = {};
  for (const h of msg.payload.headers) {
    headers[h.name.toLowerCase()] = h.value;
  }

  return {
    id: msg.id,
    threadId: msg.threadId,
    from: getHeader(msg.payload, 'From'),
    to: getHeader(msg.payload, 'To'),
    subject: getHeader(msg.payload, 'Subject'),
    snippet: msg.snippet,
    date: Number(msg.internalDate),
    labelIds: msg.labelIds,
    isStarred: msg.labelIds.includes('STARRED'),
    isImportant: msg.labelIds.includes('IMPORTANT'),
    bodyText: extractBodyText(msg.payload),
    headers,
    attachments: extractAttachments(msg.payload),
  };
}

/** Extract plain text body from a Gmail message payload. */
function extractBodyText(payload: GmailMessagePayload): string | undefined {
  // Direct text/plain body
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart — find text/plain part
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBodyText(part);
      if (text) return text;
    }
  }

  return undefined;
}

/**
 * Extract attachment metadata from a Gmail message payload.
 * Walks the MIME tree recursively and collects parts that have a filename
 * (Content-Disposition: attachment) or a non-inline body with an attachmentId.
 * Returns metadata only — no binary data is fetched.
 */
function extractAttachments(payload: GmailMessagePayload): AttachmentMeta[] {
  const attachments: AttachmentMeta[] = [];
  collectAttachments(payload, attachments);
  return attachments;
}

function collectAttachments(part: GmailMessagePayload, out: AttachmentMeta[]): void {
  // A part is an attachment if it has a filename header or an attachmentId
  // and is not a plain text/html body part
  const filename = getPartFilename(part);
  const attachmentId = (part.body as { attachmentId?: string } | undefined)?.attachmentId;

  if (filename || (attachmentId && !isBodyMimeType(part.mimeType))) {
    out.push({
      filename: filename || 'unnamed',
      mimeType: part.mimeType,
      size: part.body?.size ?? 0,
      attachmentId: attachmentId || undefined,
    });
  }

  // Recurse into multipart children
  if (part.parts) {
    for (const child of part.parts) {
      collectAttachments(child, out);
    }
  }
}

/** Extract filename from a MIME part's headers. */
function getPartFilename(part: GmailMessagePayload): string | undefined {
  for (const header of part.headers) {
    // Content-Disposition: attachment; filename="report.pdf"
    if (header.name.toLowerCase() === 'content-disposition') {
      const filenameMatch = header.value.match(/filename="?([^";]+)"?/i);
      if (filenameMatch?.[1]) return filenameMatch[1].trim();
    }
    // Content-Type: application/pdf; name="report.pdf"
    if (header.name.toLowerCase() === 'content-type') {
      const nameMatch = header.value.match(/name="?([^";]+)"?/i);
      if (nameMatch?.[1]) return nameMatch[1].trim();
    }
  }
  return undefined;
}

/** Check if a MIME type is a standard body type (not an attachment). */
function isBodyMimeType(mimeType: string): boolean {
  return mimeType === 'text/plain' || mimeType === 'text/html';
}

/** Decode base64url-encoded string (Gmail API encoding). */
export function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/** Encode a string as base64url (for sending messages). */
export function encodeBase64Url(data: string): string {
  return Buffer.from(data, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Build an RFC 2822 email message for sending via Gmail API.
 * Used by the adapter for outbound notification replies.
 */
export function buildRawEmail(options: {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const headers = [
    `From: ${options.from}`,
    `To: ${options.to}`,
    `Subject: ${options.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (options.inReplyTo) {
    headers.push(`In-Reply-To: ${options.inReplyTo}`);
  }
  if (options.references) {
    headers.push(`References: ${options.references}`);
  }

  const raw = headers.join('\r\n') + '\r\n\r\n' + options.body;
  return encodeBase64Url(raw);
}
