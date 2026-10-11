import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFriendCategoryAssignment,
  type FriendCategoryAssignmentContext,
  type FriendCategoryAssignmentPort,
} from '../../../src/features/contacts/friend-category-assignment.ts';

function fixture(overrides: Partial<FriendCategoryAssignmentContext> = {}) {
  const calls: unknown[][] = [];
  const controller = new AbortController();
  const service: FriendCategoryAssignmentPort = {
    setBuddyCategory(...args) {
      assert.equal(this, service);
      calls.push(args);
      return { result: 0 };
    },
  };
  const owner = createFriendCategoryAssignment({
    signal: controller.signal,
    canAssign: () => true,
    resolveUid: async () => 'u_friend',
    async awaitAlive(value, signal) {
      const pending = Promise.resolve(value);
      // Observe even a value supplied after synchronous cancellation.
      pending.catch(() => {});
      signal.throwIfAborted();
      let abort!: () => void;
      const stopped = new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      });
      try {
        const result = await Promise.race([pending, stopped]);
        signal.throwIfAborted();
        return result;
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
    getBuddyService: () => service,
    ...overrides,
  });
  return { owner, calls, controller, service };
}

test('assignment captures IDs, resolves once and preserves receiver/two arguments/zero and max', async () => {
  const ids: string[] = [];
  const f = fixture({
    resolveUid: async (id) => {
      ids.push(id);
      return 'u_captured';
    },
  });
  await f.owner.assign('123', 0);
  await f.owner.assign('u_explicit', 0xffff_ffff);
  assert.deepEqual(ids, ['123', 'u_explicit']);
  assert.deepEqual(f.calls, [
    ['u_captured', 0],
    ['u_captured', 0xffff_ffff],
  ]);
  f.owner.close();
});

test('invalid and unsupported inputs do not lookup UID or acquire service; gate does not poison later call', async () => {
  let supported = false,
    lookups = 0,
    acquisitions = 0;
  const f = fixture({
    canAssign: () => supported,
    resolveUid: async () => {
      lookups++;
      return 'u_f';
    },
    getBuddyService: () => {
      acquisitions++;
      return { setBuddyCategory: () => ({ result: 0 }) };
    },
  });
  for (const [user, category] of [
    [null, 1],
    ['123', -1],
    ['123', '1'],
    ['0', 1],
  ])
    await assert.rejects(f.owner.assign(user, category));
  await assert.rejects(
    f.owner.assign('123', 1),
    (e: unknown) => e instanceof Error && 'code' in e && e.code === 'unsupported-native-contract',
  );
  assert.equal(lookups, 0);
  assert.equal(acquisitions, 0);
  supported = true;
  await f.owner.assign('123', 1);
  assert.equal(lookups, 1);
  assert.equal(acquisitions, 1);
  f.owner.close();
});

test('UID pending close rejects immediately, observes late rejection and never acquires service', async () => {
  let rejectUid!: (error: unknown) => void,
    acquisitions = 0;
  const f = fixture({
    resolveUid: () =>
      new Promise<string>((_, reject) => {
        rejectUid = reject;
      }),
    getBuddyService: () => {
      acquisitions++;
      return {};
    },
  });
  const pending = f.owner.assign('123', 1);
  f.owner.close();
  await assert.rejects(pending, /closed/);
  rejectUid(new Error('late UID'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(acquisitions, 0);
});

test('capability and native method getter close prevent dispatch; method getter captured once', async () => {
  let calls = 0,
    reads = 0;
  const f = fixture({
    getBuddyService: () => ({
      get setBuddyCategory() {
        reads++;
        f.owner.close();
        return () => {
          calls++;
        };
      },
    }),
  });
  await assert.rejects(f.owner.assign('123', 1), /closed/);
  assert.equal(reads, 1);
  assert.equal(calls, 0);
  const gated = fixture({
    canAssign: () => {
      gated.owner.close();
      return true;
    },
  });
  await assert.rejects(gated.owner.assign('123', 1), /closed/);
  assert.equal(gated.calls.length, 0);
});

test('invalid UID/missing service and method fail before write', async () => {
  for (const uid of ['', '   ']) {
    const f = fixture({ resolveUid: async () => uid });
    await assert.rejects(f.owner.assign('123', 1), /Invalid native friend UID/);
    assert.equal(f.calls.length, 0);
  }
  for (const service of [null, undefined, {}]) {
    const f = fixture({ getBuddyService: () => service });
    await assert.rejects(f.owner.assign('123', 1), /Missing native method setBuddyCategory/);
  }
});

test('ACK rejects nonzero and invalid int32 without sensitive payload or retry; native error identity retained', async () => {
  for (const code of [7, '0', 0x8000_0000, NaN]) {
    let calls = 0;
    const f = fixture({
      getBuddyService: () => ({
        setBuddyCategory() {
          calls++;
          return { result: code, errMsg: 'SECRET' };
        },
      }),
    });
    await assert.rejects(
      f.owner.assign('123', 1),
      (e: unknown) => e instanceof Error && !e.message.includes('SECRET'),
    );
    assert.equal(calls, 1);
    f.owner.close();
  }
  const error = { original: true };
  const f = fixture({
    getBuddyService: () => ({
      setBuddyCategory() {
        throw error;
      },
    }),
  });
  await assert.rejects(f.owner.assign('123', 1), (e: unknown) => e === error);
});

test('postdispatch close is unknown and late rejection observed; receipt projection close cannot succeed', async () => {
  let rejectNative!: (error: unknown) => void;
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = fixture({
    getBuddyService: () => ({
      setBuddyCategory() {
        started();
        return new Promise((_, reject) => {
          rejectNative = reject;
        });
      },
    }),
  });
  const pending = f.owner.assign('123', 1);
  await dispatched;
  f.owner.close();
  await assert.rejects(pending, /assignment; remote effect unknown/);
  rejectNative(new Error('late native'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const projection = fixture({
    getBuddyService: () => ({
      setBuddyCategory: () =>
        new Proxy(
          { result: 0 },
          {
            getOwnPropertyDescriptor(target, key) {
              projection.owner.close();
              return Reflect.getOwnPropertyDescriptor(target, key);
            },
          },
        ),
    }),
  });
  await assert.rejects(projection.owner.assign('123', 1), /remote effect unknown/);
});

test('dispatched never-settling write hits real fixed five-second deadline once', async () => {
  let calls = 0;
  const f = fixture({
    getBuddyService: () => ({
      setBuddyCategory() {
        calls++;
        return new Promise(() => {});
      },
    }),
  });
  const started = performance.now();
  await assert.rejects(
    f.owner.assign('123', 1),
    /Native friend category assignment timed out; remote effect unknown/,
  );
  assert.ok(performance.now() - started >= 4900);
  assert.equal(calls, 1);
  f.owner.close();
});
