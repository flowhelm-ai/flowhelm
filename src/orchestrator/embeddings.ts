/**
 * Embedding provider implementations.
 *
 * Default: TransformersEmbeddingProvider — runs all-MiniLM-L6-v2 in-process
 * via @huggingface/transformers (ONNX runtime). ~80 MB model, ~15ms per
 * embedding on CPU, 384-dimensional output. Free, offline, no external API.
 *
 * Optional: OpenAIEmbeddingProvider — uses text-embedding-3-small via
 * OpenAI API. Higher quality but requires API key and network access.
 * Routes through credential proxy for key injection.
 */

import type { EmbeddingProvider } from './types.js';

// ─── Transformers (Local, Default) ─────────────────────────────────────────

/**
 * Local embedding provider using @huggingface/transformers.
 *
 * Loads all-MiniLM-L6-v2 (or configured model) on first call. The ONNX
 * model is cached locally after download (~80 MB). Subsequent calls are
 * fast (~15ms per embedding on CPU).
 */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private readonly modelName: string;
  private readonly cacheDir: string;
  private pipeline: TransformersPipeline | null = null;
  private loading: Promise<TransformersPipeline> | null = null;

  constructor(options?: { model?: string; dimensions?: number; cacheDir?: string }) {
    this.modelName = options?.model ?? 'Xenova/all-MiniLM-L6-v2';
    this.dimensions = options?.dimensions ?? 384;
    // Use user-writable cache dir (global npm install dirs are root-owned)
    const home = process.env['HOME'] ?? '/tmp';
    this.cacheDir = options?.cacheDir ?? `${home}/.cache/huggingface`;
  }

  async embed(text: string): Promise<number[]> {
    const pipe = await this.getPipeline();
    const output = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array).slice(0, this.dimensions);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const pipe = await this.getPipeline();
    const results: number[][] = [];
    // Process sequentially to avoid OOM on large batches
    for (const text of texts) {
      const output = await pipe(text, { pooling: 'mean', normalize: true });
      results.push(Array.from(output.data as Float32Array).slice(0, this.dimensions));
    }
    return results;
  }

  private async getPipeline(): Promise<TransformersPipeline> {
    if (this.pipeline) return this.pipeline;
    if (this.loading) return this.loading;

    this.loading = this.loadPipeline();
    this.pipeline = await this.loading;
    this.loading = null;
    return this.pipeline;
  }

  private async loadPipeline(): Promise<TransformersPipeline> {
    // Dynamic import to avoid loading the 80MB model at module import time
    const { pipeline, env } = await import('@huggingface/transformers');
    // Set cache dir to user-writable location (global npm install is root-owned)
    env.cacheDir = this.cacheDir;
    return pipeline('feature-extraction', this.modelName, {
      dtype: 'fp32',
      cache_dir: this.cacheDir,
    }) as unknown as Promise<TransformersPipeline>;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TransformersPipeline = (text: string, options?: Record<string, unknown>) => Promise<any>;

// ─── OpenAI (API, Optional) ────────────────────────────────────────────────

/**
 * OpenAI embedding provider using text-embedding-3-small.
 *
 * Requires an OpenAI API key. In production, requests route through the
 * credential proxy which injects the real key. The provider only needs
 * the proxy URL and a placeholder key.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: { apiKey: string; baseUrl?: string; model?: string; dimensions?: number }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this.model = options.model ?? 'text-embedding-3-small';
    this.dimensions = options.dimensions ?? 384;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.callApi([text]);
    const first = response[0];
    if (!first) {
      throw new Error('OpenAI embedding API returned empty response');
    }
    return first;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return this.callApi(texts);
  }

  private async callApi(input: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI embedding API error ${String(response.status)}: ${body}`);
    }

    const json = (await response.json()) as OpenAIEmbeddingResponse;
    // Sort by index to ensure correct order
    const sorted = json.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding.slice(0, this.dimensions));
  }
}

interface OpenAIEmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

// ─── Factory ───────────────────────────────────────────────────────────────

export interface EmbeddingProviderConfig {
  provider: 'transformers' | 'openai';
  model?: string;
  dimensions?: number;
  /** Required for OpenAI provider. */
  apiKey?: string;
  /** Base URL override (e.g., for proxy). */
  baseUrl?: string;
}

/**
 * Create an embedding provider from configuration.
 */
export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  switch (config.provider) {
    case 'transformers':
      return new TransformersEmbeddingProvider({
        model: config.model,
        dimensions: config.dimensions,
      });
    case 'openai': {
      if (!config.apiKey) {
        throw new Error('OpenAI embedding provider requires an apiKey');
      }
      return new OpenAIEmbeddingProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        dimensions: config.dimensions,
      });
    }
    default:
      throw new Error(`Unknown embedding provider: ${config.provider as string}`);
  }
}
