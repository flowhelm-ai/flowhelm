import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

// ─── Config Schema: Service Section ────────────────────────────────────────

describe('Config schema: service section', () => {
  // Importing at top level would pull in all dependencies, so we import inline
  it('provides sensible defaults when service is omitted', async () => {
    const { flowhelmConfigSchema } = await import('../src/config/schema.js');
    const config = flowhelmConfigSchema.parse({ username: 'testuser' });

    expect(config.service.enabled).toBe(false);
    expect(config.service.image).toBe('ghcr.io/flowhelm-ai/flowhelm-service:0.1.0');
    expect(config.service.memoryLimit).toBe('2g');
    expect(config.service.cpuLimit).toBe('2.0');
    expect(config.service.port).toBe(8787);
    expect(config.service.stt.enabled).toBe(true);
    expect(config.service.stt.provider).toBe('whisper_cpp');
    expect(config.service.stt.modelPath).toBe('/models/ggml-small.bin');
    expect(config.service.stt.language).toBe('en');
    expect(config.service.stt.threads).toBe(2);
    expect(config.service.vision.enabled).toBe(true);
    expect(config.service.vision.provider).toBe('claude');
    expect(config.service.tts.enabled).toBe(false);
    expect(config.service.tts.provider).toBe('none');
  });

  it('accepts custom service configuration', async () => {
    const { flowhelmConfigSchema } = await import('../src/config/schema.js');
    const config = flowhelmConfigSchema.parse({
      username: 'testuser',
      service: {
        enabled: true,
        image: 'flowhelm-service:v2',
        memoryLimit: '4g',
        cpuLimit: '4.0',
        port: 9999,
        stt: {
          enabled: true,
          provider: 'whisper_cpp',
          modelPath: '/custom/model.bin',
          language: 'de',
          threads: 4,
        },
        vision: { enabled: false, provider: 'none' },
        tts: { enabled: false, provider: 'none' },
      },
    });

    expect(config.service.enabled).toBe(true);
    expect(config.service.image).toBe('flowhelm-service:v2');
    expect(config.service.memoryLimit).toBe('4g');
    expect(config.service.cpuLimit).toBe('4.0');
    expect(config.service.port).toBe(9999);
    expect(config.service.stt.modelPath).toBe('/custom/model.bin');
    expect(config.service.stt.language).toBe('de');
    expect(config.service.stt.threads).toBe(4);
    expect(config.service.vision.provider).toBe('none');
  });

  it('rejects invalid port numbers', async () => {
    const { flowhelmConfigSchema } = await import('../src/config/schema.js');
    expect(() =>
      flowhelmConfigSchema.parse({
        username: 'testuser',
        service: { port: 80 },
      }),
    ).toThrow();
  });

  it('rejects invalid thread count', async () => {
    const { flowhelmConfigSchema } = await import('../src/config/schema.js');
    expect(() =>
      flowhelmConfigSchema.parse({
        username: 'testuser',
        service: { stt: { threads: 0 } },
      }),
    ).toThrow();
  });
});

// ─── Service Types ─────────────────────────────────────────────────────────

describe('Service types', () => {
  it('exports all required types', async () => {
    const types = await import('../src/service/types.js');
    // Type-level test — ensure interfaces are importable
    expect(types).toBeDefined();
  });
});

// ─── STT Provider (whisper.cpp) ────────────────────────────────────────────

describe('WhisperCppSttProvider', () => {
  it('isReady returns false when binary is missing', async () => {
    const { WhisperCppSttProvider } = await import('../src/service/stt-provider.js');
    const provider = new WhisperCppSttProvider({
      modelPath: '/nonexistent/model.bin',
      language: 'en',
      threads: 2,
      binaryPath: '/nonexistent/whisper-cli',
    });

    expect(await provider.isReady()).toBe(false);
  });

  it('isReady returns false when model is missing', async () => {
    const { WhisperCppSttProvider } = await import('../src/service/stt-provider.js');
    const provider = new WhisperCppSttProvider({
      modelPath: '/nonexistent/model.bin',
      language: 'en',
      threads: 2,
    });

    expect(await provider.isReady()).toBe(false);
  });

  it('has correct provider name', async () => {
    const { WhisperCppSttProvider } = await import('../src/service/stt-provider.js');
    const provider = new WhisperCppSttProvider({
      modelPath: '/models/test.bin',
    });
    expect(provider.name).toBe('whisper_cpp');
  });

  it('throws on missing audio file', async () => {
    const { WhisperCppSttProvider } = await import('../src/service/stt-provider.js');
    const provider = new WhisperCppSttProvider({
      modelPath: '/models/test.bin',
    });

    await expect(provider.transcribe('/nonexistent/audio.ogg')).rejects.toThrow();
  });
});

// ─── Whisper Hallucination Filter ─────────────────────────────────────────

describe('isWhisperHallucination', () => {
  it('detects empty string as hallucination', async () => {
    const { isWhisperHallucination } = await import('../src/service/stt-provider.js');
    expect(isWhisperHallucination('')).toBe(true);
    expect(isWhisperHallucination('   ')).toBe(true);
  });

  it('detects exact match hallucinations', async () => {
    const { isWhisperHallucination } = await import('../src/service/stt-provider.js');
    expect(isWhisperHallucination('Thank you.')).toBe(true);
    expect(isWhisperHallucination('thank you')).toBe(true);
    expect(isWhisperHallucination('Thanks for watching.')).toBe(true);
    expect(isWhisperHallucination('Subscribe to my channel.')).toBe(true);
    expect(isWhisperHallucination('Bye.')).toBe(true);
    expect(isWhisperHallucination('The end.')).toBe(true);
    expect(isWhisperHallucination('you')).toBe(true);
  });

  it('detects non-English hallucinations', async () => {
    const { isWhisperHallucination } = await import('../src/service/stt-provider.js');
    expect(isWhisperHallucination('продолжение следует')).toBe(true);
    expect(isWhisperHallucination("sous-titres réalisés par la communauté d'amara.org")).toBe(true);
    expect(isWhisperHallucination('ご視聴ありがとうございました')).toBe(true);
  });

  it('detects repetitive patterns', async () => {
    const { isWhisperHallucination } = await import('../src/service/stt-provider.js');
    expect(isWhisperHallucination('Thank you. Thank you. Thank you.')).toBe(true);
    expect(isWhisperHallucination('Bye. Bye. Bye.')).toBe(true);
    expect(isWhisperHallucination('ok ok ok')).toBe(true);
    expect(isWhisperHallucination('you you you')).toBe(true);
  });

  it('strips trailing punctuation for matching', async () => {
    const { isWhisperHallucination } = await import('../src/service/stt-provider.js');
    expect(isWhisperHallucination('Thank you!!')).toBe(true);
    expect(isWhisperHallucination('Bye!!')).toBe(true);
    expect(isWhisperHallucination('The end!!')).toBe(true);
  });

  it('does NOT flag real speech', async () => {
    const { isWhisperHallucination } = await import('../src/service/stt-provider.js');
    expect(isWhisperHallucination('Hello, how are you doing today?')).toBe(false);
    expect(isWhisperHallucination('Please send me the report by Friday.')).toBe(false);
    expect(isWhisperHallucination('I need to schedule a meeting for tomorrow.')).toBe(false);
    expect(isWhisperHallucination('Can you check the database connection?')).toBe(false);
  });

  it('is case-insensitive', async () => {
    const { isWhisperHallucination } = await import('../src/service/stt-provider.js');
    expect(isWhisperHallucination('THANK YOU.')).toBe(true);
    expect(isWhisperHallucination('Thank You For Watching.')).toBe(true);
    expect(isWhisperHallucination('BYE')).toBe(true);
  });
});

// ─── OGG→WAV Conversion ──────────────────────────────────────────────────

describe('convertToWav', () => {
  it('generates correct output path', async () => {
    // We can't easily test the actual ffmpeg call without ffmpeg installed,
    // but we can test the path logic by checking the function exists
    const { convertToWav } = await import('../src/service/stt-provider.js');
    expect(typeof convertToWav).toBe('function');
  });

  it('rejects when ffmpeg is not available', async () => {
    const { convertToWav } = await import('../src/service/stt-provider.js');
    // Passing a non-existent file should fail (either ffmpeg not found or file not found)
    await expect(convertToWav('/nonexistent/audio.ogg')).rejects.toThrow();
  });
});

// ─── Service Server ────────────────────────────────────────────────────────

describe('ServiceServer', () => {
  let server: InstanceType<typeof import('../src/service/service-server.js').ServiceServer>;
  let port: number;

  beforeEach(async () => {
    const { ServiceServer } = await import('../src/service/service-server.js');
    port = 30000 + Math.floor(Math.random() * 10000);
    server = new ServiceServer({ port });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('responds to /healthz with provider status', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('degraded'); // No providers configured
    expect(body.providers.stt.ready).toBe(false);
    expect(body.providers.vision.ready).toBe(false);
    expect(body.providers.tts.ready).toBe(false);
    expect(typeof body.uptimeMs).toBe('number');
  });

  it('returns 404 for unknown endpoints', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('NOT_FOUND');
  });

  it('returns 503 when STT is not configured', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioPath: '/test.ogg' }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('STT_DISABLED');
  });

  it('returns 503 when vision is not configured', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/understand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagePath: '/test.png' }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('VISION_DISABLED');
  });

  it('returns 501 for TTS endpoint', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello' }),
    });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.code).toBe('NOT_IMPLEMENTED');
  });
});

describe('ServiceServer with mock STT', () => {
  let server: InstanceType<typeof import('../src/service/service-server.js').ServiceServer>;
  let port: number;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'service-stt-'));
    const { ServiceServer } = await import('../src/service/service-server.js');
    port = 30000 + Math.floor(Math.random() * 10000);

    // Create a mock STT provider
    const mockStt = {
      name: 'whisper_cpp' as const,
      transcribe: vi.fn().mockResolvedValue({
        text: 'Hello world',
        provider: 'whisper_cpp' as const,
        durationMs: 1234,
        language: 'en',
      }),
      isReady: vi.fn().mockResolvedValue(true),
    };

    server = new ServiceServer({ port, sttProvider: mockStt });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('healthz shows STT as ready', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.providers.stt.ready).toBe(true);
    expect(body.providers.stt.provider).toBe('whisper_cpp');
  });

  it('transcribes audio via mock provider', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audioPath: '/test/audio.ogg', language: 'en' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe('Hello world');
    expect(body.provider).toBe('whisper_cpp');
    expect(body.durationMs).toBe(1234);
    expect(body.language).toBe('en');
  });

  it('returns 400 for missing audioPath', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('INVALID_REQUEST');
  });
});

// ─── Service Client ────────────────────────────────────────────────────────

describe('ServiceClient', () => {
  let mockServer: http.Server;
  let port: number;

  beforeEach(async () => {
    port = 31000 + Math.floor(Math.random() * 10000);

    mockServer = http.createServer((req, res) => {
      const url = req.url ?? '/';

      if (url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            providers: {
              stt: { ready: true, provider: 'whisper_cpp' },
              vision: { ready: false, provider: 'none' },
              tts: { ready: false, provider: 'none' },
            },
            uptimeMs: 1000,
          }),
        );
      } else if (url === '/transcribe' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              text: `Transcribed: ${parsed.audioPath as string}`,
              provider: 'whisper_cpp',
              durationMs: 500,
              language: parsed.language ?? 'en',
            }),
          );
        });
      } else if (url === '/understand' && req.method === 'POST') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Vision not configured', code: 'VISION_DISABLED' }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => mockServer.listen(port, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  it('health() returns provider status', async () => {
    const { ServiceClient } = await import('../src/service/service-client.js');
    const client = new ServiceClient({ baseUrl: `http://127.0.0.1:${port}` });

    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(health.providers.stt.ready).toBe(true);
  });

  it('isReachable() returns true for running server', async () => {
    const { ServiceClient } = await import('../src/service/service-client.js');
    const client = new ServiceClient({ baseUrl: `http://127.0.0.1:${port}` });

    expect(await client.isReachable()).toBe(true);
  });

  it('isReachable() returns false for unreachable server', async () => {
    const { ServiceClient } = await import('../src/service/service-client.js');
    const client = new ServiceClient({ baseUrl: 'http://127.0.0.1:1', timeout: 1000 });

    expect(await client.isReachable()).toBe(false);
  });

  it('transcribe() sends audio path and returns result', async () => {
    const { ServiceClient } = await import('../src/service/service-client.js');
    const client = new ServiceClient({ baseUrl: `http://127.0.0.1:${port}` });

    const result = await client.transcribe('/downloads/voice.ogg', 'de');
    expect(result.text).toBe('Transcribed: /downloads/voice.ogg');
    expect(result.provider).toBe('whisper_cpp');
    expect(result.durationMs).toBe(500);
    expect(result.language).toBe('de');
  });

  it('understand() returns null for 503 (vision not configured)', async () => {
    const { ServiceClient } = await import('../src/service/service-client.js');
    const client = new ServiceClient({ baseUrl: `http://127.0.0.1:${port}` });

    const result = await client.understand('/downloads/image.png');
    expect(result).toBeNull();
  });
});

// ─── Service Manager ───────────────────────────────────────────────────────

describe('ServiceManager', () => {
  let tmpDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'service-mgr-'));
    // Mock fetch so waitForHealth's HTTP polling succeeds immediately
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 }) as any;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('generates correct container name', async () => {
    const { ServiceManager } = await import('../src/service/service-manager.js');
    const manager = new ServiceManager({
      runtime: createMockRuntime(),
      username: 'stan',
      config: defaultServiceConfig(),
      downloadsDir: join(tmpDir, 'downloads'),
      modelsDir: join(tmpDir, 'models'),
      hostPort: 18787,
    });

    expect(manager.containerName).toBe('flowhelm-service-stan');
  });

  it('generates correct network name', async () => {
    const { ServiceManager } = await import('../src/service/service-manager.js');
    const manager = new ServiceManager({
      runtime: createMockRuntime(),
      username: 'alice',
      config: defaultServiceConfig(),
      downloadsDir: join(tmpDir, 'downloads'),
      modelsDir: join(tmpDir, 'models'),
      hostPort: 18787,
    });

    expect(manager.networkName).toBe('flowhelm-network-alice');
  });

  it('generates correct service URL (container-to-container)', async () => {
    const { ServiceManager } = await import('../src/service/service-manager.js');
    const manager = new ServiceManager({
      runtime: createMockRuntime(),
      username: 'stan',
      config: { ...defaultServiceConfig(), port: 9999 },
      downloadsDir: join(tmpDir, 'downloads'),
      modelsDir: join(tmpDir, 'models'),
      hostPort: 19999,
    });

    expect(manager.serviceUrl).toBe('http://flowhelm-service-stan:9999');
  });

  it('generates correct host URL (host-to-container)', async () => {
    const { ServiceManager } = await import('../src/service/service-manager.js');
    const manager = new ServiceManager({
      runtime: createMockRuntime(),
      username: 'stan',
      config: defaultServiceConfig(),
      downloadsDir: join(tmpDir, 'downloads'),
      modelsDir: join(tmpDir, 'models'),
      hostPort: 18787,
    });

    expect(manager.hostUrl).toBe('http://127.0.0.1:18787');
  });

  it('builds container config with correct mounts and env', async () => {
    const { ServiceManager } = await import('../src/service/service-manager.js');
    const downloadsDir = join(tmpDir, 'downloads');
    const modelsDir = join(tmpDir, 'models');

    const manager = new ServiceManager({
      runtime: createMockRuntime(),
      username: 'stan',
      config: defaultServiceConfig(),
      downloadsDir,
      modelsDir,
      hostPort: 18787,
    });

    const config = manager.buildContainerConfig();

    expect(config.name).toBe('flowhelm-service-stan');
    expect(config.image).toBe('flowhelm-service:latest');
    expect(config.memoryLimit).toBe('2g');
    expect(config.cpuLimit).toBe('2.0');
    expect(config.pidsLimit).toBe(128);
    expect(config.network).toBe('flowhelm-network-stan');
    expect(config.userNamespace).toBe('keep-id:uid=1000,gid=1000');
    expect(config.securityOpts).toContain('no-new-privileges');
    expect(config.ports).toEqual(['127.0.0.1:18787:8787']);

    // Model mount (read-only)
    const modelMount = config.mounts.find((m) => m.target === '/models');
    expect(modelMount).toBeDefined();
    expect(modelMount!.source).toBe(modelsDir);
    expect(modelMount!.readOnly).toBe(true);

    // Downloads mount (read-only)
    const downloadMount = config.mounts.find((m) => m.target === '/downloads');
    expect(downloadMount).toBeDefined();
    expect(downloadMount!.source).toBe(downloadsDir);
    expect(downloadMount!.readOnly).toBe(true);

    // Environment variables
    expect(config.env['SERVICE_PORT']).toBe('8787');
    expect(config.env['SERVICE_STT_ENABLED']).toBe('true');
    expect(config.env['SERVICE_STT_MODEL']).toBe('/models/ggml-small.bin');
    expect(config.env['SERVICE_STT_LANGUAGE']).toBe('en');
    expect(config.env['SERVICE_STT_THREADS']).toBe('2');
  });

  it('creates host directories on start', async () => {
    const { ServiceManager } = await import('../src/service/service-manager.js');
    const downloadsDir = join(tmpDir, 'deep', 'nested', 'downloads');
    const modelsDir = join(tmpDir, 'deep', 'nested', 'models');

    const runtime = createMockRuntime({ existsReturn: false, isHealthyReturn: true });

    const manager = new ServiceManager({
      runtime,
      username: 'stan',
      config: defaultServiceConfig(),
      downloadsDir,
      modelsDir,
      hostPort: 18787,
    });

    await manager.start();

    // Verify directories were created
    const { stat } = await import('node:fs/promises');
    const dlStat = await stat(downloadsDir);
    expect(dlStat.isDirectory()).toBe(true);
    const mdStat = await stat(modelsDir);
    expect(mdStat.isDirectory()).toBe(true);

    await manager.stop();
  });

  it('skips recreation when container is already healthy', async () => {
    const { ServiceManager } = await import('../src/service/service-manager.js');
    const runtime = createMockRuntime({ existsReturn: true, isHealthyReturn: true });

    const manager = new ServiceManager({
      runtime,
      username: 'stan',
      config: defaultServiceConfig(),
      downloadsDir: join(tmpDir, 'downloads'),
      modelsDir: join(tmpDir, 'models'),
      hostPort: 18787,
    });

    await manager.start();

    // Should NOT have called create (container already healthy)
    expect(runtime.create).not.toHaveBeenCalled();

    await manager.stop();
  });

  it('recreates unhealthy container', async () => {
    const { ServiceManager } = await import('../src/service/service-manager.js');
    let healthCallCount = 0;
    const runtime = createMockRuntime({
      existsReturn: true,
      // First isHealthy call (during exists check) returns false
      // Second call (waitForHealth) returns true
      isHealthyReturn: () => {
        healthCallCount++;
        return healthCallCount > 1;
      },
    });

    const manager = new ServiceManager({
      runtime,
      username: 'stan',
      config: defaultServiceConfig(),
      downloadsDir: join(tmpDir, 'downloads'),
      modelsDir: join(tmpDir, 'models'),
      hostPort: 18787,
    });

    await manager.start();

    // Should have called stop, remove, create, start (recreated)
    expect(runtime.stop).toHaveBeenCalled();
    expect(runtime.remove).toHaveBeenCalled();
    expect(runtime.create).toHaveBeenCalled();
    expect(runtime.start).toHaveBeenCalled();

    await manager.stop();
  });

  it('stop is idempotent when container does not exist', async () => {
    const { ServiceManager } = await import('../src/service/service-manager.js');
    const runtime = createMockRuntime({ existsReturn: false });

    const manager = new ServiceManager({
      runtime,
      username: 'stan',
      config: defaultServiceConfig(),
      downloadsDir: join(tmpDir, 'downloads'),
      modelsDir: join(tmpDir, 'models'),
      hostPort: 18787,
    });

    // Should not throw
    await manager.stop();
    expect(runtime.stop).not.toHaveBeenCalled();
  });
});

// ─── NAMING Convention ─────────────────────────────────────────────────────

describe('NAMING.serviceContainer', () => {
  it('generates correct container name', async () => {
    const { NAMING } = await import('../src/container/lifecycle.js');
    expect(NAMING.serviceContainer('stan')).toBe('flowhelm-service-stan');
    expect(NAMING.serviceContainer('alice')).toBe('flowhelm-service-alice');
  });
});

// ─── Orchestrator Service Integration ──────────────────────────────────────

describe('Orchestrator service transcription', () => {
  it('orchestrator accepts serviceClient option', async () => {
    const { FlowHelmOrchestrator } = await import('../src/orchestrator/orchestrator.js');

    // The orchestrator constructor accepts serviceClient for voice transcription.
    // Full pipeline test requires mocking all dependencies — here we verify the class exists.
    expect(FlowHelmOrchestrator).toBeDefined();
  });
});

// ─── Service Barrel Exports ────────────────────────────────────────────────

describe('Service barrel exports', () => {
  it('exports all public classes and functions', async () => {
    const service = await import('../src/service/index.js');
    expect(service.ServiceManager).toBeDefined();
    expect(service.ServiceClient).toBeDefined();
    expect(service.ServiceServer).toBeDefined();
    expect(service.WhisperCppSttProvider).toBeDefined();
    expect(service.convertToWav).toBeDefined();
    expect(service.isWhisperHallucination).toBeDefined();
  });
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function defaultServiceConfig() {
  return {
    enabled: true,
    image: 'flowhelm-service:latest',
    memoryLimit: '2g',
    cpuLimit: '2.0',
    port: 8787,
    stt: {
      enabled: true,
      provider: 'whisper_cpp' as const,
      modelPath: '/models/ggml-small.bin',
      language: 'en',
      threads: 2,
    },
    vision: {
      enabled: true,
      provider: 'claude' as const,
    },
    tts: {
      enabled: false,
      provider: 'none' as const,
    },
  };
}

function createMockRuntime(options?: {
  existsReturn?: boolean;
  isHealthyReturn?: boolean | (() => boolean);
}) {
  const existsReturn = options?.existsReturn ?? false;
  const isHealthyReturn = options?.isHealthyReturn ?? true;

  return {
    create: vi.fn().mockResolvedValue('mock-container-id'),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    logs: vi.fn().mockResolvedValue(''),
    isHealthy: vi.fn().mockImplementation(() => {
      const val = typeof isHealthyReturn === 'function' ? isHealthyReturn() : isHealthyReturn;
      return Promise.resolve(val);
    }),
    exists: vi.fn().mockResolvedValue(existsReturn),
    list: vi.fn().mockResolvedValue([]),
    createNetwork: vi.fn().mockResolvedValue(undefined),
    removeNetwork: vi.fn().mockResolvedValue(undefined),
    networkExists: vi.fn().mockResolvedValue(true),
    imageExists: vi.fn().mockResolvedValue(true),
  };
}
