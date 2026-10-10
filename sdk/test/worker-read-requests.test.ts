import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { WorkerReadRequests } from '../src/runtime/worker-read-requests.ts';

test('one cancelled read settles promptly while a sibling completes and late native rejection is observed', async () => {
  const reads = new WorkerReadRequests();
  let reject!: (error: Error) => void;
  let signal!: AbortSignal;
  const read = reads.run(1, (value) => {
    signal = value;
    return new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
  });
  const failed = assert.rejects(read, /cancelled/);
  const sibling = reads.run(2, () => 42);
  await Promise.resolve();
  reads.cancel(1);
  await failed;
  assert.equal(signal.aborted, true);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  assert.equal(await sibling, 42);
  reject(new Error('late native rejection'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await reads.run(3, () => 43), 43);
  reads.close();
});

test('cancellation before invocation never dispatches; duplicate active IDs cannot replace their controller', async () => {
  const reads = new WorkerReadRequests();
  let calls = 0;
  const first = assert.rejects(
    reads.run(1, () => {
      calls++;
      return new Promise<never>(() => {});
    }),
    /cancelled/,
  );
  await assert.rejects(
    reads.run(1, () => {
      calls++;
    }),
    /already active/,
  );
  reads.cancel(1);
  await first;
  assert.equal(
    calls,
    1,
    'the microtask may run while checking a duplicate, which must never dispatch',
  );
  const second = assert.rejects(
    reads.run(2, () => {
      calls++;
    }),
    /cancelled/,
  );
  reads.cancel(2);
  await second;
  assert.equal(calls, 1);
});

test('old cancelled completion cannot delete a reused request ID; unknown or completed cancellation is inert', async () => {
  const reads = new WorkerReadRequests();
  let resolve!: (value: number) => void;
  const first = assert.rejects(
    reads.run(
      1,
      () =>
        new Promise<number>((done) => {
          resolve = done;
        }),
    ),
    /cancelled/,
  );
  await Promise.resolve();
  reads.cancel(1);
  const second = assert.rejects(
    reads.run(1, () => new Promise<never>(() => {})),
    /cancelled/,
  );
  await first;
  resolve(9);
  await Promise.resolve();
  reads.cancel(1);
  await second;
  reads.cancel(99);
  assert.equal(await reads.run(2, () => 7), 7);
  reads.cancel(2);
  assert.equal(await reads.run(3, () => 8), 8);
});

test('synchronous cancellation and factory failure release listeners and allow independent reads', async () => {
  const reads = new WorkerReadRequests();
  let signal!: AbortSignal;
  await assert.rejects(
    reads.run(1, (value) => {
      signal = value;
      reads.cancel(1);
      return 8;
    }),
    /cancelled/,
  );
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  const error = new Error('factory failed');
  await assert.rejects(
    reads.run(2, (value) => {
      signal = value;
      throw error;
    }),
    (value) => value === error,
  );
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  assert.equal(await reads.run(2, () => 9), 9);
});

test('close detaches all state before reentrant abort listeners and forbids later invocation', async () => {
  const reads = new WorkerReadRequests();
  const signals: AbortSignal[] = [];
  const failed = [1, 2].map((id) =>
    assert.rejects(
      reads.run(id, (signal) => {
        signals.push(signal);
        signal.addEventListener(
          'abort',
          () => {
            reads.close();
            reads.cancel(id);
          },
          { once: true },
        );
        return new Promise<never>(() => {});
      }),
      /closed/,
    ),
  );
  await Promise.resolve();
  reads.close();
  await Promise.all(failed);
  assert.equal(signals.length, 2);
  for (const signal of signals) {
    assert.equal(signal.aborted, true);
    assert.equal(getEventListeners(signal, 'abort').length, 0);
  }
  await assert.rejects(
    reads.run(3, () => assert.fail('closed read must not dispatch')),
    /closed/,
  );
});
