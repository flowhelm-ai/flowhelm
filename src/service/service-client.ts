/**
 * Service container HTTP client.
 *
 * Used by the orchestrator to call the service container's media processing
 * APIs over the per-user Podman network. Replaces the direct Transcriber
 * dependency — voice transcription now happens inside the service container
 * instead of the orchestrator process.
 *
 * Falls back gracefully when the service container is not available:
 *   - STT: returns error text for the agent to see
 *   - Vision: images pass through to the Claude agent untouched
 */

import type {
  TranscribeRequest,
  TranscribeResponse,
  UnderstandResponse,
  HealthResponse,
  ErrorResponse,
} from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ServiceClientOptions {
  /** Base URL of the service container (e.g., http://flowhelm-service-stan:8787). */
  baseUrl: string;
  /** Request timeout in ms (default: 300000 = 5 min for large audio files). */
  timeout?: number;
}

export interface ServiceTranscribeResult {
  text: string;
  provider: string;
  durationMs: number;
  language: string;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class ServiceClient {
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(options: ServiceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.timeout = options.timeout ?? 300_000;
  }

  /**
   * Transcribe an audio file via the service container.
   *
   * The audio file must be accessible inside the service container
   * (via the shared downloads bind mount). The caller provides
   * the container-internal path (e.g., /downloads/voice-123.ogg).
   */
  async transcribe(
    containerAudioPath: string,
    language?: string,
  ): Promise<ServiceTranscribeResult> {
    const body: TranscribeRequest = {
      audioPath: containerAudioPath,
      language,
    };

    const response = await fetch(`${this.baseUrl}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const error = (await response
        .json()
        .catch(() => ({ error: 'Unknown error' }))) as ErrorResponse;
      throw new Error(`Service STT failed (${String(response.status)}): ${error.error}`);
    }

    const result = (await response.json()) as TranscribeResponse;
    return {
      text: result.text,
      provider: result.provider,
      durationMs: result.durationMs,
      language: result.language,
    };
  }

  /**
   * Process an image via the service container's vision endpoint.
   *
   * Currently a stub — returns a pass-through indicator so the
   * orchestrator knows to forward the image to the Claude agent.
   */
  async understand(containerImagePath: string): Promise<UnderstandResponse | null> {
    const response = await fetch(`${this.baseUrl}/understand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagePath: containerImagePath }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (response.status === 503) {
      // Vision not configured — pass through to Claude agent
      return null;
    }

    if (!response.ok) {
      const error = (await response
        .json()
        .catch(() => ({ error: 'Unknown error' }))) as ErrorResponse;
      throw new Error(`Service vision failed (${String(response.status)}): ${error.error}`);
    }

    return (await response.json()) as UnderstandResponse;
  }

  /**
   * Check if the service container is healthy and which providers are ready.
   */
  async health(): Promise<HealthResponse> {
    const response = await fetch(`${this.baseUrl}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Service health check failed: ${String(response.status)}`);
    }

    return (await response.json()) as HealthResponse;
  }

  /**
   * Check if the service container is reachable.
   */
  async isReachable(): Promise<boolean> {
    try {
      await this.health();
      return true;
    } catch {
      return false;
    }
  }
}
