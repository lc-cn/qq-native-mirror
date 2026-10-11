import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeServices } from '../src/native-services.ts';
import { cleanupAll, withCleanupFailure } from '../src/runtime/cleanup.ts';

test('cleanup attempts every step and preserves single native failure identity/code', () => {
  const failure = Object.assign(new Error('remove failed'), { code: 7 });
  const calls: string[] = [];
  assert.throws(
    () =>
      cleanupAll([
        () => {
          calls.push('a');
          throw failure;
        },
        () => {
          calls.push('b');
        },
      ]),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ['a', 'b']);
});
test('cleanup aggregates original failures without retry', () => {
  const failures = [new TypeError('first'), Object.assign(new Error('second'), { code: 9 })];
  assert.throws(
    () =>
      cleanupAll(
        failures.map((error) => () => {
          throw error;
        }),
      ),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === failures[0] &&
      error.errors[1] === failures[1],
  );
});
test('buddy removal failure cannot skip group cleanup and repeat close never retries removals', () => {
  const calls: string[] = [];
  const failure = Object.assign(new Error('buddy remove failed'), { code: 7 });
  const services = createNativeServices({
    session: {
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getBuddyService: () => ({
        addKernelBuddyListener() {
          return 1;
        },
        removeKernelBuddyListener() {
          calls.push('buddy');
          throw failure;
        },
      }),
      getGroupService: () => ({
        addKernelGroupListener() {
          return 2;
        },
        removeKernelGroupListener() {
          calls.push('group');
        },
      }),
      getProfileService: () => ({}),
    },
    version: 'fixture',
    events: { emit() {} },
  });
  assert.throws(
    () => services.close(),
    (error) => error === failure,
  );
  services.close();
  assert.deepEqual(calls, ['buddy', 'group']);
});

test('failed construction closes retained Msg callback before any late UID lookup or emission', async () => {
  let listener: Record<string, (...args: unknown[]) => unknown> = {};
  let lookups = 0;
  const events: string[] = [];
  const failure = new Error('group initialization failed');
  assert.throws(
    () =>
      createNativeServices({
        session: {
          getMsgService: () => ({
            addKernelMsgListener(value: typeof listener) {
              listener = value;
            },
          }),
          getGroupService: () => {
            throw failure;
          },
          getUixConvertService: () => ({
            getUin() {
              lookups++;
              return {
                uinInfo: new Map([
                  ['u_peer', '456'],
                  ['u_sender', '789'],
                ]),
              };
            },
          }),
        },
        version: 'fixture',
        events: { emit: (name) => events.push(name) },
      }),
    (error) => error === failure,
  );
  listener.onRecvMsg([
    {
      chatType: 1,
      peerUid: 'u_peer',
      peerUin: '0',
      senderUid: 'u_sender',
      senderUin: '',
      sendNickName: 'fixture',
      msgId: '1',
      msgSeq: '2',
      msgTime: '100',
      elements: [{ elementType: 1, textElement: { atType: 0, content: 'fixture' } }],
    },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lookups, 0);
  assert.deepEqual(events, []);
});
for (const cleanupThrows of [false, true])
  test(`construction unwinds registered Buddy once and retains both failures (${cleanupThrows})`, () => {
    const primary = Object.assign(new Error('group request registration failed'), { code: 13 });
    const cleanup = Object.assign(new Error('buddy removal failed'), { code: 14 });
    let removed = 0;
    let groupAdds = 0;
    assert.throws(
      () =>
        createNativeServices({
          session: {
            getMsgService: () => ({ addKernelMsgListener() {} }),
            getGroupService: () => ({
              addKernelGroupListener() {
                if (++groupAdds === 2) throw primary;
                return 1;
              },
            }),
            getBuddyService: () => ({
              addKernelBuddyListener() {
                return 1;
              },
              removeKernelBuddyListener() {
                removed++;
                if (cleanupThrows) throw cleanup;
              },
            }),
          },
          version: 'fixture',
          events: { emit() {} },
        }),
      (error) =>
        cleanupThrows
          ? error instanceof AggregateError &&
            error.errors[0] === primary &&
            error.errors[1] === cleanup
          : error === primary,
    );
    assert.equal(removed, 1);
    assert.equal(groupAdds, 2);
  });

test('construction keeps non-Error primary value without coercion alongside cleanup failure', () => {
  let coerced = 0;
  const primary = {
    code: 13,
    toString() {
      coerced++;
      return 'must not coerce';
    },
  };
  const cleanup = new Error('remove failed');
  let groupAdds = 0;
  assert.throws(
    () =>
      createNativeServices({
        session: {
          getMsgService: () => ({ addKernelMsgListener() {} }),
          getGroupService: () => ({
            addKernelGroupListener() {
              if (++groupAdds === 2) throw primary;
              return 1;
            },
          }),
          getBuddyService: () => ({
            addKernelBuddyListener() {
              return 1;
            },
            removeKernelBuddyListener() {
              throw cleanup;
            },
          }),
        },
        version: 'fixture',
        events: { emit() {} },
      }),
    (error) =>
      error instanceof AggregateError && error.errors[0] === primary && error.errors[1] === cleanup,
  );
  assert.equal(coerced, 0);
});

test('operation cleanup keeps normal aggregate errors flat without coercing thrown values', () => {
  const first = new Error('first cleanup');
  const second = { code: 7 };
  const failure = withCleanupFailure(undefined, new AggregateError([first, second]));
  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(failure.errors, [undefined, first, second]);
});

test('opaque cleanup inspection cannot replace the primary or execute error accessors', () => {
  const primary = new Error('primary');
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  let reads = 0;
  const accessor = new AggregateError([]);
  Object.defineProperty(accessor, 'errors', {
    get() {
      reads++;
      throw new Error('Do not execute');
    },
  });
  const slots = new AggregateError([]);
  const values: unknown[] = [undefined];
  Object.defineProperty(values, '0', {
    get() {
      reads++;
      throw new Error('Do not execute');
    },
  });
  Object.defineProperty(slots, 'errors', { value: values });
  const descriptor = new Proxy(new AggregateError([]), {
    getOwnPropertyDescriptor() {
      throw new Error('Descriptor inspection failed');
    },
  });
  for (const cleanup of [revoked.proxy, accessor, slots, descriptor]) {
    const failure = withCleanupFailure(primary, cleanup);
    assert.ok(failure instanceof AggregateError);
    assert.equal(failure.errors.length, 2);
    assert.equal(failure.errors[0], primary);
    assert.equal(failure.errors[1], cleanup);
  }
  assert.equal(reads, 0);
});
