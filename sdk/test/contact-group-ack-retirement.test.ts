import assert from 'node:assert/strict';
import test from 'node:test';
import { createContactOperations } from '../src/features/contacts/contact-operations.ts';
import { createGroupOperations } from '../src/features/groups/group-operations.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';

function fixture(domain: 'contact' | 'group', result: unknown, life: NativeServiceLifetime) {
  let dispatches = 0;
  if (domain === 'contact') {
    const service = {
      setBuddyRemark(request: { uid: string; remark: string }) {
        assert.equal(this, service);
        assert.deepEqual(request, { uid: 'uid-fixture', remark: 'note' });
        dispatches++;
        return result;
      },
    };
    const owner = createContactOperations({
      signal: life.signal,
      awaitAlive: life.awaitAlive,
      resolveUid: async () => 'uid-fixture',
      getBuddyService: () => service,
      getProfileService: () => {
        throw new Error('mutation acquired Profile');
      },
    });
    return {
      invoke: () => owner.invokeOperation('setFriendRemark', { userId: '123', remark: 'note' }),
      dispatches: () => dispatches,
    };
  }
  const service = {
    modifyGroupName(id: string, name: string, flag: boolean) {
      assert.equal(this, service);
      assert.deepEqual([id, name, flag], ['123', 'name', false]);
      dispatches++;
      return result;
    },
  };
  const owner = createGroupOperations({
    signal: life.signal,
    awaitAlive: life.awaitAlive,
    resolveUid: async () => {
      throw new Error('group name resolved member');
    },
    getGroupService: () => service,
  });
  return {
    invoke: () => owner.invokeOperation('setGroupName', { groupId: '123', name: 'name' }),
    dispatches: () => dispatches,
  };
}
for (const domain of ['contact', 'group'] as const) {
  for (const mode of ['valid', 'invalid', 'throw'] as const) {
    for (const closed of [false, true]) {
      test(`${domain} ACK ${mode} getter ${closed ? 'closes' : 'active'} preserves selected completion`, async () => {
        const life = new NativeServiceLifetime();
        const primary = new Error('controlled native getter failure');
        let reads = 0;
        const result = {
          get result() {
            reads++;
            if (closed) life.close();
            if (mode === 'throw') throw primary;
            return mode === 'valid' ? 0 : 'malformed';
          },
        };
        const f = fixture(domain, result, life);
        try {
          if (closed)
            await assert.rejects(f.invoke(), (error: unknown) => error === life.signal.reason);
          else if (mode === 'throw')
            await assert.rejects(f.invoke(), (error: unknown) => error === primary);
          else if (mode === 'invalid')
            await assert.rejects(
              f.invoke(),
              (error: unknown) =>
                error instanceof Error && 'code' in error && error.code === 'malformed',
            );
          else await f.invoke();
          assert.equal(reads, 1);
          assert.equal(f.dispatches(), 1);
        } finally {
          life.close();
        }
      });
    }
  }
}
for (const mode of ['true', 'false', 'throw'] as const) {
  test(`contact ACK has ${mode} retirement prevents result getter`, async () => {
    const life = new NativeServiceLifetime();
    let has = 0;
    let get = 0;
    const result = new Proxy(
      { result: 0 },
      {
        has(target, key) {
          if (key === 'result') {
            has++;
            life.close();
            if (mode === 'throw') throw new Error('controlled has failure');
            return mode === 'true';
          }
          return Reflect.has(target, key);
        },
        get(target, key, receiver) {
          if (key === 'result') get++;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    const f = fixture('contact', result, life);
    try {
      await assert.rejects(f.invoke(), (error: unknown) => error === life.signal.reason);
      assert.equal(has, 1);
      assert.equal(get, 0);
      assert.equal(f.dispatches(), 1);
    } finally {
      life.close();
    }
  });
}
