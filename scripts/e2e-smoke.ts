#!/usr/bin/env npx tsx
/**
 * E2E smoke test for FlowHelm container runtime on the current platform.
 *
 * Tests real container lifecycle (create, start, exec, logs, stop, remove),
 * networking, volume mounts, and port publishing using whatever runtime
 * detectPlatform() selects.
 *
 * Usage: npx tsx scripts/e2e-smoke.ts
 */

import { createRuntime, detectPlatform } from '../src/container/index.js';
import type { ContainerConfig } from '../src/orchestrator/types.js';

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const SKIP = '\x1b[33mSKIP\x1b[0m';

let passed = 0;
let failed = 0;
let skipped = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ${PASS}  ${name}`);
    passed++;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${FAIL}  ${name}`);
    console.log(`         ${msg.split('\n')[0]}`);
    failed++;
  }
}

function skip(name: string, reason: string): void {
  console.log(`  ${SKIP}  ${name} — ${reason}`);
  skipped++;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('FlowHelm E2E Smoke Test');
  console.log('');

  // ── Platform detection ────────────────────────────────────────────────────
  const platform = detectPlatform();
  console.log(`Platform:  ${platform.os}`);
  console.log(`Runtime:   ${platform.runtime} ${platform.version}`);
  console.log(`Service:   ${platform.serviceManager}`);
  console.log('');

  const runtime = createRuntime();
  const testName = `fh-e2e-smoke-${Date.now()}`;
  const networkName = `fh-e2e-net-${Date.now()}`;

  // ── 1. Image pull ─────────────────────────────────────────────────────────
  console.log('── Image Operations ──');

  await test('pull alpine image', async () => {
    // Use the runtime binary directly to pull
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    await exec(platform.binaryPath, ['pull', 'docker.io/library/alpine:latest'], {
      timeout: 120_000,
    });
  });

  await test('imageExists returns true for alpine', async () => {
    const exists = await runtime.imageExists('docker.io/library/alpine:latest');
    if (!exists) throw new Error('alpine image not found after pull');
  });

  await test('imageExists returns false for nonexistent image', async () => {
    const exists = await runtime.imageExists('nonexistent/image:99.99.99');
    if (exists) throw new Error('nonexistent image should not exist');
  });

  // ── 2. Network operations ─────────────────────────────────────────────────
  console.log('');
  console.log('── Network Operations ──');

  await test('create network', async () => {
    await runtime.createNetwork(networkName);
  });

  await test('networkExists returns true', async () => {
    const exists = await runtime.networkExists(networkName);
    if (!exists) throw new Error('network should exist after creation');
  });

  // ── 3. Container lifecycle ────────────────────────────────────────────────
  console.log('');
  console.log('── Container Lifecycle ──');

  const isApple = platform.runtime === 'apple_container';

  const config: ContainerConfig = {
    name: testName,
    image: 'docker.io/library/alpine:latest',
    memoryLimit: '256m',
    cpuLimit: '1',
    pidsLimit: 256,
    readOnly: false,
    mounts: [],
    tmpfs: [],
    env: { TEST_VAR: 'hello_flowhelm' },
    securityOpts: [],
    command: ['sh', '-c', 'echo "container started" && sleep 300'],
    network: isApple ? '' : networkName,
  };

  let containerId = '';

  await test('create container', async () => {
    containerId = await runtime.create(config);
    if (!containerId) throw new Error('no container ID returned');
  });

  await test('exists returns true after create', async () => {
    const exists = await runtime.exists(testName);
    if (!exists) throw new Error('container should exist after create');
  });

  await test('start container', async () => {
    await runtime.start(containerId);
  });

  await test('isHealthy returns true when running', async () => {
    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 2000));
    const healthy = await runtime.isHealthy(containerId);
    if (!healthy) throw new Error('container should be healthy after start');
  });

  await test('list shows the container', async () => {
    const containers = await runtime.list({ namePrefix: 'fh-e2e-smoke-' });
    const found = containers.find((c) => c.name === testName);
    if (!found) throw new Error(`container ${testName} not found in list`);
    if (found.state !== 'running') throw new Error(`expected running, got ${found.state}`);
  });

  // ── 4. Container operations ───────────────────────────────────────────────
  console.log('');
  console.log('── Container Operations ──');

  await test('exec echo inside container', async () => {
    const result = await runtime.exec(containerId, ['echo', 'hello from exec']);
    if (result.exitCode !== 0) throw new Error(`exec failed: ${result.stderr}`);
    if (!result.stdout.includes('hello from exec')) {
      throw new Error(`unexpected output: ${result.stdout}`);
    }
  });

  await test('exec reads environment variable', async () => {
    const result = await runtime.exec(containerId, ['sh', '-c', 'echo $TEST_VAR']);
    if (!result.stdout.includes('hello_flowhelm')) {
      throw new Error(`env var not found: ${result.stdout}`);
    }
  });

  await test('logs contain startup message', async () => {
    const logs = await runtime.logs(containerId);
    if (!logs.includes('container started')) {
      throw new Error(`expected 'container started' in logs: ${logs.substring(0, 200)}`);
    }
  });

  await test('logs with tail=1', async () => {
    const logs = await runtime.logs(containerId, 1);
    // Should get at least something
    if (typeof logs !== 'string') throw new Error('logs should return a string');
  });

  // ── 5. Volume mount test ──────────────────────────────────────────────────
  console.log('');
  console.log('── Volume Mount ──');

  const mountTestName = `${testName}-mount`;
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const tmpDir = mkdtempSync(join(tmpdir(), 'fh-e2e-'));
  writeFileSync(join(tmpDir, 'test.txt'), 'mount_works');

  const mountConfig: ContainerConfig = {
    name: mountTestName,
    image: 'docker.io/library/alpine:latest',
    memoryLimit: '128m',
    cpuLimit: '0.5',
    pidsLimit: 128,
    readOnly: false,
    mounts: [{ source: tmpDir, target: '/mnt/test', readOnly: true, selinuxLabel: 'Z' }],
    tmpfs: [],
    env: {},
    securityOpts: [],
    command: ['cat', '/mnt/test/test.txt'],
    network: isApple ? '' : networkName,
  };

  await test('volume mount readable inside container', async () => {
    const id = await runtime.create(mountConfig);
    await runtime.start(id);
    // Wait for the command to run and container to exit
    await new Promise((r) => setTimeout(r, 3000));
    const logs = await runtime.logs(id);
    await runtime.remove(id);
    if (!logs.includes('mount_works')) {
      throw new Error(`mount content not found in output: ${logs.substring(0, 200)}`);
    }
  });

  rmSync(tmpDir, { recursive: true, force: true });

  // ── 6. Port publishing test ───────────────────────────────────────────────
  console.log('');
  console.log('── Port Publishing ──');

  const portTestName = `${testName}-port`;
  const portConfig: ContainerConfig = {
    name: portTestName,
    image: 'docker.io/library/alpine:latest',
    memoryLimit: '128m',
    cpuLimit: '0.5',
    pidsLimit: 128,
    readOnly: false,
    mounts: [],
    tmpfs: [],
    env: {},
    securityOpts: [],
    ports: ['18999:8080'],
    command: [
      'sh',
      '-c',
      'while true; do echo -e "HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\n\\r\\nok" | nc -l -p 8080; done',
    ],
    network: isApple ? '' : networkName,
  };

  await test('port forwarding works (host:18999 → container:8080)', async () => {
    const id = await runtime.create(portConfig);
    await runtime.start(id);
    await new Promise((r) => setTimeout(r, 2000));

    try {
      const resp = await fetch('http://localhost:18999', { signal: AbortSignal.timeout(5000) });
      const body = await resp.text();
      if (!body.includes('ok')) {
        throw new Error(`unexpected response: ${body}`);
      }
    } finally {
      await runtime.stop(id, 3);
      await runtime.remove(id);
    }
  });

  // ── 7. Cleanup ────────────────────────────────────────────────────────────
  console.log('');
  console.log('── Cleanup ──');

  await test('stop container', async () => {
    await runtime.stop(containerId, 5);
  });

  await test('isHealthy returns false after stop', async () => {
    const healthy = await runtime.isHealthy(containerId);
    if (healthy) throw new Error('container should not be healthy after stop');
  });

  await test('remove container', async () => {
    await runtime.remove(containerId);
  });

  await test('exists returns false after remove', async () => {
    const exists = await runtime.exists(testName);
    if (exists) throw new Error('container should not exist after remove');
  });

  await test('remove network', async () => {
    await runtime.removeNetwork(networkName);
  });

  await test('networkExists returns false after remove', async () => {
    const exists = await runtime.networkExists(networkName);
    if (exists) throw new Error('network should not exist after remove');
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('');
  console.log(`Result: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
