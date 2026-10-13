import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

async function startRunner(t: TestContext, fixture: string, args: string[] = []) {
  const directory = await mkdtemp(join(tmpdir(), 'qq-demo-runner-'));
  await copyFile(new URL('../examples/demo.ts', import.meta.url), join(directory, 'demo.ts'));
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, 'keyword-reply.ts'), fixture);
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const runner = spawn(process.execPath, [join(directory, 'demo.ts'), ...args], {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  runner.stdout.setEncoding('utf8').on('data', (value: string) => {
    stdout += value;
  });
  runner.stderr.setEncoding('utf8').on('data', (value: string) => {
    stderr += value;
  });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      runner.once('error', reject);
      runner.once('close', (code, signal) => resolve({ code, signal }));
    },
  );
  // Observe immediately, including if a readiness assertion fails before awaiting termination.
  void result.catch(() => {});
  const deadline = setTimeout(() => runner.kill('SIGKILL'), 12_000);
  t.after(async () => {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
    try {
      await result;
    } finally {
      clearTimeout(deadline);
      await rm(directory, { recursive: true, force: true });
    }
  });
  async function ready(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (stdout.includes('READY\n')) return;
      if (runner.exitCode !== null || runner.signalCode !== null) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Fixture did not become ready: ${stdout}${stderr}`);
  }
  return { runner, result, ready, output: () => ({ stdout, stderr }) };
}

test('demo forwards original arguments and preserves the child exit code', async (t) => {
  const fixture = await startRunner(
    t,
    `console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 23;`,
    ['--help', 'two words', '--reply=x'],
  );
  assert.deepEqual(await fixture.result, { code: 23, signal: null });
  assert.deepEqual(JSON.parse(fixture.output().stdout.trim()), [
    '--help',
    'two words',
    '--reply=x',
  ]);
});

test(
  'demo Ctrl+C sends one IPC stop and waits for graceful child cleanup',
  { skip: process.platform === 'win32' },
  async (t) => {
    const fixture = await startRunner(
      t,
      `
    let stops = 0;
    process.on('disconnect', () => process.exit());
    process.on('message', (message: unknown) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'stop') {
        stops++; console.log('STOP:' + stops);
        setTimeout(() => { console.log('CLEANED'); process.disconnect(); }, 40);
      }
    });
    console.log('READY');
  `,
    );
    await fixture.ready();
    assert.equal(fixture.runner.kill('SIGINT'), true);
    assert.deepEqual(await fixture.result, { code: 130, signal: null });
    assert.match(fixture.output().stdout, /STOP:1\nCLEANED\n/);
    assert.doesNotMatch(fixture.output().stdout, /STOP:2/);
    assert.equal(fixture.output().stderr, '');
  },
);

test(
  'demo bounds a stalled resource load even when the child ignores graceful termination',
  { skip: process.platform === 'win32', timeout: 15_000 },
  async (t) => {
    const fixture = await startRunner(
      t,
      `
    process.on('disconnect', () => process.exit());
    process.on('message', () => console.log('STOP'));
    process.on('SIGTERM', () => console.log('TERM'));
    setInterval(() => {}, 1000);
    console.log('READY');
  `,
    );
    await fixture.ready();
    const started = performance.now();
    assert.equal(fixture.runner.kill('SIGTERM'), true);
    assert.deepEqual(await fixture.result, { code: 143, signal: null });
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 6_500 && elapsed < 11_000, `Termination elapsed ${elapsed}ms`);
    assert.match(fixture.output().stdout, /STOP\nTERM\n/);
    assert.equal(fixture.output().stderr, '');
  },
);
