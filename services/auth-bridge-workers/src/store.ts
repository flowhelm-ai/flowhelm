/**
 * KV-backed session store for Cloudflare Workers.
 *
 * Each session is stored as a JSON blob in Workers KV with automatic
 * TTL expiry (10 minutes). No cleanup timers needed — KV handles eviction.
 */

export interface SessionData {
  publicKey: string;
  expiresAt: number;
  encrypted?: string;
  ephemeralPublicKey?: string;
  nonce?: string;
}

const DEFAULT_TTL_SECONDS = 600; // 10 minutes

/** Key prefix to avoid collisions with rate limit keys. */
const SESSION_PREFIX = 's:';

export class KVSessionStore {
  constructor(
    private readonly kv: KVNamespace,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ) {}

  async create(token: string, publicKey: string): Promise<boolean> {
    const session: SessionData = {
      publicKey,
      expiresAt: Date.now() + this.ttlSeconds * 1000,
    };

    await this.kv.put(SESSION_PREFIX + token, JSON.stringify(session), {
      expirationTtl: this.ttlSeconds,
    });

    return true;
  }

  async get(token: string): Promise<SessionData | null> {
    const raw = await this.kv.get(SESSION_PREFIX + token);
    if (!raw) return null;

    const session = JSON.parse(raw) as SessionData;

    // Double-check expiry (KV TTL is eventually consistent)
    if (Date.now() > session.expiresAt) {
      await this.kv.delete(SESSION_PREFIX + token);
      return null;
    }

    return session;
  }

  async has(token: string): Promise<boolean> {
    return (await this.get(token)) !== null;
  }

  async submitCredentials(
    token: string,
    encrypted: string,
    ephemeralPublicKey: string,
    nonce: string,
  ): Promise<boolean> {
    const session = await this.get(token);
    if (!session) return false;
    if (session.encrypted) return false;

    session.encrypted = encrypted;
    session.ephemeralPublicKey = ephemeralPublicKey;
    session.nonce = nonce;

    // Rewrite with remaining TTL
    const remainingSeconds = Math.max(
      1,
      Math.floor((session.expiresAt - Date.now()) / 1000),
    );
    await this.kv.put(SESSION_PREFIX + token, JSON.stringify(session), {
      expirationTtl: remainingSeconds,
    });

    return true;
  }

  async delete(token: string): Promise<void> {
    await this.kv.delete(SESSION_PREFIX + token);
  }
}
