import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { FeatureLifetime } from '../src/runtime/feature-lifetime.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';

test('injected wait remains a plain call without acquiring the feature as its receiver', async () => {
  const life = new FeatureLifetime({
    signal: new AbortController().signal,
    async awaitAlive<T>(this: unknown, value: T | PromiseLike<T>): Promise<T> {
      assert.equal(this, undefined);
      return value;
    },
    closedMessage: 'Feature closed',
  });
  assert.equal(await life.wait('value'), 'value');
  life.close();
});

test('feature wait preserves values and original native failure identity', async () => {
  const account = new NativeServiceLifetime();
  const life = new FeatureLifetime({
    signal: account.signal,
    awaitAlive: account.awaitAlive,
    closedMessage: 'Feature closed',
  });
  const value = {};
  assert.equal(await life.wait(value), value);
  const error = new Error('Native failure');
  await assert.rejects(life.wait(Promise.reject(error)), (received) => received === error);
  life.close();
  account.close();
});

test('account closure retains the account wait error and cannot retire sibling services early', async () => {
  const account = new NativeServiceLifetime();
  const life = new FeatureLifetime({
    signal: account.signal,
    awaitAlive: account.awaitAlive,
    closedMessage: 'Feature closed',
  });
  const pending = life.wait(new Promise<never>(() => {}));
  const stopped = assert.rejects(pending, { message: 'Native services closed during operation' });
  account.close();
  await stopped;
  life.close();
});

test('local closure settles with a legacy wait port, releases listeners and observes late failure', async () => {
  const parent = new AbortController();
  let localSignal!: AbortSignal;
  let rejectLate!: (reason: unknown) => void;
  const native = new Promise<never>((_, reject) => {
    rejectLate = reject;
  });
  const life = new FeatureLifetime({
    signal: parent.signal,
    awaitAlive: async (value, signal) => {
      localSignal = signal!;
      return value;
    },
    closedMessage: 'Feature closed',
  });
  const pending = life.wait(native);
  const stopped = assert.rejects(pending, { message: 'Feature closed' });
  assert.equal(getEventListeners(localSignal, 'abort').length, 1);
  life.close();
  life.close();
  await stopped;
  assert.equal(localSignal.aborted, true);
  assert.equal(getEventListeners(localSignal, 'abort').length, 0);
  assert.equal(parent.signal.aborted, false);
  rejectLate(new Error('Late native failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(life.assertOpen, { message: 'Feature closed' });
});

test('already closed owner observes a rejected argument without acquiring the account wait', async () => {
  let calls = 0;
  const life = new FeatureLifetime({
    signal: new AbortController().signal,
    awaitAlive: async (value) => {
      calls++;
      return value;
    },
    closedMessage: 'Feature closed',
  });
  life.close();
  await assert.rejects(life.wait(Promise.reject(new Error('Late argument'))), /Feature closed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
});

for (const outcome of ['close', 'throw', 'success'] as const)
  test(`account wait ${outcome} releases the local listener and preserves its result`, async () => {
    let signal!: AbortSignal;
    const failure = new Error('Wait port failure');
    const life = new FeatureLifetime({
      signal: new AbortController().signal,
      awaitAlive<T>(value: T | PromiseLike<T>, requestSignal?: AbortSignal): Promise<T> {
        signal = requestSignal!;
        if (outcome === 'throw') throw failure;
        if (outcome === 'close') life.close();
        return Promise.resolve(value);
      },
      closedMessage: 'Feature closed',
    });
    if (outcome === 'success') assert.equal(await life.wait('value'), 'value');
    else
      await assert.rejects(life.wait('value'), (error) =>
        outcome === 'throw' ? error === failure : (error as Error).message === 'Feature closed',
      );
    assert.equal(getEventListeners(signal, 'abort').length, 0);
    life.close();
  });
