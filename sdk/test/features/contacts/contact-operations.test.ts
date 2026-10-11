import { test } from 'node:test';
import { NativeServiceLifetime } from '../../../src/runtime/native-service-lifetime.ts';
import assert from 'node:assert/strict';
import {
  createContactOperations as createNarrowContactOperations,
  type BuddyMutationPort,
  type ContactProfilePort,
} from '../../../src/features/contacts/contact-operations.ts';

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

for (const mode of ['changing', 'abort', 'pending-mutation'] as const) {
  test(`deleteFriend captures options once: ${mode}`, async () => {
    const lifetime = new NativeServiceLifetime();
    const reads = { options: 0, block: 0, both: 0 };
    let lookups = 0;
    const calls: unknown[] = [];
    let finish!: (uid: string) => void;
    const uid = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const options = {
      get block() {
        reads.block++;
        return mode === 'pending-mutation' || reads.block === 1 ? true : 'malicious';
      },
      get both() {
        reads.both++;
        return mode === 'pending-mutation' || reads.both === 1 ? false : 'malicious';
      },
    };
    const payload: Record<string, unknown> = {
      userId: '123',
      get options() {
        reads.options++;
        if (mode === 'abort') lifetime.close();
        return options;
      },
    };
    const operations = createNarrowContactOperations({
      signal: lifetime.signal,
      awaitAlive: lifetime.awaitAlive,
      resolveUid: () => {
        lookups++;
        return mode === 'pending-mutation' ? uid : Promise.resolve('u_uid');
      },
      getBuddyService: () => ({
        delBuddy(request) {
          calls.push(request);
        },
      }),
      getProfileService: () => ({}),
    });
    try {
      const pending = operations.invokeOperation('deleteFriend', payload);
      if (mode === 'abort') {
        await assert.rejects(pending, /closed|abort/i);
        assert.equal(lookups, 0);
        assert.equal(calls.length, 0);
      } else {
        if (mode === 'pending-mutation') {
          Object.defineProperty(payload, 'options', { value: { block: false, both: true } });
          payload.userId = '999';
          finish('u_uid');
        }
        await pending;
        assert.deepEqual(calls, [{ friendUid: 'u_uid', tempBlock: true, tempBothDel: false }]);
        assert.equal(lookups, 1);
      }
      assert.equal(reads.options, 1);
      if (mode !== 'abort') assert.deepEqual(reads, { options: 1, block: 1, both: 1 });
    } finally {
      lifetime.close();
      finish('u_uid');
    }
  });
}

test('profile captures coreInfo once and projects the validated object', async () => {
  let reads = 0;
  const raw = {
    get coreInfo() {
      return ++reads === 1
        ? { uid: 'u_uid', uin: '123', nick: 'captured', remark: 'remark' }
        : { uid: 'u_wrong', uin: '999', nick: 'unvalidated', remark: 'wrong' };
    },
  };
  const operations = createContactOperations(
    {
      getProfileService: () => ({
        getCoreAndBaseInfo: () => new Map([['u_uid', raw]]),
      }),
    },
    async () => 'u_uid',
  );
  assert.deepEqual(await operations.invokeOperation('getUserProfile', { userId: '123' }), {
    uid: 'u_uid',
    userId: '123',
    nickname: 'captured',
    remark: 'remark',
    raw,
  });
  assert.equal(reads, 1);
});

for (const stage of ['map', 'identity', 'nickname'] as const) {
  for (const effect of ['close', 'throw'] as const) {
    test(`profile ${stage} ${effect} cannot publish or replay`, async () => {
      const lifetime = new NativeServiceLifetime();
      const original = Error('original getter failure');
      let calls = 0,
        reads = 0;
      const trigger = () => {
        reads++;
        if (effect === 'throw') throw original;
        lifetime.close();
      };
      const core = {
        get uid() {
          if (stage === 'identity') trigger();
          return 'u_uid';
        },
        uin: '123',
        get nick() {
          if (stage === 'nickname') trigger();
          return 'nickname';
        },
        remark: '',
      };
      const raw = { coreInfo: core };
      const profiles = new Map([['u_uid', raw]]);
      profiles.get = (key) => {
        if (stage === 'map') trigger();
        return Map.prototype.get.call(profiles, key);
      };
      const operations = createNarrowContactOperations({
        signal: lifetime.signal,
        awaitAlive: lifetime.awaitAlive,
        resolveUid: async () => 'u_uid',
        getBuddyService: () => ({}),
        getProfileService: () => ({
          getCoreAndBaseInfo() {
            calls++;
            return profiles;
          },
        }),
      });
      try {
        await assert.rejects(
          operations.invokeOperation('getUserProfile', { userId: '123' }),
          effect === 'throw' ? (error) => error === original : /closed|abort/i,
        );
        assert.equal(calls, 1);
        assert.equal(reads, 1);
      } finally {
        lifetime.close();
      }
    });
  }
}

for (const mode of ['failure', 'abort', 'throw'] as const) {
  test(`contact ACK captures result once: ${mode}`, async () => {
    const lifetime = new NativeServiceLifetime();
    const original = Error('ACK getter original');
    let reads = 0,
      calls = 0;
    const result = {
      get result() {
        reads++;
        if (mode === 'throw') throw original;
        if (mode === 'abort') {
          lifetime.close();
          return 0;
        }
        return reads === 1 ? 7 : 0;
      },
    };
    const operations = createNarrowContactOperations({
      signal: lifetime.signal,
      awaitAlive: lifetime.awaitAlive,
      resolveUid: async () => 'u_uid',
      getProfileService: () => ({}),
      getBuddyService: () => ({
        delBuddy() {
          calls++;
          return result;
        },
      }),
    });
    try {
      await assert.rejects(
        operations.invokeOperation('deleteFriend', { userId: '123' }),
        mode === 'throw'
          ? (error) => error === original
          : mode === 'abort'
            ? /closed|abort/i
            : { code: 7 },
      );
      assert.equal(reads, 1);
      assert.equal(calls, 1);
    } finally {
      lifetime.close();
    }
  });
}

for (const mode of ['close', 'throw', 'valid'] as const) {
  test(`profile Map method getter ${mode} is captured before lookup`, async () => {
    const lifetime = new NativeServiceLifetime();
    const original = Error('Map method getter original');
    const raw = { coreInfo: { uid: 'u_uid', uin: '123', nick: 'captured', remark: '' } };
    const profiles = new Map([['u_uid', raw]]);
    let getterReads = 0,
      lookupCalls = 0,
      nativeCalls = 0;
    Object.defineProperty(profiles, 'get', {
      get() {
        getterReads++;
        if (mode === 'throw') throw original;
        if (mode === 'close') lifetime.close();
        return function (this: typeof profiles, key: string) {
          assert.equal(this, profiles);
          assert.equal(key, 'u_uid');
          lookupCalls++;
          return Map.prototype.get.call(this, key);
        };
      },
    });
    const operations = createNarrowContactOperations({
      signal: lifetime.signal,
      awaitAlive: lifetime.awaitAlive,
      resolveUid: async () => 'u_uid',
      getBuddyService: () => ({}),
      getProfileService: () => ({
        getCoreAndBaseInfo() {
          nativeCalls++;
          return profiles;
        },
      }),
    });
    try {
      const pending = operations.invokeOperation('getUserProfile', { userId: '123' });
      if (mode === 'valid') {
        assert.deepEqual(await pending, {
          userId: '123',
          uid: 'u_uid',
          nickname: 'captured',
          remark: '',
          raw,
        });
      } else {
        await assert.rejects(
          pending,
          mode === 'throw' ? (error) => error === original : /closed|abort/i,
        );
      }
      assert.equal(getterReads, 1);
      assert.equal(lookupCalls, mode === 'valid' ? 1 : 0);
      assert.equal(nativeCalls, 1);
    } finally {
      lifetime.close();
    }
  });
}
