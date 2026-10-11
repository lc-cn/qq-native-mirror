import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Exercise the actual worker entry with a controlled bootstrap and failing IPC
 * sender. This verifies dispatch and exit ownership, not native initialization.
 * @param {{ workerPath: string, bootstrapPath: string }} options
 */
export async function verifyWorkerDelivery({ workerPath, bootstrapPath }) {
  const workerEntry = await realpath(workerPath);
  const bootstrapUrl = pathToFileURL(await realpath(bootstrapPath)).href;
  for (const mode of ['result', 'error', 'close', 'normal-close']) {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'qq-worker-delivery-')));
    /** @type {import('node:child_process').ChildProcess | undefined} */
    let worker;
    /** @type {Promise<{ code: number | null, signal: NodeJS.Signals | null }> | undefined} */
    let finished;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let deadline;
    try {
      const fixture = join(directory, 'bootstrap.mjs');
      const hook = join(directory, 'hook.mjs');
      await writeFile(
        fixture,
        `
let operations = 0, closes = 0, sends = 0, releases = 0;
export function recordSendFailure() { sends++; }
export function createWorkerBootstrap() { return {
  async initialize() { return { exports: [] }; },
  async invokeOperation() {
    operations++;
    if (${JSON.stringify(mode)} === 'error') throw Error('controlled operation failure');
    return { count: operations };
  },
  async close() { closes++; },
  releaseOnExit() {
    console.log(JSON.stringify({ operations, closes, sends, releases: ++releases }));
  },
}; }
`,
      );
      await writeFile(
        hook,
        `
import { registerHooks } from 'node:module';
import { recordSendFailure } from ${JSON.stringify(pathToFileURL(fixture).href)};
const send = process.send;
process.send = function (message, ...args) {
  if (message?.id === 2 && ${JSON.stringify(mode)} !== 'normal-close') {
    recordSendFailure();
    throw Error('controlled reply failure');
  }
  return Reflect.apply(send, this, [message, ...args]);
};
process.on('uncaughtExceptionMonitor', (error, origin) => {
  console.log(JSON.stringify({ fatal: { message: error.message, origin } }));
});
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  return result.url === ${JSON.stringify(bootstrapUrl)}
    ? { url: ${JSON.stringify(pathToFileURL(fixture).href)}, shortCircuit: true }
    : result;
} });
`,
      );
      worker = fork(workerEntry, [], {
        cwd: directory,
        execArgv: ['--unhandled-rejections=warn', '--import', pathToFileURL(hook).href],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        serialization: 'advanced',
      });
      const processHandle = worker;
      let stdout = '';
      worker.stdout?.setEncoding('utf8');
      worker.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      worker.stderr?.resume();
      finished = new Promise((resolve) => {
        processHandle.once('close', (code, signal) => resolve({ code, signal }));
      });
      deadline = setTimeout(() => {
        processHandle.kill('SIGKILL');
      }, 5000);
      /** @type {unknown[]} */
      const replies = [];
      const initialized = new Promise((resolve) => {
        processHandle.on('message', (message) => {
          replies.push(message);
          if (message && typeof message === 'object' && 'id' in message && message.id === 1)
            resolve(message);
        });
      });
      worker.send({ id: 1, method: 'init', options: {} });
      const initialization = await Promise.race([
        initialized,
        finished.then(() => {
          throw Error('Worker exited before initialization');
        }),
      ]);
      assert.deepEqual(initialization, { id: 1, result: { exports: [] } });
      worker.send({ id: 2, method: mode.includes('close') ? 'close' : 'getGroupInfo' });
      const exit = await finished;
      clearTimeout(deadline);
      assert.equal(exit.signal, null, `Worker must exit itself after ${mode} delivery`);
      assert.equal(exit.code, mode === 'normal-close' ? 0 : 1);
      const output = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const closing = mode.includes('close');
      assert.deepEqual(output.at(-1), {
        operations: closing ? 0 : 1,
        closes: closing ? 1 : 0,
        sends: mode === 'normal-close' ? 0 : 1,
        releases: 1,
      });
      if (mode === 'normal-close') {
        assert.equal(output.length, 1);
        assert.deepEqual(replies, [initialization, { id: 2, result: null }]);
      } else {
        assert.deepEqual(output[0], {
          fatal: { message: 'controlled reply failure', origin: 'uncaughtException' },
        });
        assert.equal(output.length, 2);
        assert.deepEqual(replies, [initialization]);
      }
    } finally {
      clearTimeout(deadline);
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        worker.kill('SIGKILL');
        await finished;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
  return {
    workerReplySingleAttemptContract: true,
    workerReplyFailureFatalContract: true,
    workerCloseReplyExitContract: true,
    workerExitReleaseHookContract: true,
    nativeExecuted: false,
    accountUsed: false,
  };
}
