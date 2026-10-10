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
