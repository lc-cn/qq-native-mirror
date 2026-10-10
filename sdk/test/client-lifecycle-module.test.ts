import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { ClientLifecycle } from '../src/runtime/client-lifecycle.ts';
import { KernelRequestError } from '../src/errors.ts';
function workerFixture() {
  const events = new EventEmitter();
  const sent: { id: number; method: string }[] = [];
  const worker = Object.assign(events, {
    connected: true,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    send(message: { id: number; method: string }, callback: (error: Error | null) => void) {
      sent.push(message);
      callback(null);
      if (message.method === 'close' || message.method === 'init')
        queueMicrotask(() => {
          events.emit('message', {
            id: message.id,
            result: message.method === 'init' ? { exports: ['fixture-export'] } : null,
          });
          if (message.method === 'close')
            setImmediate(() => {
              worker.connected = false;
              worker.exitCode = 0;
              events.emit('exit', 0, null);
            });
        });
    },
    kill() {
      worker.exitCode = 0;
      events.emit('exit', 0, null);
      return true;
    },
  });
  return { worker: worker as unknown as ChildProcess, events, sent };
}
test('module coalesces login promises and owns account state before emitting raw ready', async () => {
  const f = workerFixture();
  const events: string[] = [];
  const lifecycle: ClientLifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, payload) {
      events.push(event);
      if (event === 'ready') assert.deepEqual(lifecycle.account, payload);
    },
    exportsUpdated() {},
  });
  const first = lifecycle.login({ method: 'quick', uin: '123' });
  assert.equal(lifecycle.login({ method: 'quick', uin: '123' }), first);
  await assert.rejects(lifecycle.login({ method: 'quick', uin: '456' }), /different login/);
  const account = { uin: '123', uid: 'u_fixture' };
  f.events.emit('message', { event: 'ready', payload: account });
  f.events.emit('message', { id: f.sent[0].id, result: account });
  await first;
  const snapshot = lifecycle.account!;
  Object.assign(snapshot, { uin: '999' });
  assert.equal(lifecycle.account?.uin, '123');
  assert.deepEqual(events.slice(0, 3), ['state', 'state', 'ready']);
  await lifecycle.close();
});
test('reconnect filters retired-generation events and updates exports without replaying requests', async () => {
  const old = workerFixture(),
    next = workerFixture();
  const exports: string[][] = [];
  const events: string[] = [];
  const lifecycle = new ClientLifecycle({
    worker: old.worker,
    timeout: 1000,
    restart: { spawn: () => next.worker, payload: {} },
    emit: (event) => events.push(event),
    exportsUpdated: (value) => exports.push(value),
  });
  const login = lifecycle.login();
  old.events.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_fixture' } });
  old.events.emit('message', { id: old.sent[0].id, result: { uin: '123', uid: 'u_fixture' } });
  await login;
  const reconnect = lifecycle.reconnect();
  assert.equal(lifecycle.reconnect(), reconnect);
  await new Promise((resolve) => setImmediate(resolve));
  old.events.emit('message', { event: 'ready', payload: { uin: '999', uid: 'u_old' } });
  assert.equal(lifecycle.account, undefined);
  assert.deepEqual(
    next.sent.map((value) => value.method),
    ['init', 'login'],
  );
  next.events.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_fixture' } });
  next.events.emit('message', { id: next.sent[1].id, result: { uin: '123', uid: 'u_fixture' } });
  await reconnect;
  assert.deepEqual(exports, [['fixture-export']]);
  assert.equal(events.filter((value) => value === 'ready').length, 2);
  await lifecycle.close();
});
test('offline settles submitted merged forward as unknown and leaves callback presentation to facade', async () => {
  const f = workerFixture();
  const rawEvents: { event: string; payload: unknown }[] = [];
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit: (event, payload) => rawEvents.push({ event, payload }),
    exportsUpdated() {},
  });
  const raw = { image: 'YmFzZTY0' };
  f.events.emit('message', { event: 'qrcode', payload: raw });
  assert.equal(rawEvents[0].payload, raw);
  assert.equal(raw.image, 'YmFzZTY0');
  const pending = assert.rejects(
    lifecycle.request('sendMergedForward', {}),
    (error) =>
      error instanceof KernelRequestError &&
      error.mergedForward?.uploadCompletion === 'unknown' &&
      error.mergedForward.cardCompletion === 'unknown',
  );
  f.events.emit('message', { event: 'kicked', payload: { retryable: false } });
  await pending;
  assert.equal(lifecycle.state, 'disconnected');
  const close = lifecycle.close();
  assert.equal(lifecycle.close(), close);
  await close;
});
