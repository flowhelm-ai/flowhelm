/**
 * Service container barrel exports and factory.
 *
 * The service container (`flowhelm-service-{username}`) provides local media
 * inference in per-user isolation. Provider categories:
 *   - STT: whisper.cpp local inference or OpenAI Whisper API (active)
 *   - Vision: pass-through to Claude agent (defined, not installed)
 *   - TTS: stub for future implementation
 */

export { ServiceManager } from './service-manager.js';
export type { ServiceManagerOptions } from './service-manager.js';
export { ServiceClient } from './service-client.js';
export type { ServiceClientOptions, ServiceTranscribeResult } from './service-client.js';
export { ServiceServer } from './service-server.js';
export type { ServiceServerOptions } from './service-server.js';
export { WhisperCppSttProvider, convertToWav, isWhisperHallucination } from './stt-provider.js';
export type { WhisperCppSttOptions } from './stt-provider.js';
export { OpenAiSttProvider } from './openai-stt-provider.js';
export type { OpenAiSttOptions, FetchFn } from './openai-stt-provider.js';
export type {
  ServiceConfig,
  SttProvider,
  SttResult,
  VisionProvider,
  VisionResult,
  TtsProvider,
  TtsResult,
  HealthResponse,
  TranscribeResponse,
  UnderstandResponse,
} from './types.js';
