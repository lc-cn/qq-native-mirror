import assert from 'node:assert/strict';
import test from 'node:test';
import { createContactOperations } from '../../../src/features/contacts/contact-operations.ts';
import { NativeServiceLifetime } from '../../../src/runtime/native-service-lifetime.ts';

const fields = ['coreInfo', 'uid', 'uin', 'nick', 'remark'] as const;
for (const selected of fields) {
  for (const mode of ['valid', 'invalid', 'throw'] as const) {
    test(`profile ${selected} ${mode} getter retirement preserves abort and stops projection`, async () => {
      const life = new NativeServiceLifetime();
      const after: string[] = [];
      const reads = new Map<string, number>();
      const core: Record<string, unknown> = {};
      const profile: Record<string, unknown> = {};
      const values = {
        coreInfo: core,
        uid: 'uid-fixture',
        uin: '123',
        nick: 'nickname',
        remark: 'remark',
      };
      for (const key of fields) {
        Object.defineProperty(key === 'coreInfo' ? profile : core, key, {
          enumerable: true,
          get() {
            reads.set(key, (reads.get(key) ?? 0) + 1);
            if (life.closed) after.push(key);
            if (key === selected) {
              life.close();
              if (mode === 'throw') throw new Error('opaque getter failure');
              if (mode === 'invalid') return 42;
            }
            return values[key];
          },
        });
      }
      let nativeCalls = 0;
      const service = {
        getCoreAndBaseInfo(store: string, uids: string[]) {
          assert.equal(this, service);
          assert.equal(store, 'nodeStore');
          assert.deepEqual(uids, ['uid-fixture']);
          nativeCalls++;
          return new Map([['uid-fixture', profile]]);
        },
      };
      const operations = createContactOperations({
        signal: life.signal,
        awaitAlive: life.awaitAlive,
        resolveUid: async () => 'uid-fixture',
        getProfileService: () => service,
        getBuddyService: () => {
          throw new Error('query acquired mutation service');
        },
      });
      try {
        await assert.rejects(
          operations.invokeOperation('getUserProfile', { userId: '123' }),
          (error: unknown) => error === life.signal.reason,
        );
        assert.deepEqual(after, []);
        assert.equal(reads.get(selected), 1);
        assert.equal(nativeCalls, 1);
      } finally {
        life.close();
      }
    });
  }
}

test('valid profile accessors stay single-read and retain the raw carrier', async () => {
  const life = new NativeServiceLifetime();
  const reads: string[] = [];
  const core: Record<string, unknown> = {};
  for (const [key, value] of Object.entries({
    uid: 'uid-fixture',
    uin: '123',
    nick: 'name',
    remark: 'note',
  }))
    Object.defineProperty(core, key, {
      get() {
        reads.push(key);
        return value;
      },
    });
  const profile = {
    get coreInfo() {
      reads.push('coreInfo');
      return core;
    },
  };
  const operations = createContactOperations({
    signal: life.signal,
    awaitAlive: life.awaitAlive,
    resolveUid: async () => 'uid-fixture',
    getBuddyService: () => undefined,
    getProfileService: () => ({ getCoreAndBaseInfo: () => new Map([['uid-fixture', profile]]) }),
  });
  try {
    const result = await operations.invokeOperation('getUserProfile', { userId: '123' });
    assert.ok(result);
    assert.equal(result.raw, profile);
    assert.deepEqual(reads, fields);
    assert.equal(result.nickname, 'name');
    assert.equal(result.remark, 'note');
  } finally {
    life.close();
  }
});

for (const boundary of ['getter', 'lookup'] as const) {
  for (const retire of [false, true]) {
    test(`Map ${boundary} throw ${retire ? 'after retirement' : 'while active'} keeps selected error identity`, async () => {
      const life = new NativeServiceLifetime();
      const primary = new Error('controlled lookup failure');
      const map = new Map<string, unknown>();
      let getterReads = 0;
      let lookupCalls = 0;
      Object.defineProperty(map, 'get', {
        get() {
          getterReads++;
          if (boundary === 'getter') {
            if (retire) life.close();
            throw primary;
          }
          return function (this: Map<string, unknown>, uid: string) {
            assert.equal(this, map);
            assert.equal(uid, 'uid-fixture');
            lookupCalls++;
            if (retire) life.close();
            throw primary;
          };
        },
      });
      const operations = createContactOperations({
        signal: life.signal,
        awaitAlive: life.awaitAlive,
        resolveUid: async () => 'uid-fixture',
        getBuddyService: () => undefined,
        getProfileService: () => ({ getCoreAndBaseInfo: () => map }),
      });
      try {
        await assert.rejects(
          operations.invokeOperation('getUserProfile', { userId: '123' }),
          (error: unknown) => error === (retire ? life.signal.reason : primary),
        );
        assert.equal(getterReads, 1);
        assert.equal(lookupCalls, boundary === 'lookup' ? 1 : 0);
      } finally {
        life.close();
      }
    });
  }
}

test('Map lookup getter close prevents returned function dispatch', async () => {
  const life = new NativeServiceLifetime();
  const map = new Map<string, unknown>();
  let reads = 0;
  let lookups = 0;
  Object.defineProperty(map, 'get', {
    get() {
      reads++;
      life.close();
      return () => {
        lookups++;
        return undefined;
      };
    },
  });
  const operations = createContactOperations({
    signal: life.signal,
    awaitAlive: life.awaitAlive,
    resolveUid: async () => 'uid-fixture',
    getBuddyService: () => undefined,
    getProfileService: () => ({ getCoreAndBaseInfo: () => map }),
  });
  try {
    await assert.rejects(
      operations.invokeOperation('getUserProfile', { userId: '123' }),
      (error: unknown) => error === life.signal.reason,
    );
    assert.equal(reads, 1);
    assert.equal(lookups, 0);
  } finally {
    life.close();
  }
});
