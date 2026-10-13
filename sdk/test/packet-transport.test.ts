import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { createPacketTransport, PacketTransportError } from '../src/runtime/packet-transport.ts';
const options = { timeoutMs: 1000, maxResponseBytes: 1024 };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
test('parallel requests retain receiver, capture once and isolate request/response bytes', async () => {
  const first = deferred<unknown>(),
    second = deferred<unknown>();
  const calls: Buffer[] = [];
  let reads = 0;
  const service = {
    get sendSsoCmdReqByContend() {
      reads++;
      return function (this: object, _command: string, bytes: Buffer) {
        assert.equal(this, service);
        calls.push(bytes);
        return calls.length === 1 ? first.promise : second.promise;
      };
    },
  };
  const transport = createPacketTransport(service);
  assert.equal(reads, 0);
  const input = Buffer.from('one');
  const a = transport.request('a', input, options),
    b = transport.request('b', Buffer.from('two'), options);
  input.fill(0);
  assert.equal(calls[0].toString(), 'one');
  assert.equal(reads, 2);
  const bytes = Buffer.from('reply');
  second.resolve({ rspbuffer: bytes });
  const output = await b;
  bytes.fill(0);
  assert.equal(output.toString(), 'reply');
  first.resolve({ rspbuffer: Buffer.from('first') });
  assert.equal((await a).toString(), 'first');
  transport.close();
});
for (const phase of ['method', 'prototype', 'descriptor'] as const)
  test(`${phase} close and throw prioritizes retirement`, async () => {
    let calls = 0;

    const response = new Proxy(
      {},
      {
        getPrototypeOf() {
          if (phase === 'prototype') {
            transport.close();
            throw undefined;
          }
          return Object.prototype;
        },
        getOwnPropertyDescriptor() {
          transport.close();
          throw null;
        },
      },
    );
    const service = {
      get sendSsoCmdReqByContend() {
        if (phase === 'method') {
          transport.close();
          throw new Error('opaque');
        }
        return () => {
          calls++;
          return response;
        };
      },
    };
    const transport = createPacketTransport(service);
    await assert.rejects(
      transport.request('a', Buffer.from('a'), options),
      (error: unknown) =>
        error instanceof PacketTransportError &&
        error.kind === 'canceled' &&
        error.dispatched === (phase !== 'method'),
    );
    assert.equal(calls, phase === 'method' ? 0 : 1);
  });
test('abort releases subscription and observes late rejection without retry', async () => {
  const pending = deferred<unknown>();
  const controller = new AbortController();
  let calls = 0;
  const transport = createPacketTransport({
    sendSsoCmdReqByContend() {
      calls++;
      return pending.promise;
    },
  });
  const result = transport.request('a', Buffer.from('a'), {
    ...options,
    signal: controller.signal,
  });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  await assert.rejects(result, { kind: 'canceled', dispatched: true });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  pending.reject(undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  transport.close();
});
test('timeout retires observation and late native success cannot publish', async () => {
  const pending = deferred<unknown>();
  let calls = 0;
  const transport = createPacketTransport({
    sendSsoCmdReqByContend() {
      calls++;
      return pending.promise;
    },
  });
  await assert.rejects(transport.request('a', Buffer.from('a'), { ...options, timeoutMs: 1 }), {
    kind: 'timeout',
    dispatched: true,
    responseReceived: false,
  });
  pending.resolve({ rspbuffer: Buffer.from('late') });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  transport.close();
});
test('opaque native errors and response accessors use fixed errors', async () => {
  for (const mode of ['throw', 'reject', 'getter', 'large'] as const) {
    let reads = 0;
    const transport = createPacketTransport({
      sendSsoCmdReqByContend() {
        if (mode === 'throw') throw undefined;
        if (mode === 'reject') return Promise.reject(null);
        if (mode === 'getter')
          return {
            get rspbuffer() {
              reads++;
              throw Error();
            },
          };
        return { rspbuffer: Buffer.alloc(1025) };
      },
    });
    await assert.rejects(transport.request('a', Buffer.from('a'), options), {
      kind: mode === 'throw' ? 'dispatch' : mode === 'reject' ? 'rejected' : 'envelope',
    });
    assert.equal(reads, 0);
    transport.close();
  }
});
test('pre-aborted and closed requests never acquire native method', async () => {
  let reads = 0;
  const controller = new AbortController();
  controller.abort();
  const transport = createPacketTransport({
    get sendSsoCmdReqByContend() {
      reads++;
      return () => undefined;
    },
  });
  await assert.rejects(
    transport.request('a', Buffer.from('a'), { ...options, signal: controller.signal }),
    { kind: 'canceled', dispatched: false },
  );
  transport.close();
  await assert.rejects(transport.request('a', Buffer.from('a'), options), { kind: 'canceled' });
  assert.equal(reads, 0);
});
