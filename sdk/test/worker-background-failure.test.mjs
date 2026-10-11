import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const kernelUrl = new URL('../src/kernel.ts', import.meta.url).href;
const authenticationUrl = new URL('../src/runtime/authentication-attempt.ts', import.meta.url).href;

/** @param {string} source @param {string} [rejectionMode] */
function runChild(source, rejectionMode = 'throw') {
  const result = spawnSync(
    process.execPath,
    ['--unhandled-rejections=' + rejectionMode, '--input-type=module', '--eval', source],
    {
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

// Monitoring preserves Node's default fatal behavior. Catching uncaughtException
// here would make a worker that survives the failure appear to pass.
const monitor = `
  let primary;
  let dispatches = 0;
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    console.log(JSON.stringify({ origin, message: error.message, primary, dispatches }));
  });
`;

for (const [phase, rejectionMode] of [
  ['connected', 'throw'],
  ['session-start', 'throw'],
  ['connected', 'warn'],
]) {
  await test(`${phase} observer failure is fatal with rejection mode ${rejectionMode} after primary settlement`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'qq-background-failure-'));
    try {
      const child = runChild(
        `
        import { createKernel } from ${JSON.stringify(kernelUrl)};
        ${monitor}
        let listener;
        const session = {
          init(_config, _depends, _dispatcher, callback) {
            callback.onOpentelemetryInit({ is_init: true });
          },
          startNT() { dispatches++; throw Error('primary failure'); },
        };
        const kernel = createKernel({
          NodeIQQNTWrapperEngine: { get: () => ({ initWithDeskTopConfig() {} }) },
          NodeIQQNTWrapperSession: { create: () => session },
          NodeIKernelLoginService: { get: () => ({
            initConfig() {},
            addKernelLoginListener(value) { listener = value; },
            connect() { listener.onLoginConnected(); },
            getMsfStatus() {
              if (${JSON.stringify(phase)} === 'connected') {
                dispatches++; throw Error('primary failure');
              }
              return 0;
            },
            getQRCodePicture() {
              listener.onQRCodeLoginSucceed({ uin: '123', uid: 'u_fixture' });
              return true;
            },
            getMachineGuid: () => '0123456789abcdef0123456789abcdef',
          }) },
        }, {
          dataDir: ${JSON.stringify(dataDir)},
          loginTimeoutMs: 1000,
          version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' },
        }, (event) => {
          if (event === 'login-error') throw Error('observer failure');
        });
        await kernel.login({ method: 'qr' }).catch(error => { primary = error.message; });
      `,
        rejectionMode,
      );
      assert.equal(child.status, 1);
      assert.deepEqual(JSON.parse(child.stdout.trim()), {
        origin: 'uncaughtException',
        message: 'observer failure',
        primary: 'primary failure',
        dispatches: 1,
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
}

await test('authentication poll owns a secondary rejection without replaying the native call', () => {
  const child = runChild(`
    import { AuthenticationAttempt } from ${JSON.stringify(authenticationUrl)};
    ${monitor}
    let attempt;
    attempt = new AuthenticationAttempt({
      request: { method: 'qr' }, timeoutMs: 1500,
      prepare: async () => {}, isCurrent: () => true, notify() {},
      loginService: () => ({ getMsfStatus() {
        dispatches++;
        if (dispatches === 1) return 3;
        throw Error('primary failure');
      } }),
      failed(error) { attempt.reject(error); throw Error('observer failure'); },
    });
    attempt.result.catch(error => { primary = error.message; });
    await attempt.onConnected();
  `);
  assert.equal(child.status, 1);
  assert.deepEqual(JSON.parse(child.stdout.trim()), {
    origin: 'uncaughtException',
    message: 'observer failure',
    primary: 'primary failure',
    dispatches: 2,
  });
});
