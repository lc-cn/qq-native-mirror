import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import test from 'node:test';
import { ClientLifecycle } from '../src/runtime/client-lifecycle.ts';
import type { ClientState } from '../src/contracts/client.ts';

function fixture(onState?: (state: ClientState) => void) {
  const events = new EventEmitter();
  const sent: { id: number; method: string }[] = [];
  const forwarded: [string, unknown][] = [];
  const states: ClientState[] = [];
  const worker = Object.assign(events, {
    connected: true,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    send(message: { id: number; method: string }, callback: (error: Error | null) => void) {
      sent.push(message);
      callback(null);
      if (message.method === 'close')
        queueMicrotask(() => {
          events.emit('message', { id: message.id, result: null });
          setImmediate(() => worker.kill());
        });
    },
    kill() {
      worker.connected = false;
      worker.exitCode = 0;
      events.emit('exit', 0, null);
      return true;
    },
  });
  const lifecycle = new ClientLifecycle({
    worker: worker as unknown as ChildProcess,
    timeout: 500,
    emit(event, value) {
      if (event === 'state') {
        states.push(value);
        onState?.(value);
      }
    },
    forward: (event, payload) => {
      forwarded.push([event, payload]);
    },
    exportsUpdated() {},
  });
  return { worker, events, sent, forwarded, states, lifecycle };
}

const malformed: unknown[] = [
  undefined,
  null,
  [],
  {},
  { uin: '123' },
  { uid: 'opaque' },
  { uin: 123, uid: 'opaque' },
  { uin: 'not-decimal', uid: 'opaque' },
  { uin: '123', uid: '   ' },
  { uin: '123', uid: 123 },
  Object.create({ uin: '123', uid: 'opaque' }),
];

test('malformed readiness never publishes online or an account and reports only a fixed stage', async () => {
  const f = fixture();
  try {
    for (const payload of malformed) f.events.emit('message', { event: 'ready', payload });
    assert.equal(f.lifecycle.state, 'idle');
    assert.equal(f.lifecycle.account, undefined);
    assert.deepEqual(f.states, []);
    assert.deepEqual(
      f.forwarded,
      malformed.map(() => ['diagnostic', { stage: 'invalid-worker-ready-account' }]),
    );
    assert.deepEqual(f.sent, []);
  } finally {
    await f.lifecycle.close();
  }
});

test('login validates replies while preserving coalescing and allows explicit recovery without replay', async () => {
  const f = fixture();
  try {
    for (const result of malformed) {
      const first = f.lifecycle.login({ method: 'restore', uin: '123' });
      assert.equal(f.lifecycle.login({ method: 'restore', uin: '123' }), first);
      const rejected = assert.rejects(first, { message: 'Invalid worker login account identity' });
      f.events.emit('message', { id: f.sent.at(-1)!.id, result });
      await rejected;
      assert.equal(f.lifecycle.state, 'idle');
      assert.equal(f.lifecycle.account, undefined);
    }
    assert.equal(f.sent.length, malformed.length);
    const first = f.lifecycle.login();
    const raw = { uin: '000900719925474099312345', uid: ' opaque identifier ' };
    f.events.emit('message', { id: f.sent.at(-1)!.id, result: raw });
    const captured = await first;
    assert.deepEqual(captured, raw);
    assert.notEqual(captured, raw);
    assert.equal(f.lifecycle.state, 'connecting', 'a valid reply does not invent a ready event');
    raw.uid = 'changed';
    assert.equal(captured.uid, ' opaque identifier ');
    assert.equal(f.sent.length, malformed.length + 1);
  } finally {
    await f.lifecycle.close();
  }
});

test('readiness captures only two fields and retains decimal and opaque UID representations', async () => {
  const f = fixture();
  try {
    for (const uin of ['0', '000123', '900719925474099312345']) {
      const raw = { uin, uid: ' opaque UID ' };
      Object.defineProperty(raw, 'unrelated', {
        enumerable: true,
        get: () => assert.fail('unrelated getter'),
      });
      f.events.emit('message', { event: 'ready', payload: raw });
      assert.equal(f.lifecycle.state, 'online');
      assert.deepEqual(f.lifecycle.account, { uin, uid: ' opaque UID ' });
      assert.equal(f.forwarded.at(-1)![1], raw);
      raw.uid = 'changed';
      const copy = f.lifecycle.account!;
      assert.equal(copy.uid, ' opaque UID ');
      Object.assign(copy, { uid: 'snapshot mutation' });
      assert.equal(f.lifecycle.account!.uid, ' opaque UID ');
    }
  } finally {
    await f.lifecycle.close();
  }
});

test('identity accessors are not executed and descriptor failures cannot leak their private detail', async () => {
  const f = fixture();
  let reads = 0;
  const accessor = { uin: '123' };
  Object.defineProperty(accessor, 'uid', {
    get() {
      reads++;
      throw new Error('PRIVATE_DETAIL');
    },
  });
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error('PRIVATE_DETAIL');
      },
    },
  );
  try {
    for (const value of [accessor, hostile]) {
      f.events.emit('message', { event: 'ready', payload: value });
      const login = f.lifecycle.login();
      const rejected = assert.rejects(login, { message: 'Invalid worker login account identity' });
      f.events.emit('message', { id: f.sent.at(-1)!.id, result: value });
      await rejected;
    }
    assert.equal(reads, 0);
    assert.equal(f.lifecycle.account, undefined);
    assert.ok(
      f.forwarded.every(
        ([, value]) => JSON.stringify(value) === '{"stage":"invalid-worker-ready-account"}',
      ),
    );
  } finally {
    await f.lifecycle.close();
  }
});

test('descriptor-triggered close prevents another field read or a ready event', async () => {
  const f = fixture();
  let closing: Promise<void> | undefined;
  const fields: PropertyKey[] = [];
  const payload = new Proxy(
    { uin: '123', uid: 'opaque' },
    {
      getOwnPropertyDescriptor(target, key) {
        fields.push(key);
        closing = f.lifecycle.close();
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  f.events.emit('message', { event: 'ready', payload });
  await closing;
  assert.deepEqual(fields, ['uin']);
  assert.equal(f.lifecycle.state, 'closed');
  assert.equal(f.lifecycle.account, undefined);
  assert.deepEqual(f.forwarded, []);
  assert.equal(f.states.includes('online'), false);
});

test('a completed RPC login reply cannot publish after close before its continuation', async () => {
  const f = fixture();
  const login = f.lifecycle.login();
  const rejected = assert.rejects(login, /closed or replaced during login/);
  let inspected = 0;
  const result = new Proxy(
    { uin: '123', uid: 'opaque' },
    {
      getOwnPropertyDescriptor(target, key) {
        inspected++;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  f.events.emit('message', { id: f.sent.at(-1)!.id, result });
  const close = f.lifecycle.close();
  await rejected;
  await close;
  assert.equal(inspected, 0, 'a retired login does not inspect an already delivered result');
  assert.equal(f.lifecycle.state, 'closed');
  assert.equal(f.lifecycle.account, undefined);
});

test('closing from the online state observer suppresses the following raw ready event', async () => {
  let closing: Promise<void> | undefined;
  const f = fixture((state) => {
    if (state === 'online') closing = f.lifecycle.close();
  });
  f.events.emit('message', { event: 'ready', payload: { uin: '123', uid: 'opaque' } });
  await closing;
  assert.equal(f.lifecycle.state, 'closed');
  assert.equal(f.lifecycle.account, undefined);
  assert.deepEqual(f.forwarded, []);
});

test('invalid later readiness cannot replace the current account or enable implicit restoration', async () => {
  const f = fixture();
  try {
    const account = { uin: '000123', uid: 'opaque' };
    f.events.emit('message', { event: 'ready', payload: account });
    f.events.emit('message', { event: 'ready', payload: { uin: '999' } });
    assert.equal(f.lifecycle.state, 'online');
    assert.deepEqual(f.lifecycle.account, account);
    f.events.emit('message', { event: 'logout', payload: undefined });
    assert.equal(f.lifecycle.account, undefined);
    f.events.emit('message', { event: 'ready', payload: { uid: 'other' } });
    assert.equal(f.lifecycle.state, 'disconnected');
    assert.equal(f.lifecycle.account, undefined);
    assert.deepEqual(f.sent, []);
  } finally {
    await f.lifecycle.close();
  }
});

test('login identity inspection stops at retirement and reports lifecycle failure before malformed data', async () => {
  const f = fixture();
  let closing: Promise<void> | undefined;
  const fields: PropertyKey[] = [];
  const result = new Proxy(
    { uin: '123', uid: 'opaque' },
    {
      getOwnPropertyDescriptor(_target, key) {
        fields.push(key);
        closing = f.lifecycle.close();
        throw new Error('PRIVATE_DESCRIPTOR_FAILURE');
      },
    },
  );
  const login = f.lifecycle.login();
  const rejected = assert.rejects(login, { message: 'QQ client closed or replaced during login' });
  f.events.emit('message', { id: f.sent.at(-1)!.id, result });
  await rejected;
  await closing;
  assert.deepEqual(fields, ['uin']);
  assert.equal(f.lifecycle.state, 'closed');
  assert.equal(f.lifecycle.account, undefined);
});
