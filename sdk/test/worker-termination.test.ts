import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { terminateWorker } from '../src/runtime/worker-termination.ts';
function fixture(
  kill?: (signal?: string) => void,
  initial: { exitCode?: number; signalCode?: NodeJS.Signals } = {},
) {
  const events = new EventEmitter();
  const signals: (string | undefined)[] = [];
  const worker = Object.assign(events, {
    exitCode: initial.exitCode ?? null,
    signalCode: initial.signalCode ?? null,
    kill(signal?: string) {
      signals.push(signal);
      kill?.(signal);
      return true;
    },
  });
  return { worker: worker as unknown as ChildProcess, events, signals };
}
const options = {
  forceDelayMs: 10,
  deadlineMs: 20,
  timeoutMessage: 'fixture retirement timed out',
};
test('normal exit removes listener and cancels force/deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const pending = terminateWorker(f.worker, options);
  f.events.emit('exit', 0);
  await pending;
  context.mock.timers.tick(50);
  assert.deepEqual(f.signals, [undefined]);
  assert.equal(f.events.listenerCount('exit'), 0);
});
test('initial synchronous kill failure retains original code and prevents late escalation', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const failure = Object.assign(new Error('initial kill failed'), { code: 'EPERM' });
  const f = fixture(() => {
    throw failure;
  });
  await assert.rejects(terminateWorker(f.worker, options), (error) => error === failure);
  context.mock.timers.tick(50);
  assert.deepEqual(f.signals, [undefined]);
  assert.equal(f.events.listenerCount('exit'), 0);
});
test('force kill failure rejects original value and cleans remaining deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const failure = { code: 'fixture-force-failure' };
  const f = fixture((signal) => {
    if (signal === 'SIGKILL') throw failure;
  });
  const rejected = assert.rejects(terminateWorker(f.worker, options), (error) => error === failure);
  context.mock.timers.tick(10);
  await rejected;
  context.mock.timers.tick(50);
  assert.deepEqual(f.signals, [undefined, 'SIGKILL']);
  assert.equal(f.events.listenerCount('exit'), 0);
});
test('deadline rejects caller message after one SIGKILL and ignores late exit', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const rejected = assert.rejects(
    terminateWorker(f.worker, options),
    /fixture retirement timed out/,
  );
  context.mock.timers.tick(20);
  await rejected;
  f.events.emit('exit', 0);
  context.mock.timers.tick(50);
  assert.deepEqual(f.signals, [undefined, 'SIGKILL']);
  assert.equal(f.events.listenerCount('exit'), 0);
});
test('already exited worker needs no kill or listener', async () => {
  const f = fixture(undefined, { exitCode: 0 });
  await terminateWorker(f.worker, options);
  assert.deepEqual(f.signals, []);
  assert.equal(f.events.listenerCount('exit'), 0);
  const signalled = fixture(undefined, { signalCode: 'SIGTERM' });
  await terminateWorker(signalled.worker);
  assert.deepEqual(signalled.signals, []);
});
test('synchronous exit from initial kill cancels timers installed before dispatch', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(() => f.events.emit('exit', 0));
  await terminateWorker(f.worker, options);
  context.mock.timers.tick(50);
  assert.deepEqual(f.signals, [undefined]);
  assert.equal(f.events.listenerCount('exit'), 0);
});
