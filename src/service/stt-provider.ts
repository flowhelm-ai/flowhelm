/**
 * whisper.cpp STT provider for the service container.
 *
 * Spawns the whisper-cli binary to transcribe audio files locally.
 * Uses the large-v3-turbo GGML model for optimal quality/speed on CPU.
 *
 * The model architecture is identical to faster-whisper's large-v3-turbo
 * (same Whisper weights), but uses whisper.cpp's GGML inference engine
 * instead of CTranslate2 — no Python dependency required.
 *
 * Default model: ggml-small.bin (~466 MB) — best balance of speed and
 * accuracy for voice notes on shared vCPU. Use ggml-large-v3-turbo.bin
 * (~1.6 GB) on GPU or dedicated CPU for maximum quality.
 * Performance: ~3-5x real-time on 2 CPU threads (30s audio in ~6-10s)
 */

import { execFile } from 'node:child_process';
import { stat, access, constants, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { extname, join, basename } from 'node:path';
import type { SttProvider, SttResult, SttProviderName } from './types.js';

const execFileAsync = promisify(execFile);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WhisperCppSttOptions {
  /** Path to the GGML model file. */
  modelPath: string;
  /** Default language code (ISO 639-1). */
  language?: string;
  /** Number of CPU threads for inference. */
  threads?: number;
  /** Binary name or path (default: "whisper-cli"). */
  binaryPath?: string;
  /** Max execution time in ms (default: 300000 = 5 minutes). */
  timeout?: number;
}

/** Known binary names for whisper.cpp, tried in order. */
const BINARY_NAMES = ['whisper-cli', 'whisper', 'main'];

/**
 * Audio formats that whisper-cli can decode natively (no conversion needed).
 * WAV is the only guaranteed format. FLAC and MP3 support depends on build
 * flags that may not be present in our Alpine build.
 */
const NATIVE_FORMATS = new Set(['.wav']);

/**
 * Known Whisper hallucination phrases on silent or near-silent audio.
 * Whisper commonly outputs these stock phrases when given silence or
 * ambient noise instead of actual speech — a well-documented behavior
 * across all Whisper model sizes and inference engines.
 */
const WHISPER_HALLUCINATIONS = new Set([
  'thank you.',
  'thank you',
  'thanks for watching.',
  'thanks for watching',
  'subscribe to my channel.',
  'subscribe to my channel',
  'like and subscribe.',
  'like and subscribe',
  'please subscribe.',
  'please subscribe',
  'thank you for watching.',
  'thank you for watching',
  'bye.',
  'bye',
  'you',
  'the end.',
  'the end',
  // Non-English hallucinations (common on silence)
  'продолжение следует',
  'продолжение следует...',
  'sous-titres',
  "sous-titres réalisés par la communauté d'amara.org",
  'sottotitoli creati dalla comunità amara.org',
  'untertitel von stephanie geiges',
  'amara.org',
  'www.mooji.org',
  'ご視聴ありがとうございました',
]);

/**
 * Regex for repetitive hallucinations (e.g. "Thank you. Thank you. Thank you.")
 */
const HALLUCINATION_REPEAT_RE = /^(?:thank you|thanks|bye|you|ok|okay|the end|[.,!\s])+$/i;

// ─── Provider ───────────────────────────────────────────────────────────────

export class WhisperCppSttProvider implements SttProvider {
  readonly name: SttProviderName = 'whisper_cpp';
  private readonly modelPath: string;
  private readonly defaultLanguage: string;
  private readonly threads: number;
  private readonly binaryPath: string | undefined;
  private readonly timeout: number;

  constructor(options: WhisperCppSttOptions) {
    this.modelPath = options.modelPath;
    this.defaultLanguage = options.language ?? 'en';
    this.threads = options.threads ?? 2;
    this.binaryPath = options.binaryPath;
    this.timeout = options.timeout ?? 300_000;
  }

  async transcribe(audioPath: string, language?: string): Promise<SttResult> {
    const startTime = Date.now();
    const lang = language ?? this.defaultLanguage;

    // Verify audio file exists
    await stat(audioPath);

    const binary = await findBinary(this.binaryPath);
    if (!binary) {
      throw new Error('whisper.cpp binary not found in PATH');
    }

    // Convert non-native formats to WAV via ffmpeg (e.g. OGG/Opus → WAV)
    let wavPath: string | undefined;
    const ext = extname(audioPath).toLowerCase();
    const inputPath = NATIVE_FORMATS.has(ext)
      ? audioPath
      : (wavPath = await convertToWav(audioPath));

    try {
      const args = [
        '-m',
        this.modelPath,
        '-l',
        lang,
        '-f',
        inputPath,
        '-t',
        String(this.threads),
        '--no-timestamps',
        '--no-prints',
      ];

      const { stdout, stderr } = await execFileAsync(binary, args, {
        timeout: this.timeout,
        maxBuffer: 10 * 1024 * 1024,
      });

      const text = parseWhisperOutput(stdout);
      if (!text) {
        throw new Error(
          `whisper.cpp returned empty transcription. stderr: ${stderr.slice(0, 500)}`,
        );
      }

      // Filter out known Whisper hallucinations on silence/noise
      if (isWhisperHallucination(text)) {
        return {
          text: '',
          provider: 'whisper_cpp',
          durationMs: Date.now() - startTime,
          language: lang,
        };
      }

      return {
        text,
        provider: 'whisper_cpp',
        durationMs: Date.now() - startTime,
        language: lang,
      };
    } finally {
      // Clean up temporary WAV file if we converted
      if (wavPath) {
        await unlink(wavPath).catch(() => {});
      }
    }
  }

  async isReady(): Promise<boolean> {
    const binary = await findBinary(this.binaryPath);
    if (!binary) return false;

    try {
      await access(this.modelPath, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Convert an audio file to 16kHz mono WAV using ffmpeg.
 *
 * whisper.cpp requires WAV input with specific parameters.
 * Telegram voice notes arrive as OGG (Opus codec) which whisper-cli
 * cannot decode directly despite listing OGG in its help text.
 *
 * @returns Path to the temporary WAV file (caller must clean up).
 */
export async function convertToWav(inputPath: string): Promise<string> {
  const name = basename(inputPath, extname(inputPath));
  // Write to /tmp (writable tmpfs) — /downloads is mounted read-only
  const tmpDir = process.env['TMPDIR'] ?? '/tmp';
  const wavPath = join(tmpDir, `${name}_converted.wav`);

  await execFileAsync(
    'ffmpeg',
    [
      '-y', // Overwrite output without asking
      '-i',
      inputPath, // Input file
      '-ar',
      '16000', // 16 kHz sample rate (Whisper's native rate)
      '-ac',
      '1', // Mono channel
      '-f',
      'wav', // Output format
      wavPath,
    ],
    {
      timeout: 30_000, // 30s should be plenty for any voice note
    },
  );

  return wavPath;
}

/**
 * Check if a transcript is a known Whisper hallucination on silence.
 *
 * Whisper commonly outputs these phrases when given silent or near-silent
 * audio. Returning them to the user would be confusing.
 */
export function isWhisperHallucination(transcript: string): boolean {
  const cleaned = transcript.trim().toLowerCase();
  if (!cleaned) return true;

  // Exact match against known phrases
  if (
    WHISPER_HALLUCINATIONS.has(cleaned) ||
    WHISPER_HALLUCINATIONS.has(cleaned.replace(/[.!]+$/, ''))
  ) {
    return true;
  }

  // Repetitive patterns (e.g. "Thank you. Thank you. Thank you.")
  if (HALLUCINATION_REPEAT_RE.test(cleaned)) {
    return true;
  }

  return false;
}

async function findBinary(explicit?: string): Promise<string | undefined> {
  const candidates = explicit ? [explicit] : BINARY_NAMES;
  for (const bin of candidates) {
    try {
      await execFileAsync('which', [bin]);
      return bin;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Parse whisper.cpp stdout output.
 *
 * Strips timestamp prefixes if present, joins lines, collapses whitespace.
 */
function parseWhisperOutput(stdout: string): string {
  const lines = stdout.split('\n');
  const textLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Strip timestamp prefix: [00:00:00.000 --> 00:00:05.000]
    const timestampMatch = /^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*(.*)$/.exec(trimmed);
    if (timestampMatch) {
      const text = timestampMatch[1]?.trim();
      if (text) textLines.push(text);
    } else {
      textLines.push(trimmed);
    }
  }

  return textLines.join(' ').replace(/\s+/g, ' ').trim();
}
