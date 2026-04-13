import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  TransformersEmbeddingProvider,
  OpenAIEmbeddingProvider,
  createEmbeddingProvider,
} from '../src/orchestrator/embeddings.js';

// ─── Factory ───────────────────────────────────────────────────────────────

describe('createEmbeddingProvider', () => {
  it('creates TransformersEmbeddingProvider', () => {
    const provider = createEmbeddingProvider({ provider: 'transformers' });
    expect(provider).toBeInstanceOf(TransformersEmbeddingProvider);
    expect(provider.dimensions).toBe(384);
  });

  it('creates TransformersEmbeddingProvider with custom dimensions', () => {
    const provider = createEmbeddingProvider({ provider: 'transformers', dimensions: 256 });
    expect(provider.dimensions).toBe(256);
  });

  it('creates OpenAIEmbeddingProvider', () => {
    const provider = createEmbeddingProvider({
      provider: 'openai',
      apiKey: 'sk-test',
    });
    expect(provider).toBeInstanceOf(OpenAIEmbeddingProvider);
    expect(provider.dimensions).toBe(384);
  });

  it('throws if OpenAI provider missing apiKey', () => {
    expect(() => createEmbeddingProvider({ provider: 'openai' })).toThrow('apiKey');
  });

  it('throws for unknown provider', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => createEmbeddingProvider({ provider: 'unknown' as any })).toThrow('Unknown');
  });
});

// ─── OpenAI Provider (Mock HTTP) ───────────────────────────────────────────

describe('OpenAIEmbeddingProvider', () => {
  let server: Server;
  let baseUrl: string;
  let lastRequest: { body: string; headers: Record<string, string | string[] | undefined> } | null =
    null;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        lastRequest = { body, headers: req.headers };
        const parsed = JSON.parse(body) as { input: string[]; dimensions: number };
        const dims = parsed.dimensions ?? 384;

        // Generate deterministic fake embeddings
        const data = parsed.input.map((text: string, index: number) => ({
          embedding: Array(dims)
            .fill(0)
            .map((_, i) => Math.sin(text.length + i + index)),
          index,
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data,
            model: 'text-embedding-3-small',
            usage: { prompt_tokens: 10, total_tokens: 10 },
          }),
        );
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr !== 'string') {
          baseUrl = `http://127.0.0.1:${String(addr.port)}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('sends correct request to API', async () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'sk-test-key',
      baseUrl,
      dimensions: 384,
    });

    await provider.embed('Hello world');

    expect(lastRequest).not.toBeNull();
    const body = JSON.parse(lastRequest!.body) as Record<string, unknown>;
    expect(body.input).toEqual(['Hello world']);
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.dimensions).toBe(384);
    expect(lastRequest!.headers.authorization).toBe('Bearer sk-test-key');
  });

  it('returns correct dimensions', async () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      baseUrl,
      dimensions: 384,
    });

    const embedding = await provider.embed('Test text');
    expect(embedding).toHaveLength(384);
    expect(typeof embedding[0]).toBe('number');
  });

  it('handles batch embedding', async () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      baseUrl,
      dimensions: 384,
    });

    const embeddings = await provider.embedBatch(['Text 1', 'Text 2', 'Text 3']);
    expect(embeddings).toHaveLength(3);
    for (const emb of embeddings) {
      expect(emb).toHaveLength(384);
    }
  });

  it('uses custom model name', async () => {
    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      baseUrl,
      model: 'text-embedding-3-large',
    });

    await provider.embed('Test');
    const body = JSON.parse(lastRequest!.body) as Record<string, unknown>;
    expect(body.model).toBe('text-embedding-3-large');
  });

  it('throws on API error', async () => {
    // Create a server that returns an error
    const errorServer = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Rate limited' } }));
    });

    const errorUrl = await new Promise<string>((resolve) => {
      errorServer.listen(0, '127.0.0.1', () => {
        const addr = errorServer.address();
        if (addr && typeof addr !== 'string') {
          resolve(`http://127.0.0.1:${String(addr.port)}`);
        }
      });
    });

    const provider = new OpenAIEmbeddingProvider({
      apiKey: 'sk-test',
      baseUrl: errorUrl,
    });

    await expect(provider.embed('test')).rejects.toThrow('429');

    await new Promise<void>((resolve) => {
      errorServer.close(() => resolve());
    });
  });
});

// ─── Transformers Provider (Real Model) ────────────────────────────────────

describe('TransformersEmbeddingProvider', () => {
  // These tests load the actual model (~80 MB, downloaded on first run).
  // They are slower but verify the real embedding pipeline works.
  // The model is cached locally after first download.

  it('has correct default dimensions', () => {
    const provider = new TransformersEmbeddingProvider();
    expect(provider.dimensions).toBe(384);
  });

  it('accepts custom model and dimensions', () => {
    const provider = new TransformersEmbeddingProvider({
      model: 'Xenova/all-MiniLM-L6-v2',
      dimensions: 256,
    });
    expect(provider.dimensions).toBe(256);
  });

  it('generates embedding with correct dimensions', async () => {
    const provider = new TransformersEmbeddingProvider();
    const embedding = await provider.embed('Hello world');

    expect(embedding).toHaveLength(384);
    expect(typeof embedding[0]).toBe('number');
    // Embeddings should be normalized (L2 norm ≈ 1)
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 1);
  }, 60_000); // First run may need to download the model

  it('produces deterministic embeddings (same input → same output)', async () => {
    const provider = new TransformersEmbeddingProvider();
    const emb1 = await provider.embed('Deterministic test');
    const emb2 = await provider.embed('Deterministic test');

    expect(emb1).toEqual(emb2);
  }, 60_000);

  it('produces different embeddings for different inputs', async () => {
    const provider = new TransformersEmbeddingProvider();
    const emb1 = await provider.embed('Hello world');
    const emb2 = await provider.embed('Completely different text about databases');

    // Cosine similarity between different texts should be < 1
    const dot = emb1.reduce((sum, v, i) => sum + v * emb2[i], 0);
    expect(dot).toBeLessThan(0.95);
    expect(dot).toBeGreaterThan(-1);
  }, 60_000);

  it('handles batch embedding', async () => {
    const provider = new TransformersEmbeddingProvider();
    const embeddings = await provider.embedBatch(['Text one', 'Text two', 'Text three']);

    expect(embeddings).toHaveLength(3);
    for (const emb of embeddings) {
      expect(emb).toHaveLength(384);
    }
  }, 60_000);

  it('semantically similar texts have higher similarity', async () => {
    const provider = new TransformersEmbeddingProvider();
    const [embCat, embDog, embCar] = await provider.embedBatch([
      'The cat sat on the mat',
      'The dog sat on the rug',
      'SQL databases use indexes for performance',
    ]);

    // Cosine similarity
    const simCatDog = embCat.reduce((s, v, i) => s + v * embDog[i], 0);
    const simCatCar = embCat.reduce((s, v, i) => s + v * embCar[i], 0);

    // Cat-dog should be more similar than cat-car
    expect(simCatDog).toBeGreaterThan(simCatCar);
  }, 60_000);
});
