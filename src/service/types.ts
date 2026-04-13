/**
 * Service container provider interfaces and HTTP API types.
 *
 * The service container (`flowhelm-service-{username}`) runs local media
 * inference workloads in per-user isolation. It exposes an HTTP API
 * on the per-user Podman network for the orchestrator to call.
 *
 * Provider categories:
 *   - STT (Speech-to-Text): whisper.cpp with large-v3-turbo GGML model
 *   - Vision/OCR: defined but not installed — pass-through to Claude agent
 *   - TTS (Text-to-Speech): stub for future implementation
 */

// ─── STT Provider ──────────────────────────────────────────────────────────

export type SttProviderName = 'whisper_cpp' | 'openai_whisper';

export interface SttResult {
  /** Transcribed text. */
  text: string;
  /** Which provider produced this transcription. */
  provider: SttProviderName;
  /** Transcription latency in milliseconds. */
  durationMs: number;
  /** Language code used for transcription. */
  language: string;
}

/**
 * Speech-to-text provider interface.
 *
 * Implementations convert audio files to text using a local inference
 * engine running inside the service container.
 */
export interface SttProvider {
  readonly name: SttProviderName;
  /** Transcribe an audio file to text. */
  transcribe(audioPath: string, language?: string): Promise<SttResult>;
  /** Check if the provider is ready (binary + model available). */
  isReady(): Promise<boolean>;
}

// ─── Vision Provider ───────────────────────────────────────────────────────

export type VisionProviderName = 'claude' | 'none';

export interface VisionResult {
  /** Extracted text / description from the image. */
  text: string;
  /** Which provider produced this result. */
  provider: VisionProviderName;
  /** Processing latency in milliseconds. */
  durationMs: number;
}

/**
 * Vision/OCR provider interface.
 *
 * 'claude' provider is a pass-through — images are forwarded to the
 * Claude agent for processing. 'none' skips vision entirely.
 */
export interface VisionProvider {
  readonly name: VisionProviderName;
  /** Process an image file. */
  understand(imagePath: string): Promise<VisionResult>;
  /** Check if the provider is ready. */
  isReady(): Promise<boolean>;
}

// ─── TTS Provider ──────────────────────────────────────────────────────────

export type TtsProviderName = 'none';

export interface TtsResult {
  /** Path to generated audio file. */
  audioPath: string;
  /** Which provider produced this audio. */
  provider: TtsProviderName;
  /** Generation latency in milliseconds. */
  durationMs: number;
}

/**
 * Text-to-speech provider interface (stub for future implementation).
 */
export interface TtsProvider {
  readonly name: TtsProviderName;
  /** Synthesize text to audio. */
  synthesize(text: string, outputPath: string): Promise<TtsResult>;
  /** Check if the provider is ready. */
  isReady(): Promise<boolean>;
}

// ─── HTTP API Types ────────────────────────────────────────────────────────

export interface TranscribeRequest {
  /** Absolute path to the audio file (inside the container). */
  audioPath: string;
  /** Language code (ISO 639-1). */
  language?: string;
}

export interface TranscribeResponse {
  text: string;
  provider: SttProviderName;
  durationMs: number;
  language: string;
}

export interface UnderstandRequest {
  /** Absolute path to the image file (inside the container). */
  imagePath: string;
}

export interface UnderstandResponse {
  text: string;
  provider: VisionProviderName;
  durationMs: number;
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  providers: {
    stt: { ready: boolean; provider: SttProviderName };
    vision: { ready: boolean; provider: VisionProviderName };
    tts: { ready: boolean; provider: TtsProviderName };
  };
  uptimeMs: number;
}

export interface ErrorResponse {
  error: string;
  code: string;
}

// ─── Service Config Types ──────────────────────────────────────────────────

export interface ServiceSttConfig {
  enabled: boolean;
  provider: SttProviderName;
  modelPath: string;
  language: string;
  threads: number;
}

export interface ServiceVisionConfig {
  enabled: boolean;
  provider: VisionProviderName;
}

export interface ServiceTtsConfig {
  enabled: boolean;
  provider: TtsProviderName;
}

export interface ServiceConfig {
  enabled: boolean;
  image: string;
  memoryLimit: string;
  cpuLimit: string;
  port: number;
  stt: ServiceSttConfig;
  vision: ServiceVisionConfig;
  tts: ServiceTtsConfig;
}
