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
    emit(event, _payload) {
      events.push(event);
    },
    forward(event, payload) {
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
    emit: (event, _payload) => {
      events.push(event);
    },
    forward: (event) => events.push(event),
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
    forward: (event, payload) => rawEvents.push({ event, payload }),
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

test('SDK state and termination use the typed outlet while unknown worker events retain identity', () => {
  const f = workerFixture();
  const observed: { outlet: string; event: string; payload: unknown }[] = [];
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit: (event, payload) => observed.push({ outlet: 'typed', event, payload }),
    forward: (event, payload) => observed.push({ outlet: 'unknown', event, payload }),
    exportsUpdated() {},
  });
  const opaque = { untouched: true };
  f.events.emit('message', { event: 'vendor-extension', payload: opaque });
  const failure = new Error('controlled worker failure');
  f.events.emit('error', failure);
  assert.deepEqual(
    observed.map(({ outlet, event }) => [outlet, event]),
    [
      ['unknown', 'vendor-extension'],
      ['typed', 'state'],
      ['typed', 'terminated'],
    ],
  );
  assert.equal(observed[0].payload, opaque);
  assert.equal(observed[1].payload, 'failed');
  assert.equal(observed[2].payload, failure);
  assert.equal(lifecycle.state, 'failed');
});

test('automatic reconnect preserves an opaque rejection on the unknown outlet', async () => {
  const f = workerFixture();
  const opaque = { retryable: false, identity: 'opaque-rejection' };
  let settle!: (value: unknown) => void;
  const observed = new Promise<unknown>((resolve) => {
    settle = resolve;
  });
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    restart: {
      spawn() {
        throw opaque;
      },
      payload: {},
    },
    autoReconnect: { delayMs: 1, maxAttempts: 1 },
    emit() {},
    forward(event, payload) {
      if (event === 'reconnect-error') settle(payload);
    },
    exportsUpdated() {},
  });
  const login = lifecycle.login();
  const account = { uin: '123', uid: 'u_fixture' };
  f.events.emit('message', { event: 'ready', payload: account });
  f.events.emit('message', { id: f.sent[0].id, result: account });
  await login;
  f.events.emit('message', { event: 'disconnected', payload: { retryable: true } });
  let timer!: ReturnType<typeof setTimeout>;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture reconnect did not settle')), 1000);
    });
    assert.equal(await Promise.race([observed, deadline]), opaque);
  } finally {
    clearTimeout(timer);
    await lifecycle.close();
  }
});

test('synchronous closing observer receives the same promise until actual worker exit', async () => {
  const f = workerFixture();
  f.worker.send = ((
    message: { id: number; method: string },
    callback: (error: Error | null) => void,
  ) => {
    f.sent.push(message);
    callback(null);
    return true;
  }) as typeof f.worker.send;
  let nested: Promise<void> | undefined;
  const states: unknown[] = [];
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, value) {
      if (event === 'state') {
        states.push(value);
        if (value === 'closing') nested = lifecycle.close();
      }
    },
    forward() {},
    exportsUpdated() {},
  });
  const closing = lifecycle.close();
  assert.equal(nested, closing);
  let settled = false;
  closing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  f.events.emit('message', { id: f.sent[0].id, result: null });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(states, ['closing']);
  assert.equal(f.sent.length, 1);
  Object.assign(f.worker, { exitCode: 0 });
  f.events.emit('exit', 0, null);
  await closing;
  assert.deepEqual(states, ['closing', 'closed']);
  assert.equal(lifecycle.close(), closing);
});
test('reentrant close shares the original cleanup rejection without another attempt', async () => {
  const f = workerFixture();
  const failure = new Error('Controlled cleanup failure');
  let kills = 0;
  f.worker.send = ((_message: unknown, callback: (error: Error | null) => void) => {
    callback(new Error('Controlled close send failure'));
    return true;
  }) as typeof f.worker.send;
  f.worker.kill = () => {
    kills++;
    throw failure;
  };
  let nested: Promise<void> | undefined;
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, value) {
      if (event === 'state' && value === 'closing') nested = lifecycle.close();
    },
    forward() {},
    exportsUpdated() {},
  });
  const closing = lifecycle.close();
  assert.equal(nested, closing);
  await assert.rejects(closing, (error: unknown) => error === failure);
  assert.equal(lifecycle.close(), closing);
  assert.equal(kills, 1);
});

test('connecting observers join the reserved login and wait while another account rejects before IPC', async () => {
  const f = workerFixture();
  let same: Promise<unknown> | undefined;
  let waiting: Promise<unknown> | undefined;
  let different: Promise<unknown> | undefined;
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, state) {
      if (event !== 'state' || state !== 'connecting') return;
      assert.equal(f.sent.length, 0, 'State still precedes login IPC');
      same = lifecycle.login({ method: 'quick', uin: '123' });
      waiting = lifecycle.waitForLogin();
      different = lifecycle.login({ method: 'quick', uin: '456' });
    },
    forward() {},
    exportsUpdated() {},
  });
  const first = lifecycle.login({ method: 'quick', uin: '123' });
  assert.equal(same, first);
  assert.equal(waiting, first);
  await assert.rejects(different!, /different login request/);
  assert.deepEqual(
    f.sent.map((value) => value.method),
    ['login'],
  );
  const account = { uin: '123', uid: 'u_fixture' };
  f.events.emit('message', { id: f.sent[0].id, result: account });
  assert.deepEqual(await first, account);
  await lifecycle.close();
});

test('close in connecting presentation cancels all joined login callers without dispatch', async () => {
  const f = workerFixture();
  let joined: Promise<unknown> | undefined;
  let closing: Promise<void> | undefined;
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, state) {
      if (event === 'state' && state === 'connecting') {
        joined = lifecycle.waitForLogin();
        closing = lifecycle.close();
      }
    },
    forward() {},
    exportsUpdated() {},
  });
  const first = lifecycle.login();
  assert.equal(first, joined);
  await assert.rejects(first, /closed/);
  await closing;
  assert.deepEqual(
    f.sent.map((value) => value.method),
    ['close'],
  );
});

test('connecting observer throw rejects the reserved attempt by identity and permits explicit recovery', async () => {
  const f = workerFixture();
  const original = { failure: 'Opaque observer failure' };
  let shouldThrow = true;
  let joined: Promise<unknown> | undefined;
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, state) {
      if (event === 'state' && state === 'connecting' && shouldThrow) {
        joined = lifecycle.waitForLogin();
        throw original;
      }
    },
    forward() {},
    exportsUpdated() {},
  });
  const first = lifecycle.login();
  assert.equal(joined, first);
  await assert.rejects(first, (error: unknown) => error === original);
  assert.equal(lifecycle.state, 'idle');
  assert.equal(f.sent.length, 0);
  shouldThrow = false;
  const recovered = lifecycle.login();
  assert.notEqual(first, recovered);
  assert.equal(f.sent.length, 1);
  const account = { uin: '123', uid: 'u_fixture' };
  f.events.emit('message', { id: f.sent[0].id, result: account });
  assert.deepEqual(await recovered, account);
  await lifecycle.close();
});

test('synchronous worker login reply settles the already reserved shared promise', async () => {
  const f = workerFixture();
  const account = { uin: '123', uid: 'u_fixture' };
  const originalSend = f.worker.send.bind(f.worker);
  f.worker.send = ((
    message: { id: number; method: string },
    callback: (error: Error | null) => void,
  ) => {
    if (message.method !== 'login') return originalSend(message, callback);
    f.sent.push(message);
    f.events.emit('message', { id: message.id, result: account });
    callback(null);
    return true;
  }) as typeof f.worker.send;
  let joined: Promise<unknown> | undefined;
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, state) {
      if (event === 'state' && state === 'connecting') joined = lifecycle.login();
    },
    forward() {},
    exportsUpdated() {},
  });
  const first = lifecycle.login();
  assert.equal(first, joined);
  assert.deepEqual(await first, account);
  assert.deepEqual(
    f.sent.map((value) => value.method),
    ['login'],
  );
  await lifecycle.close();
});

test('throwing closing observer cannot skip shutdown or settle before actual exit', async () => {
  const f = workerFixture();
  const original = { failure: 'Opaque closing observer' };
  let nested: Promise<void> | undefined;
  const order: string[] = [];
  f.worker.send = ((
    message: { id: number; method: string },
    callback: (error: Error | null) => void,
  ) => {
    order.push(message.method);
    f.sent.push(message);
    callback(null);
    return true;
  }) as typeof f.worker.send;
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, state) {
      if (event === 'state' && state === 'closing') {
        order.push('closing');
        nested = lifecycle.close();
        throw original;
      }
    },
    forward() {},
    exportsUpdated() {},
  });
  const pending = lifecycle.request('listFriends');
  const observedPending = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  const closing = lifecycle.close();
  const observedClose = closing.then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.equal(nested, closing);
  assert.deepEqual(order, ['listFriends', 'closing', 'close']);
  let settled = false;
  void observedClose.then(() => {
    settled = true;
  });
  f.events.emit('message', { id: f.sent[1].id, result: null });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.match(String(await observedPending), /closed/);
  Object.assign(f.worker, { exitCode: 0, connected: false });
  f.events.emit('exit', 0, null);
  assert.equal(await observedClose, original);
  assert.equal(lifecycle.state, 'closed');
  assert.equal(lifecycle.close(), closing);
});

test('closing observer failure retains cleanup failure and never retries shutdown', async () => {
  const f = workerFixture();
  const original = undefined;
  const cleanup = new Error('Controlled worker kill failure');
  let kills = 0;
  f.worker.send = ((_message: unknown, callback: (error: Error | null) => void) => {
    callback(new Error('Controlled close IPC failure'));
    return true;
  }) as typeof f.worker.send;
  f.worker.kill = () => {
    kills++;
    throw cleanup;
  };
  const lifecycle = new ClientLifecycle({
    worker: f.worker,
    timeout: 1000,
    emit(event, state) {
      if (event === 'state' && state === 'closing') throw original;
    },
    forward() {},
    exportsUpdated() {},
  });
  const closing = lifecycle.close();
  await assert.rejects(closing, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [original, cleanup]);
    return true;
  });
  assert.equal(kills, 1);
  assert.equal(lifecycle.state, 'failed');
  assert.equal(lifecycle.close(), closing);
});
