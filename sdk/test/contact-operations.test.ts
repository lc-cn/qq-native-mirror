import { test } from 'node:test';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';
import assert from 'node:assert/strict';
import {
  createContactOperations as createNarrowContactOperations,
  type BuddyMutationPort,
  type ContactProfilePort,
} from '../src/features/contacts/contact-operations.ts';

function createContactOperations(
  services: {
    getBuddyService?: () => BuddyMutationPort;
    getProfileService?: () => ContactProfilePort;
  },
  resolveUid: (id: string) => Promise<string>,
) {
  return createNarrowContactOperations({
    getBuddyService: services.getBuddyService ?? (() => undefined),
    getProfileService: services.getProfileService ?? (() => undefined),
    resolveUid,
    signal: new AbortController().signal,
    awaitAlive: async (value) => value,
  });
}

test('profile normalizes pinned native Map and returns raw profile', async () => {
  const raw = {
    coreInfo: { uid: 'u_uid', uin: '123', nick: '昵称', remark: '备注' },
    baseInfo: {},
  };
  const operations = createContactOperations(
    {
      getProfileService: () => ({
        getCoreAndBaseInfo: (from: string, ids: string[]) => {
          assert.equal(from, 'nodeStore');
          assert.deepEqual(ids, ['u_uid']);
          return new Map([['u_uid', raw]]);
        },
      }),
    },
    async (id) => {
      assert.equal(id, '123');
      return 'u_uid';
    },
  );
  assert.deepEqual(await operations.invokeOperation('getUserProfile', { userId: '123' }), {
    userId: '123',
    uid: 'u_uid',
    nickname: '昵称',
    remark: '备注',
    raw,
  });
});

test('profile rejects absent or mismatched native identities without coercing UIN values', async () => {
  let coercions = 0;
  const valid = { uid: 'u_uid', uin: '123', nick: '昵称', remark: '备注' };
  const malformed = [
    { ...valid, uid: undefined },
    { ...valid, uin: undefined },
    { ...valid, uid: 'u_other' },
    { ...valid, uin: '999' },
    { ...valid, uin: 123 },
    {
      ...valid,
      uin: {
        toString() {
          coercions++;
          return '123';
        },
      },
    },
    Object.assign([], valid),
  ];
  for (const coreInfo of malformed) {
    let reads = 0;
    const operations = createContactOperations(
      {
        getProfileService: () => ({
          getCoreAndBaseInfo() {
            reads++;
            return new Map([['u_uid', { coreInfo }]]);
          },
        }),
      },
      async () => 'u_uid',
    );
    await assert.rejects(
      operations.invokeOperation('getUserProfile', { userId: '123' }),
      /native profile.*(identity|requested user)/i,
    );
    assert.equal(reads, 1, 'invalid identity does not replay the query');
  }
  assert.equal(coercions, 0, 'object UIN is rejected before coercion');
});

test('friend mutations use explicit pinned payloads and void means dispatch only', async () => {
  const calls: unknown[] = [];
  const operations = createContactOperations(
    {
      getBuddyService: () => ({
        setBuddyRemark: (payload: unknown) => {
          calls.push(payload);
        },
        delBuddy: async (payload: unknown) => {
          calls.push(payload);
          return { result: 0 };
        },
      }),
    },
    async () => 'u_uid',
  );
  assert.equal(calls.length, 0);
  await operations.invokeOperation('setFriendRemark', { userId: '123', remark: '' });
  await operations.invokeOperation('deleteFriend', { userId: '123' });
  await operations.invokeOperation('deleteFriend', {
    userId: '123',
    options: { block: true, both: true },
  });
  assert.deepEqual(calls, [
    { uid: 'u_uid', remark: '' },
    { friendUid: 'u_uid', tempBlock: false, tempBothDel: false },
    { friendUid: 'u_uid', tempBlock: true, tempBothDel: true },
  ]);
});

test('invalid requests fail before UID lookup; native errors and profile mismatch propagate', async () => {
  let resolved = 0;
  const operations = createContactOperations({}, async () => {
    resolved++;
    return 'u_uid';
  });
  await assert.rejects(operations.invokeOperation('getUserProfile', { userId: 'bad' }));
  await assert.rejects(operations.invokeOperation('setFriendRemark', { userId: '123', remark: 1 }));
  await assert.rejects(
    operations.invokeOperation('deleteFriend', { userId: '123', options: { block: 'yes' } }),
  );
  assert.equal(resolved, 0);
  for (const result of [{ result: 7 }, {}, null]) {
    const bad = createContactOperations(
      { getBuddyService: () => ({ delBuddy: () => result }) },
      async () => 'u_uid',
    );
    await assert.rejects(bad.invokeOperation('deleteFriend', { userId: '123' }), /failed/);
  }
  for (const profiles of [new Map(), {}, new Map([['u_uid', { coreInfo: { uin: '999' } }]])]) {
    const bad = createContactOperations(
      { getProfileService: () => ({ getCoreAndBaseInfo: () => profiles }) },
      async () => 'u_uid',
    );
    await assert.rejects(bad.invokeOperation('getUserProfile', { userId: '123' }));
  }
  await assert.rejects(operations.invokeOperation('getUserProfile', { userId: '123' }), /missing/);
});

test('friend mutation failures preserve explicit vendor codes and reject nonfinite or malformed codes', async () => {
  for (const [result, code] of [
    [{ result: 7 }, 7],
    [{ result: 'ACCOUNT_OFFLINE' }, 'ACCOUNT_OFFLINE'],
    [{ result: NaN }, 'invalid-result'],
    [{ result: Infinity }, 'invalid-result'],
    [{ result: null }, 'invalid-result'],
    [{}, 'invalid-result'],
  ] as const) {
    const operations = createContactOperations(
      { getBuddyService: () => ({ delBuddy: () => result }) },
      async () => 'u_uid',
    );
    await assert.rejects(operations.invokeOperation('deleteFriend', { userId: '123' }), (error) => {
      assert.equal((error as Error & { code: unknown }).code, code);
      return true;
    });
  }
});

test('closing during input capture prevents even UID lookup', async () => {
  const lifetime = new NativeServiceLifetime();
  let lookupCalls = 0;
  const operations = createNarrowContactOperations({
    signal: lifetime.signal,
    awaitAlive: lifetime.awaitAlive,
    resolveUid: async () => {
      lookupCalls++;
      return 'u_uid';
    },
    getBuddyService: () => ({}),
    getProfileService: () => ({}),
  });
  const payload = {
    userId: '123',
    get remark() {
      lifetime.close();
      return '';
    },
  };
  await assert.rejects(operations.invokeOperation('setFriendRemark', payload), /closed|abort/i);
  assert.equal(lookupCalls, 0);
});

const operationCases = [
  {
    operation: 'getUserProfile',
    method: 'getCoreAndBaseInfo',
    family: 'Profile',
    payload: { userId: '123' },
    args: ['nodeStore', ['u_uid']],
  },
  {
    operation: 'setFriendRemark',
    method: 'setBuddyRemark',
    family: 'Buddy',
    payload: { userId: '123', remark: '' },
    args: [{ uid: 'u_uid', remark: '' }],
  },
  {
    operation: 'deleteFriend',
    method: 'delBuddy',
    family: 'Buddy',
    payload: { userId: '123' },
    args: [{ friendUid: 'u_uid', tempBlock: false, tempBothDel: false }],
  },
] as const;

for (const entry of operationCases) {
  for (const returned of [null, undefined, {}]) {
    test(`${entry.operation}: missing service or method uses fixed error`, async () => {
      const lifetime = new NativeServiceLifetime();
      const operations = createNarrowContactOperations({
        signal: lifetime.signal,
        awaitAlive: lifetime.awaitAlive,
        resolveUid: async () => 'u_uid',
        getBuddyService: () => returned,
        getProfileService: () => returned,
      });
      await assert.rejects(operations.invokeOperation(entry.operation, entry.payload), {
        message: `Native ${entry.family} service is missing ${entry.method}`,
      });
      lifetime.close();
    });
  }
  for (const stage of ['uid', 'service', 'getter', 'call'] as const) {
    test(`${entry.operation}: synchronous close in ${stage} prevents later dispatch`, async () => {
      const lifetime = new NativeServiceLifetime();
      let calls = 0,
        reads = 0,
        gets = 0;
      const service = {};
      Object.defineProperty(service, entry.method, {
        get() {
          reads++;
          if (stage === 'getter') lifetime.close();
          return function (this: unknown, ...args: unknown[]) {
            assert.equal(this, service);
            assert.deepEqual(args, entry.args);
            calls++;
            if (stage === 'call') lifetime.close();
            return undefined;
          };
        },
      });
      const get = () => {
        gets++;
        if (stage === 'service') lifetime.close();
        return service;
      };
      const operations = createNarrowContactOperations({
        signal: lifetime.signal,
        awaitAlive: lifetime.awaitAlive,
        resolveUid: async () => {
          if (stage === 'uid') lifetime.close();
          return 'u_uid';
        },
        getBuddyService: get,
        getProfileService: get,
      });
      await assert.rejects(operations.invokeOperation(entry.operation, entry.payload));
      assert.equal(gets, stage === 'uid' ? 0 : 1);
      assert.equal(reads, stage === 'uid' || stage === 'service' ? 0 : 1);
      assert.equal(calls, stage === 'call' ? 1 : 0);
      await assert.rejects(operations.invokeOperation(entry.operation, entry.payload));
      assert.equal(calls, stage === 'call' ? 1 : 0);
    });
  }
  for (const stage of ['uid', 'service', 'getter', 'call'] as const) {
    test(`${entry.operation}: ${stage} thrown failure keeps original identity without retry`, async () => {
      const lifetime = new NativeServiceLifetime(),
        original = Object.assign(Error('original'), { code: 17 });
      let reads = 0,
        calls = 0;
      const service = {};
      Object.defineProperty(service, entry.method, {
        get() {
          reads++;
          if (stage === 'getter') throw original;
          return function (this: unknown, ...args: unknown[]) {
            assert.equal(this, service);
            assert.deepEqual(args, entry.args);
            calls++;
            throw original;
          };
        },
      });
      const get = () => {
        if (stage === 'service') throw original;
        return service;
      };
      const operations = createNarrowContactOperations({
        signal: lifetime.signal,
        awaitAlive: lifetime.awaitAlive,
        resolveUid: async () => {
          if (stage === 'uid') throw original;
          return 'u_uid';
        },
        getBuddyService: get,
        getProfileService: get,
      });
      await assert.rejects(
        operations.invokeOperation(entry.operation, entry.payload),
        (error) => error === original,
      );
      assert.equal(reads, stage === 'getter' || stage === 'call' ? 1 : 0);
      assert.equal(calls, stage === 'call' ? 1 : 0);
      lifetime.close();
    });
  }
  for (const stage of ['uid', 'native'] as const) {
    test(`${entry.operation}: close rejects pending ${stage} and observes late rejection`, async () => {
      const lifetime = new NativeServiceLifetime();
      let reject!: (error: Error) => void,
        calls = 0;
      const pending = new Promise<never>((_, fail) => {
        reject = fail;
      });
      const service = {
        [entry.method]() {
          calls++;
          return pending;
        },
      };
      const operations = createNarrowContactOperations({
        signal: lifetime.signal,
        awaitAlive: lifetime.awaitAlive,
        resolveUid: () => (stage === 'uid' ? pending : Promise.resolve('u_uid')),
        getBuddyService: () => service,
        getProfileService: () => service,
      });
      const result = assert.rejects(operations.invokeOperation(entry.operation, entry.payload));
      await new Promise<void>((resolve) => setImmediate(resolve));
      lifetime.close();
      await result;
      reject(Error('late native failure'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, stage === 'uid' ? 0 : 1);
    });
  }
}
