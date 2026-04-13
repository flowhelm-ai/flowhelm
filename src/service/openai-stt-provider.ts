/**
 * OpenAI Whisper STT provider for the service container.
 *
 * Calls the OpenAI Audio Transcription API to convert speech to text.
 * Uses raw fetch with multipart/form-data — zero external dependencies.
 *
 * All HTTPS traffic is routed through the FlowHelm credential proxy
 * (MITM TLS) for auditing, rate limiting, and centralized key management.
 * The provider sends a placeholder API key; the proxy replaces it with
 * the real key before forwarding to OpenAI.
 *
 * Pricing: $0.006 per minute of audio (~$0.001 for a typical 10s voice note).
 * Model: whisper-1 (only model available via the API).
 *
 * Advantages over local whisper.cpp:
 *   - No model download (~466 MB for small, ~1.6 GB for large-v3-turbo)
 *   - No CPU load — inference runs on OpenAI's servers
 *   - Faster on shared vCPU instances (network round-trip < CPU inference)
 *   - OGG/Opus natively supported (no ffmpeg conversion needed)
 *
 * Trade-offs:
 *   - Requires internet connectivity and API key
 *   - Per-minute cost (vs. free local inference)
 *   - Audio data leaves the user's infrastructure
 *   - 25 MB file size limit
 */

import { stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { SttProvider, SttResult, SttProviderName } from './types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Custom fetch function type for proxy-aware requests. */
export type FetchFn = typeof globalThis.fetch;

export interface OpenAiSttOptions {
  /** OpenAI API key (placeholder when routed through proxy). */
  apiKey: string;
  /** Default language code (ISO 639-1). Helps accuracy and latency. */
  language?: string;
  /** Request timeout in ms (default: 30000). */
  timeout?: number;
  /** OpenAI API base URL (default: https://api.openai.com/v1). */
  baseUrl?: string;
  /** Custom fetch function (for proxy-aware requests). Uses globalThis.fetch if not provided. */
  fetchFn?: FetchFn;
}

/** OpenAI transcription API response. */
interface OpenAiTranscriptionResponse {
  text: string;
}

/** OpenAI API error response. */
interface OpenAiErrorResponse {
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

/** 25 MB in bytes — OpenAI's file size limit for audio transcription. */
const MAX_FILE_SIZE = 25 * 1024 * 1024;

/**
 * MIME types for audio formats accepted by the OpenAI Whisper API.
 * The API accepts: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm.
 */
const MIME_TYPES: Record<string, string> = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.mp4': 'audio/mp4',
  '.mpeg': 'audio/mpeg',
  '.mpga': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

// ─── Provider ───────────────────────────────────────────────────────────────

export class OpenAiSttProvider implements SttProvider {
  readonly name: SttProviderName = 'openai_whisper';
  private readonly apiKey: string;
  private readonly defaultLanguage: string;
  private readonly timeout: number;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(options: OpenAiSttOptions) {
    this.apiKey = options.apiKey;
    this.defaultLanguage = options.language ?? 'en';
    this.timeout = options.timeout ?? 30_000;
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async transcribe(audioPath: string, language?: string): Promise<SttResult> {
    const startTime = Date.now();
    const lang = language ?? this.defaultLanguage;

    // Verify file exists and check size
    const fileStat = await stat(audioPath);
    if (fileStat.size > MAX_FILE_SIZE) {
      throw new Error(`Audio file exceeds OpenAI's 25 MB limit: ${String(fileStat.size)} bytes`);
    }
    if (fileStat.size === 0) {
      throw new Error('Audio file is empty');
    }

    // Read file and build multipart form data
    const fileBuffer = await readFile(audioPath);
    const fileName = basename(audioPath);
    const ext = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
    const mimeType = MIME_TYPES[ext] ?? 'application/octet-stream';

    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer], { type: mimeType }), fileName);
    formData.append('model', 'whisper-1');
    formData.append('language', lang);
    formData.append('response_format', 'json');

    // Call OpenAI API (routed through credential proxy when HTTPS_PROXY is set)
    const url = `${this.baseUrl}/audio/transcriptions`;
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const errorBody = (await response.json().catch(() => ({}))) as OpenAiErrorResponse;
      const errorMsg = errorBody.error?.message ?? response.statusText;
      throw new Error(`OpenAI Whisper API error (${String(response.status)}): ${errorMsg}`);
    }

    const result = (await response.json()) as OpenAiTranscriptionResponse;
    const text = (result.text ?? '').trim();

    return {
      text,
      provider: 'openai_whisper',
      durationMs: Date.now() - startTime,
      language: lang,
    };
  }

  async isReady(): Promise<boolean> {
    // Ready if we have an API key (real or placeholder — proxy handles the rest)
    return this.apiKey.length > 0;
  }
}
