import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// ─── OpenAiSttProvider Unit Tests ─────────────────────────────────────────

describe('OpenAiSttProvider', () => {
  it('has correct provider name', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');
    const provider = new OpenAiSttProvider({ apiKey: 'sk-test-key' });
    expect(provider.name).toBe('openai_whisper');
  });

  it('isReady returns true when API key is set', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');
    const provider = new OpenAiSttProvider({ apiKey: 'sk-test-key' });
    expect(await provider.isReady()).toBe(true);
  });

  it('isReady returns true with placeholder key (proxy injects real key)', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');
    const { PLACEHOLDER_OPENAI_API_KEY } = await import('../src/proxy/placeholders.js');
    const provider = new OpenAiSttProvider({ apiKey: PLACEHOLDER_OPENAI_API_KEY });
    expect(await provider.isReady()).toBe(true);
  });

  it('isReady returns false when API key is empty', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');
    const provider = new OpenAiSttProvider({ apiKey: '' });
    expect(await provider.isReady()).toBe(false);
  });

  it('throws on non-existent audio file', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');
    const provider = new OpenAiSttProvider({ apiKey: 'sk-test-key' });
    await expect(provider.transcribe('/nonexistent/audio.ogg')).rejects.toThrow();
  });

  it('throws on empty audio file', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');
    const provider = new OpenAiSttProvider({ apiKey: 'sk-test-key' });

    const tmpDir = await mkdtemp(join(tmpdir(), 'openai-stt-'));
    const emptyFile = join(tmpDir, 'empty.ogg');
    await writeFile(emptyFile, Buffer.alloc(0));

    try {
      await expect(provider.transcribe(emptyFile)).rejects.toThrow('empty');
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it('throws when audio file exceeds 25 MB limit', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');
    const provider = new OpenAiSttProvider({ apiKey: 'sk-test-key' });

    const tmpDir = await mkdtemp(join(tmpdir(), 'openai-stt-'));
    const bigFile = join(tmpDir, 'big.ogg');
    // Create a file just over 25 MB using sparse write
    const fd = await import('node:fs/promises').then((m) => m.open(bigFile, 'w'));
    await fd.truncate(26 * 1024 * 1024);
    await fd.close();

    try {
      await expect(provider.transcribe(bigFile)).rejects.toThrow('25 MB');
    } finally {
      await rm(tmpDir, { recursive: true });
    }
  });

  it('uses default language "en" when not specified', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');
    const provider = new OpenAiSttProvider({ apiKey: 'sk-test-key' });
    // We can't test the actual API call, but verify the provider constructs OK
    expect(provider.name).toBe('openai_whisper');
  });

  it('accepts custom language', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');
    const provider = new OpenAiSttProvider({ apiKey: 'sk-test-key', language: 'de' });
    expect(await provider.isReady()).toBe(true);
  });

  it('accepts custom base URL', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');
    const provider = new OpenAiSttProvider({
      apiKey: 'sk-test-key',
      baseUrl: 'https://custom-openai-proxy.example.com/v1',
    });
    expect(await provider.isReady()).toBe(true);
  });

  it('accepts custom timeout', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');
    const provider = new OpenAiSttProvider({
      apiKey: 'sk-test-key',
      timeout: 60_000,
    });
    expect(await provider.isReady()).toBe(true);
  });

  it('accepts custom fetchFn', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');
    const customFetch = vi.fn();
    const provider = new OpenAiSttProvider({
      apiKey: 'sk-test-key',
      fetchFn: customFetch as never,
    });
    expect(await provider.isReady()).toBe(true);
  });
});

// ─── OpenAI API Integration (mock HTTP server) ──────────────────────────

describe('OpenAiSttProvider with mock server', () => {
  let mockServer: http.Server;
  let mockPort: number;
  let tmpDir: string;
  let audioFile: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openai-stt-mock-'));
    audioFile = join(tmpDir, 'test.ogg');
    // Create a small non-empty audio file (content doesn't matter for mock)
    await writeFile(audioFile, Buffer.alloc(1024, 0xff));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
    if (mockServer) {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });

  function startMockServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<number> {
    return new Promise((resolve) => {
      mockServer = http.createServer(handler);
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address();
        mockPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
        resolve(mockPort);
      });
    });
  }

  it('sends correct request and parses successful response', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');

    let receivedAuth = '';
    let receivedContentType = '';

    const port = await startMockServer((req, res) => {
      receivedAuth = req.headers['authorization'] ?? '';
      receivedContentType = req.headers['content-type'] ?? '';

      // Collect request body (to verify multipart was sent)
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        // Verify multipart contains required fields
        expect(body).toContain('whisper-1');
        expect(body).toContain('json');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'Hello, this is a test transcription.' }));
      });
    });

    const provider = new OpenAiSttProvider({
      apiKey: 'sk-test-key-123',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });

    const result = await provider.transcribe(audioFile);

    expect(result.text).toBe('Hello, this is a test transcription.');
    expect(result.provider).toBe('openai_whisper');
    expect(result.language).toBe('en');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(receivedAuth).toBe('Bearer sk-test-key-123');
    expect(receivedContentType).toContain('multipart/form-data');
  });

  it('sends placeholder key (proxy replaces it)', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');
    const { PLACEHOLDER_OPENAI_API_KEY } = await import('../src/proxy/placeholders.js');

    let receivedAuth = '';

    const port = await startMockServer((req, res) => {
      receivedAuth = req.headers['authorization'] ?? '';
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'Transcribed via proxy.' }));
      });
    });

    const provider = new OpenAiSttProvider({
      apiKey: PLACEHOLDER_OPENAI_API_KEY,
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });

    const result = await provider.transcribe(audioFile);
    expect(result.text).toBe('Transcribed via proxy.');
    expect(receivedAuth).toBe(`Bearer ${PLACEHOLDER_OPENAI_API_KEY}`);
  });

  it('uses language override from transcribe() argument', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');

    const port = await startMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        // Verify the language field is 'de' (overridden from default 'en')
        expect(body).toContain('de');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'Hallo, dies ist ein Test.' }));
      });
    });

    const provider = new OpenAiSttProvider({
      apiKey: 'sk-test',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });

    const result = await provider.transcribe(audioFile, 'de');
    expect(result.text).toBe('Hallo, dies ist ein Test.');
    expect(result.language).toBe('de');
  });

  it('throws on API error response', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');

    const port = await startMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: 'Invalid API key',
              type: 'invalid_request_error',
              code: 'invalid_api_key',
            },
          }),
        );
      });
    });

    const provider = new OpenAiSttProvider({
      apiKey: 'sk-invalid',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });

    await expect(provider.transcribe(audioFile)).rejects.toThrow('Invalid API key');
  });

  it('throws on rate limit (429)', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');

    const port = await startMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'Rate limit exceeded', type: 'rate_limit_error' },
          }),
        );
      });
    });

    const provider = new OpenAiSttProvider({
      apiKey: 'sk-test',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });

    await expect(provider.transcribe(audioFile)).rejects.toThrow('Rate limit exceeded');
  });

  it('throws on server error (500)', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');

    const port = await startMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Internal server error' } }));
      });
    });

    const provider = new OpenAiSttProvider({
      apiKey: 'sk-test',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });

    await expect(provider.transcribe(audioFile)).rejects.toThrow('500');
  });

  it('handles empty transcription text', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');

    const port = await startMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: '' }));
      });
    });

    const provider = new OpenAiSttProvider({
      apiKey: 'sk-test',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });

    const result = await provider.transcribe(audioFile);
    expect(result.text).toBe('');
  });

  it('trims whitespace from transcription result', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');

    const port = await startMockServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: '  Hello world  \n' }));
      });
    });

    const provider = new OpenAiSttProvider({
      apiKey: 'sk-test',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });

    const result = await provider.transcribe(audioFile);
    expect(result.text).toBe('Hello world');
  });

  it('uses custom fetchFn when provided', async () => {
    const { OpenAiSttProvider } = await import('../src/service/openai-stt-provider.js');

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: 'From custom fetch' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const provider = new OpenAiSttProvider({
      apiKey: 'sk-test',
      fetchFn: mockFetch as unknown as typeof globalThis.fetch,
    });

    const result = await provider.transcribe(audioFile);
    expect(result.text).toBe('From custom fetch');
    expect(mockFetch).toHaveBeenCalledOnce();

    // Verify the URL and auth header
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((options.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test');
  });
});

// ─── Config Schema: openai_whisper ──────────────────────────────────────

describe('Config schema: openai_whisper provider', () => {
  it('accepts openai_whisper as STT provider', async () => {
    const { flowhelmConfigSchema } = await import('../src/config/schema.js');
    const config = flowhelmConfigSchema.parse({
      username: 'testuser',
      service: {
        enabled: true,
        stt: {
          provider: 'openai_whisper',
        },
      },
    });

    expect(config.service.stt.provider).toBe('openai_whisper');
  });

  it('still defaults to whisper_cpp', async () => {
    const { flowhelmConfigSchema } = await import('../src/config/schema.js');
    const config = flowhelmConfigSchema.parse({ username: 'testuser' });
    expect(config.service.stt.provider).toBe('whisper_cpp');
  });

  it('rejects invalid provider names', async () => {
    const { flowhelmConfigSchema } = await import('../src/config/schema.js');
    expect(() =>
      flowhelmConfigSchema.parse({
        username: 'testuser',
        service: { stt: { provider: 'invalid_provider' } },
      }),
    ).toThrow();
  });
});

// ─── ServiceManager proxy routing ──────────────────────────────────────────

describe('ServiceManager routes OpenAI through proxy', () => {
  it('includes proxy env vars and CA mount when proxyUrl and caCertPath are set', async () => {
    const { ServiceManager } = await import('../src/service/service-manager.js');
    const { PLACEHOLDER_OPENAI_API_KEY } = await import('../src/proxy/placeholders.js');

    const manager = new ServiceManager({
      runtime: { exists: vi.fn() } as never,
      username: 'testuser',
      config: {
        enabled: true,
        image: 'flowhelm-service:latest',
        memoryLimit: '2g',
        cpuLimit: '2.0',
        port: 8787,
        stt: {
          enabled: true,
          provider: 'openai_whisper',
          modelPath: '/models/ggml-small.bin',
          language: 'en',
          threads: 2,
        },
        vision: { enabled: true, provider: 'claude' },
        tts: { enabled: false, provider: 'none' },
      },
      downloadsDir: '/tmp/downloads',
      modelsDir: '/tmp/models',
      hostPort: 8787,
      proxyUrl: 'http://flowhelm-proxy-testuser:10255',
      caCertPath: '/home/flowhelm-testuser/.flowhelm/secrets/ca.crt',
    });

    const containerConfig = manager.buildContainerConfig();

    // Proxy env vars
    expect(containerConfig.env?.['HTTPS_PROXY']).toBe('http://flowhelm-proxy-testuser:10255');
    expect(containerConfig.env?.['HTTP_PROXY']).toBe('http://flowhelm-proxy-testuser:10255');
    expect(containerConfig.env?.['NO_PROXY']).toBe('localhost,127.0.0.1');
    expect(containerConfig.env?.['NODE_EXTRA_CA_CERTS']).toBe(
      '/usr/local/share/ca-certificates/flowhelm-proxy-ca.crt',
    );

    // Placeholder API key (not real key)
    expect(containerConfig.env?.['SERVICE_OPENAI_API_KEY']).toBe(PLACEHOLDER_OPENAI_API_KEY);

    // CA cert mount
    const caMount = containerConfig.mounts?.find(
      (m) => m.target === '/usr/local/share/ca-certificates/flowhelm-proxy-ca.crt',
    );
    expect(caMount).toBeDefined();
    expect(caMount?.source).toBe('/home/flowhelm-testuser/.flowhelm/secrets/ca.crt');
    expect(caMount?.readOnly).toBe(true);
  });

  it('omits proxy env vars when proxyUrl is not set', async () => {
    const { ServiceManager } = await import('../src/service/service-manager.js');

    const manager = new ServiceManager({
      runtime: { exists: vi.fn() } as never,
      username: 'testuser',
      config: {
        enabled: true,
        image: 'flowhelm-service:latest',
        memoryLimit: '2g',
        cpuLimit: '2.0',
        port: 8787,
        stt: {
          enabled: true,
          provider: 'openai_whisper',
          modelPath: '/models/ggml-small.bin',
          language: 'en',
          threads: 2,
        },
        vision: { enabled: true, provider: 'claude' },
        tts: { enabled: false, provider: 'none' },
      },
      downloadsDir: '/tmp/downloads',
      modelsDir: '/tmp/models',
      hostPort: 8787,
    });

    const containerConfig = manager.buildContainerConfig();

    expect(containerConfig.env?.['HTTPS_PROXY']).toBeUndefined();
    expect(containerConfig.env?.['HTTP_PROXY']).toBeUndefined();
    expect(containerConfig.env?.['SERVICE_OPENAI_API_KEY']).toBe('');
  });

  it('omits OpenAI env vars for whisper_cpp provider', async () => {
    const { ServiceManager } = await import('../src/service/service-manager.js');

    const manager = new ServiceManager({
      runtime: { exists: vi.fn() } as never,
      username: 'testuser',
      config: {
        enabled: true,
        image: 'flowhelm-service:latest',
        memoryLimit: '2g',
        cpuLimit: '2.0',
        port: 8787,
        stt: {
          enabled: true,
          provider: 'whisper_cpp',
          modelPath: '/models/ggml-small.bin',
          language: 'en',
          threads: 2,
        },
        vision: { enabled: true, provider: 'claude' },
        tts: { enabled: false, provider: 'none' },
      },
      downloadsDir: '/tmp/downloads',
      modelsDir: '/tmp/models',
      hostPort: 8787,
      proxyUrl: 'http://flowhelm-proxy-testuser:10255',
      caCertPath: '/home/flowhelm-testuser/.flowhelm/secrets/ca.crt',
    });

    const containerConfig = manager.buildContainerConfig();

    // Proxy is still set (for future providers that may need it)
    expect(containerConfig.env?.['HTTPS_PROXY']).toBe('http://flowhelm-proxy-testuser:10255');

    // No OpenAI env var for whisper_cpp
    expect(containerConfig.env?.['SERVICE_OPENAI_API_KEY']).toBeUndefined();
    expect(containerConfig.env?.['SERVICE_STT_PROVIDER']).toBe('whisper_cpp');
  });
});

// ─── Placeholder Constants ──────────────────────────────────────────────

describe('OpenAI placeholder constant', () => {
  it('PLACEHOLDER_OPENAI_API_KEY is a non-empty string', async () => {
    const { PLACEHOLDER_OPENAI_API_KEY } = await import('../src/proxy/placeholders.js');
    expect(PLACEHOLDER_OPENAI_API_KEY).toBeTruthy();
    expect(typeof PLACEHOLDER_OPENAI_API_KEY).toBe('string');
    expect(PLACEHOLDER_OPENAI_API_KEY.length).toBeGreaterThan(0);
  });

  it('PLACEHOLDER_OPENAI_API_KEY contains "placeholder"', async () => {
    const { PLACEHOLDER_OPENAI_API_KEY } = await import('../src/proxy/placeholders.js');
    expect(PLACEHOLDER_OPENAI_API_KEY).toContain('placeholder');
  });
});
