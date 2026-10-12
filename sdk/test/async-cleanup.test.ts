import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithCleanup } from '../src/runtime/cleanup.ts';

test('async cleanup waits for the operation and cleanup before publishing its value', async () => {
  const order: string[] = [];
  let finishOperation!: (value: object) => void;
  let finishCleanup!: () => void;
  const value = {};
  const result = runWithCleanup(
    () => {
      order.push('operation');
      return new Promise<object>((resolve) => {
        finishOperation = resolve;
      });
    },
    () => {
      order.push('cleanup');
      return new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
    },
  );
  let settled = false;
  const observed = result.then((output) => {
    settled = true;
    return output;
  });
  assert.deepEqual(order, ['operation']);
  finishOperation(value);
  await Promise.resolve();
  assert.deepEqual(order, ['operation', 'cleanup']);
  assert.equal(settled, false);
  finishCleanup();
  assert.equal(await observed, value);
  assert.equal(settled, true);
});

test('single operation and cleanup failures retain arbitrary original values', async () => {
  for (const error of [new Error('failure'), undefined, null, 0, 'failure']) {
    let releases = 0;
    for (const asynchronous of [false, true]) {
      const result = runWithCleanup(
        () => {
          if (asynchronous) return Promise.reject(error);
          throw error;
        },
        () => {
          releases++;
        },
      );
      const failure = await result.then(
        () => assert.fail('must reject'),
        (value: unknown) => ({ value }),
      );
      assert.equal(failure.value, error);
    }
    assert.equal(releases, 2);
    for (const asynchronous of [false, true]) {
      const cleanupFailure = await runWithCleanup(
        () => 42,
        () => {
          if (asynchronous) return Promise.reject(error);
          throw error;
        },
      ).then(
        () => assert.fail('must reject'),
        (value: unknown) => ({ value }),
      );
      assert.equal(cleanupFailure.value, error);
    }
  }
});

test('operation failure survives a cleanup rejection, including undefined', async () => {
  for (const primary of [undefined, new Error('installation')]) {
    const cleanup = new Error('staging');
    await assert.rejects(
      runWithCleanup(
        () => Promise.reject(primary),
        () => Promise.reject(cleanup),
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [primary, cleanup]);
        return true;
      },
    );
  }
});

test('outer release runs once after failed inner release and retains every failure', async () => {
  const primary = new Error('installation');
  const staging = new Error('staging');
  const lock = new Error('lock');
  const order: string[] = [];
  await assert.rejects(
    runWithCleanup(
      () =>
        runWithCleanup(
          () => {
            order.push('operation');
            throw primary;
          },
          () => {
            order.push('staging');
            throw staging;
          },
        ),
      () => {
        order.push('lock');
        throw lock;
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[1], lock);
      assert.ok(error.errors[0] instanceof AggregateError);
      assert.deepEqual(error.errors[0].errors, [primary, staging]);
      return true;
    },
  );
  assert.deepEqual(order, ['operation', 'staging', 'lock']);
});
