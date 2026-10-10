import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';

test('retained service methods preserve native receivers and become inert on close', () => {
  const lifetime = new NativeServiceLifetime();
  let calls = 0;
  const service = {
    value: 3,
    send(value: number) {
      assert.equal(this, service);
      calls++;
      return this.value + value;
    },
    removeKernelMsgListener() {
      assert.equal(this, service);
      calls++;
    },
  };
  const session = {
    getMsgService() {
      assert.equal(this, session);
      return service;
    },
  };
  const guarded = lifetime.guardSession(session);
  const retained = guarded.getMsgService();
  const send = retained.send;
  assert.equal(send(4), 7);
  lifetime.close();
  assert.throws(() => send(4), /Native services are closed/);
  assert.throws(() => guarded.getMsgService(), /Native services are closed/);
  retained.removeKernelMsgListener();
  assert.equal(calls, 2);
});

test('a native getter that closes the Session cannot dispatch its retained method', () => {
  const lifetime = new NativeServiceLifetime();
  let dispatched = false;
  const service = lifetime
    .guardSession({
      getMsgService: () => ({
        get send() {
          lifetime.close();
          return () => {
            dispatched = true;
          };
        },
      }),
    })
    .getMsgService();
  assert.throws(() => service.send(), /Native services are closed/);
  assert.equal(dispatched, false);
});

test('closing aborts pending waits before fallible ordered cleanup and never retries', async () => {
  const lifetime = new NativeServiceLifetime();
  const calls: string[] = [];
  const failure = Object.assign(new Error('removal failed'), { code: 7 });
  const waiting = lifetime.awaitAlive(new Promise<never>(() => {}));
  const rejected = assert.rejects(waiting, /Native services closed during operation/);
  lifetime.own({
    close() {
      assert.equal(lifetime.closed, true);
      assert.equal(lifetime.signal.aborted, true);
      lifetime.close();
      calls.push('first');
      throw failure;
    },
  });
  lifetime.defer(() => calls.push('second'));
  assert.throws(
    () => lifetime.close(),
    (error) => error === failure,
  );
  await rejected;
  lifetime.close();
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0);
  assert.throws(() => lifetime.defer(() => {}), /Native services are closed/);
});

test('all cleanup errors keep their identities while remaining resources are released', () => {
  const lifetime = new NativeServiceLifetime();
  const failures = [new Error('first'), { code: 2 }];
  let released = 0;
  for (const failure of failures)
    lifetime.defer(() => {
      throw failure;
    });
  lifetime.defer(() => released++);
  assert.throws(
    () => lifetime.close(),
    (error) =>
      error instanceof AggregateError && error.errors.every((value, i) => value === failures[i]),
  );
  assert.equal(released, 1);
});

test('settlement releases abort subscriptions on both fulfillment and rejection', async () => {
  const lifetime = new NativeServiceLifetime();
  const { awaitAlive } = lifetime;
  assert.equal(await awaitAlive(Promise.resolve(3)), 3);
  assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0);
  const failure = new Error('native failed');
  await assert.rejects(awaitAlive(Promise.reject(failure)), (error) => error === failure);
  assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0);
  lifetime.close();
});

test('close between native fulfillment and continuation suppresses its result', async () => {
  const lifetime = new NativeServiceLifetime();
  const waiting = lifetime.awaitAlive(Promise.resolve('late'));
  const rejected = assert.rejects(waiting);
  lifetime.close();
  await rejected;
});

test('synchronous close and late native rejection are observed without replay', async () => {
  const lifetime = new NativeServiceLifetime();
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_, fail) => {
    reject = fail;
  });
  lifetime.close();
  await assert.rejects(lifetime.awaitAlive(pending));
  reject(new Error('late native error'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0);
});

test('a request signal interrupts only its own wait and observes late native failure', async () => {
  const lifetime = new NativeServiceLifetime();
  const request = new AbortController();
  const reason = new Error('read cancelled');
  let reject!: (error: Error) => void;
  const native = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  const failed = assert.rejects(
    lifetime.awaitAlive(native, request.signal),
    (error) => error === reason,
  );
  const sibling = lifetime.awaitAlive(Promise.resolve(3));
  request.abort(reason);
  await failed;
  assert.equal(await sibling, 3);
  assert.equal(lifetime.closed, false);
  assert.equal(lifetime.signal.aborted, false);
  reject(new Error('late native failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await lifetime.awaitAlive(4), 4);
  lifetime.close();
});

test('a pre-aborted read never publishes a result and still observes its evaluated promise', async () => {
  const lifetime = new NativeServiceLifetime();
  const request = new AbortController();
  const reason = new Error('cancelled before wait');
  request.abort(reason);
  await assert.rejects(
    lifetime.awaitAlive(Promise.reject(new Error('native failure')), request.signal),
    (error) => error === reason,
  );
  assert.equal(await lifetime.awaitAlive(5), 5);
  lifetime.close();
});
