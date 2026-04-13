/**
 * Ephemeral in-memory session store with TTL auto-cleanup.
 *
 * Sessions live for 10 minutes (configurable). No persistence across restarts.
 * Max 10,000 concurrent sessions to bound memory usage.
 */

export interface SessionData {
  /** VM's X25519 public key (base64). */
  publicKey: string;
  /** Absolute expiry timestamp (ms since epoch). */
  expiresAt: number;
  /** Encrypted credential blob (set by browser, null until submitted). */
  encrypted?: string;
  /** Browser's ephemeral X25519 public key (base64). */
  ephemeralPublicKey?: string;
  /** AES-256-GCM nonce (base64). */
  nonce?: string;
}

export interface StoreOptions {
  /** Session TTL in milliseconds. Default: 600_000 (10 minutes). */
  ttlMs?: number;
  /** Maximum concurrent sessions. Default: 10_000. */
  maxSessions?: number;
  /** Cleanup interval in milliseconds. Default: 60_000 (1 minute). */
  cleanupIntervalMs?: number;
}

const DEFAULT_TTL_MS = 600_000;
const DEFAULT_MAX_SESSIONS = 10_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

export class SessionStore {
  private readonly sessions = new Map<string, SessionData>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: StoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;

    const cleanupInterval =
      options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupInterval);
    // Allow the process to exit even if the timer is still running.
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /** Create a new session. Returns false if the store is full. */
  create(token: string, publicKey: string): boolean {
    if (this.sessions.size >= this.maxSessions) {
      return false;
    }

    this.sessions.set(token, {
      publicKey,
      expiresAt: Date.now() + this.ttlMs,
    });

    return true;
  }

  /** Get a session by token. Returns undefined if expired or missing. */
  get(token: string): SessionData | undefined {
    const session = this.sessions.get(token);
    if (!session) return undefined;

    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return undefined;
    }

    return session;
  }

  /** Check if a token exists (not expired). */
  has(token: string): boolean {
    return this.get(token) !== undefined;
  }

  /**
   * Submit encrypted credentials for a session.
   * Returns false if session not found/expired or already has credentials.
   */
  submitCredentials(
    token: string,
    encrypted: string,
    ephemeralPublicKey: string,
    nonce: string,
  ): boolean {
    const session = this.get(token);
    if (!session) return false;
    if (session.encrypted) return false; // already submitted

    session.encrypted = encrypted;
    session.ephemeralPublicKey = ephemeralPublicKey;
    session.nonce = nonce;
    return true;
  }

  /** Delete a session (called by VM after successful auth). */
  delete(token: string): boolean {
    return this.sessions.delete(token);
  }

  /** Number of active (non-expired) sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Remove all expired sessions. */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [token, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(token);
        removed++;
      }
    }
    return removed;
  }

  /** Stop the cleanup timer. Call on shutdown. */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.sessions.clear();
  }
}
