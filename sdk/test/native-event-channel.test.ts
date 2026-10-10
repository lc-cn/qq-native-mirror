import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeEventChannel } from '../src/runtime/native-event-channel.ts';
const fixture = () => createNativeEventChannel(new AbortController().signal);
test('callback success cannot hide a subsequent native rejection', async () => {
  const channel = fixture();
  await assert.rejects(
    channel.call(
      'reply',
      (value: number) => value,
      () => {
        channel.dispatch('reply', [42]);
        return Promise.reject(new Error('native rejected'));
      },
    ),
    /native rejected/,
  );
});
test('close interrupts invoke even when callback arrived, and late callbacks are ignored', async () => {
  const channel = fixture();
  let checks = 0;
  const pending = channel.call(
    'reply',
    (value: number) => {
      checks++;
      return value;
    },
    () => new Promise(() => {}),
  );
  channel.dispatch('reply', [42]);
  channel.close();
  await assert.rejects(pending, /Client closed/);
  channel.dispatch('reply', [43]);
  assert.equal(checks, 1);
});
test('synchronous throw after abort has handled stop rejection', async () => {
  const controller = new AbortController();
  const channel = createNativeEventChannel(controller.signal);
  await assert.rejects(
    channel.call(
      'reply',
      (value: number) => value,
      () => {
        controller.abort();
        throw new Error('sync failure');
      },
    ),
    /sync failure/,
  );
});
test('callback deadline interrupts invocation once without replay', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const channel = fixture();
  let calls = 0;
  const rejected = assert.rejects(
    channel.call(
      'reply',
      (value: number) => value,
      () => {
        calls++;
        return new Promise(() => {});
      },
      10,
    ),
    /timed out/,
  );
  context.mock.timers.tick(10);
  await rejected;
  channel.dispatch('reply', [42]);
  assert.equal(calls, 1);
});
test('synchronous callback waits for successful return validation', async () => {
  const channel = fixture();
  assert.equal(
    await channel.call(
      'reply',
      (value: number) => value,
      () => {
        channel.dispatch('reply', [42]);
        return { result: 0 };
      },
      1000,
      (value) => !!value && typeof value === 'object' && 'result' in value && value.result === 0,
    ),
    42,
  );
  await assert.rejects(
    channel.call(
      'reply',
      (value: number) => value,
      () => {
        channel.dispatch('reply', [43]);
        return { result: 7 };
      },
      1000,
      () => false,
    ),
    (error) => error instanceof Error && 'code' in error && error.code === 7,
  );
});

test('request cancellation retires its waiter while sibling calls remain usable', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const channel = fixture();
  const controller = new AbortController();
  const reason = new Error('cancel this read');
  let checks = 0;
  let rejectLate!: (error: unknown) => void;
  const pending = channel.call(
    'cancelled',
    (value: number) => {
      checks++;
      return value;
    },
    () =>
      new Promise((_, reject) => {
        rejectLate = reject;
      }),
    100,
    undefined,
    controller.signal,
  );
  controller.abort(reason);
  channel.dispatch('cancelled', [0]);
  assert.equal(checks, 0);
  await assert.rejects(pending, (error) => error === reason);
  channel.dispatch('cancelled', [1]);
  context.mock.timers.tick(100);
  assert.equal(checks, 0);
  rejectLate(new Error('late native failure'));
  assert.equal(
    await channel.call(
      'sibling',
      (value: number) => value,
      () => {
        channel.dispatch('sibling', [42]);
        return { result: 0 };
      },
    ),
    42,
  );
});

test('pre-aborted request cannot invoke native code', async () => {
  const channel = fixture();
  const reason = new Error('already cancelled');
  let invoked = false;
  await assert.rejects(
    channel.call(
      'reply',
      (value: number) => value,
      () => {
        invoked = true;
      },
      100,
      undefined,
      AbortSignal.abort(reason),
    ),
    (error) => error === reason,
  );
  assert.equal(invoked, false);
});

test('reentrant account abort stops the remainder of an in-flight callback batch', async () => {
  const controller = new AbortController();
  const channel = createNativeEventChannel(controller.signal);
  let siblingChecks = 0;
  const first = channel.call(
    'reply',
    (value: number) => {
      controller.abort();
      return value;
    },
    () => ({ result: 0 }),
  );
  const sibling = channel.call(
    'reply',
    (value: number) => {
      siblingChecks++;
      return value;
    },
    () => ({ result: 0 }),
  );
  const failures = [assert.rejects(first), assert.rejects(sibling)];
  channel.dispatch('reply', [42]);
  await Promise.all(failures);
  assert.equal(siblingChecks, 0);
});

test('cancellation during invocation or projection prevents a success', async () => {
  for (const phase of ['invoke', 'project', 'return']) {
    const channel = fixture();
    const controller = new AbortController();
    const reason = new Error('request retired');
    await assert.rejects(
      channel.call(
        'reply',
        (value: number) => {
          if (phase === 'project') controller.abort(reason);
          return value;
        },
        () => {
          channel.dispatch('reply', [42]);
          if (phase === 'invoke') controller.abort(reason);
          return { result: 0 };
        },
        100,
        () => {
          if (phase === 'return') controller.abort(reason);
          return true;
        },
        controller.signal,
      ),
      (error) => error === reason,
    );
  }
});
