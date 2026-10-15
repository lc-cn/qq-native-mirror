import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { waitWithSignal } from '../src/runtime/abort.ts';
import { runNativeInstallation } from '../src/storage/native-installation-queue.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('abortable wait observes late rejection and detaches its only listener', async () => {
  const controller = new AbortController();
  const work = deferred<string>();
  const reason = Object.freeze({ interrupted: true });
  const waiting = waitWithSignal(work.promise, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  const rejected = assert.rejects(waiting, (error) => error === reason);
  controller.abort(reason);
  await rejected;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  work.reject(new Error('late shared failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('pre-aborted wait observes existing rejected work without adding a listener', async () => {
  const reason = new Error('already cancelled');
  const signal = AbortSignal.abort(reason);
  await assert.rejects(
    waitWithSignal(Promise.reject(new Error('shared failure')), signal),
    (error) => error === reason,
  );
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('completed and failed waits release listeners and preserve their original result', async () => {
  const controller = new AbortController();
  assert.equal(await waitWithSignal(Promise.resolve(42), controller.signal), 42);
  const error = new Error('shared failure');
  await assert.rejects(
    waitWithSignal(Promise.reject(error), controller.signal),
    (value) => value === error,
  );
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort();
});

test('cancelled middle installer cannot release its successors past an active owner', async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  const calls: string[] = [];
  const target = 'queue-middle-cancellation';
  const first = runNativeInstallation(target, async () => {
    calls.push('first');
    started.resolve();
    await release.promise;
    calls.push('first-done');
    return 1;
  });
  await started.promise;
  const controller = new AbortController();
  const reason = new Error('middle cancelled');
  const middle = runNativeInstallation(
    target,
    async () => {
      assert.fail('cancelled task ran');
    },
    controller.signal,
  );
  const rejected = assert.rejects(middle, (error) => error === reason);
  const next = runNativeInstallation(target, async () => {
    calls.push('next');
    return 3;
  });
  controller.abort(reason);
  await rejected;
  assert.deepEqual(calls, ['first']);
  assert.equal(await runNativeInstallation('independent-target', async () => 4), 4);
  assert.deepEqual(calls, ['first']);
  release.resolve();
  assert.deepEqual(await Promise.all([first, next]), [1, 3]);
  assert.deepEqual(calls, ['first', 'first-done', 'next']);
});

test('active installer owns cancellation cleanup before another caller can enter', async () => {
  const controller = new AbortController();
  const started = deferred<void>();
  const cleanupStarted = deferred<void>();
  const cleanupFinished = deferred<void>();
  const never = deferred<void>();
  let settled = false;
  let successorStarted = false;
  const reason = new Error('owner cancelled');
  const first = runNativeInstallation(
    'queue-owner-cleanup',
    async () => {
      started.resolve();
      try {
        await waitWithSignal(never.promise, controller.signal);
      } finally {
        cleanupStarted.resolve();
        await cleanupFinished.promise;
      }
    },
    controller.signal,
  );
  const rejected = assert.rejects(first, (error) => {
    settled = true;
    return error === reason;
  });
  await started.promise;
  const next = runNativeInstallation('queue-owner-cleanup', async () => {
    successorStarted = true;
    return 'next';
  });
  controller.abort(reason);
  await cleanupStarted.promise;
  assert.equal(settled, false);
  assert.equal(successorStarted, false);
  cleanupFinished.resolve();
  await rejected;
  assert.equal(await next, 'next');
  never.resolve();
});

test('pre-cancelled and failed installers never poison subsequent callers', async () => {
  const reason = new Error('cancelled');
  await assert.rejects(
    runNativeInstallation(
      'queue-failure',
      async () => {
        assert.fail('pre-cancelled task ran');
      },
      AbortSignal.abort(reason),
    ),
    (error) => error === reason,
  );
  const failure = new Error('installation failed');
  await assert.rejects(
    runNativeInstallation('queue-failure', async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(await runNativeInstallation('queue-failure', async () => 'recovered'), 'recovered');
});
