import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const kernelUrl = new URL('../src/kernel.ts', import.meta.url).href;
const authenticationUrl = new URL('../src/runtime/authentication-attempt.ts', import.meta.url).href;

const childTimeoutMs = 5000;
// These cases test observer failures, not login timeout. The outer watchdog wins
// if resource preparation stalls, rather than producing an unrelated fatal event.
const fixtureLoginTimeoutMs = childTimeoutMs * 2;

/** @param {string} source @param {string} [rejectionMode] */
function runChild(source, rejectionMode = 'throw') {
  const result = spawnSync(
    process.execPath,
    ['--unhandled-rejections=' + rejectionMode, '--input-type=module', '--eval', source],
    {
      encoding: 'utf8',
      timeout: childTimeoutMs,
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

/** @type {[string, string, number][]} */
const observerCases = [
  ['connected', 'throw', 1300],
  ['session-start', 'throw', 0],
  ['connected', 'warn', 0],
];
for (const [phase, rejectionMode, preparationDelay] of observerCases) {
  await test(`${phase} observer failure is fatal with rejection mode ${rejectionMode} after primary settlement`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'qq-background-failure-'));
    try {
      const child = runChild(
        `
        import { createKernel } from ${JSON.stringify(kernelUrl)};
        ${monitor}
        import filesystem from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const originalMkdir = filesystem.mkdir;
        // Exercise preparation slower than the former 1-second login budget.
        // This child owns its module override; no production code is patched.
        let preparationDelayed = false;
        filesystem.mkdir = async (...args) => {
          if (!preparationDelayed) {
            preparationDelayed = true;
            await new Promise(resolve => setTimeout(resolve, ${preparationDelay}));
          }
          return originalMkdir(...args);
        };
        syncBuiltinESMExports();
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
          loginTimeoutMs: ${fixtureLoginTimeoutMs},
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
      request: { method: 'qr' }, timeoutMs: ${fixtureLoginTimeoutMs},
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
