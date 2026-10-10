import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deleteGroupFolder,
  type GroupFileContext,
} from '../src/features/groups/group-file-operations.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';
function fixture(response: unknown = { result: 0, groupFileCommonResult: { retCode: 0 } }) {
  const lifetime = new NativeServiceLifetime();
  let acquisitions = 0;
  const calls: string[][] = [];
  const service = {
    deleteGroupFolder(group: string, folder: string) {
      assert.equal(this, service);
      calls.push([group, folder]);
      return response;
    },
  };
  const context: GroupFileContext = {
    signal: lifetime.signal,
    awaitAlive: lifetime.awaitAlive,
    getRichMediaService() {
      acquisitions++;
      return service;
    },
  };
  return { context, lifetime, calls, acquisitions: () => acquisitions };
}
test('preserves full uint64 and folder string, receiver, single dispatch', async () => {
  const f = fixture();
  assert.equal(await deleteGroupFolder(f.context, '18446744073709551615', ' opaque '), undefined);
  assert.deepEqual(f.calls, [['18446744073709551615', ' opaque ']]);
  assert.equal(f.acquisitions(), 1);
  f.lifetime.close();
});
test('invalid inputs fail before service with no coercion', async () => {
  const poison = {
    toString() {
      throw new Error('coercion');
    },
  };
  for (const [g, d] of [
    ['', 'x'],
    ['0', 'x'],
    ['18446744073709551616', 'x'],
    [123, 'x'],
    ['123', ''],
    ['123', null],
    ['123', poison],
  ]) {
    const f = fixture();
    await assert.rejects(deleteGroupFolder(f.context, g, d));
    assert.equal(f.acquisitions(), 0);
    assert.equal(f.calls.length, 0);
    f.lifetime.close();
  }
});
test('two strict status layers, codes preserved but wording excluded', async () => {
  for (const [r, c] of [
    [{ result: -7, errMsg: 'PRIVATE' }, -7],
    [{ result: 0, groupFileCommonResult: { retCode: -9, retMsg: 'PRIVATE' } }, -9],
    [null, 'invalid-result'],
    [{ result: '0' }, 'invalid-result'],
    [{ result: 0 }, 'invalid-result'],
    [{ result: 0, groupFileCommonResult: { retCode: '0' } }, 'invalid-result'],
    [{ result: 0, groupFileCommonResult: { retCode: 0x80000000 } }, 'invalid-result'],
  ] as const) {
    const f = fixture(r);
    await assert.rejects(deleteGroupFolder(f.context, '123', 'x'), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal((e as Error & { code: unknown }).code, c);
      assert.equal(e.message.includes('PRIVATE'), false);
      return true;
    });
    assert.equal(f.calls.length, 1);
    f.lifetime.close();
  }
});
test('does not invoke status getters', async () => {
  let getters = 0;
  const f = fixture({
    result: 0,
    groupFileCommonResult: {
      get retCode() {
        getters++;
        return 0;
      },
    },
  });
  await assert.rejects(deleteGroupFolder(f.context, '123', 'x'));
  assert.equal(getters, 0);
  f.lifetime.close();
});
test('close before dispatch and during stalled completion rejects', async () => {
  const before = fixture();
  before.lifetime.close();
  await assert.rejects(deleteGroupFolder(before.context, '123', 'x'));
  assert.equal(before.acquisitions(), 0);
  let resolve!: (v: unknown) => void;
  const f = fixture(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const p = deleteGroupFolder(f.context, '123', 'x');
  assert.equal(f.calls.length, 1);
  f.lifetime.close();
  await assert.rejects(p);
  resolve({ result: 0, groupFileCommonResult: { retCode: 0 } });
  await Promise.resolve();
  assert.equal(f.calls.length, 1);
});
test('native rejection preserves original error and does not retry', async () => {
  const e = Object.assign(new Error('native rejection'), { code: 'E_NATIVE' });
  const f = fixture(Promise.reject(e));
  await assert.rejects(deleteGroupFolder(f.context, '123', 'x'), (v: unknown) => v === e);
  assert.equal(f.calls.length, 1);
  f.lifetime.close();
});

test('service acquisition reentrant close prevents mutation', async () => {
  const f = fixture();
  f.context.getRichMediaService = () => {
    f.lifetime.close();
    return {
      deleteGroupFolder() {
        throw Error('must not dispatch');
      },
    };
  };
  await assert.rejects(deleteGroupFolder(f.context, '123', 'x'));
  assert.equal(f.calls.length, 0);
});

test('synchronous native throw is preserved without retry', async () => {
  const f = fixture();
  const failure = Object.assign(Error('synthetic failure'), { code: 29 });
  let calls = 0;
  f.context.getRichMediaService = () => ({
    deleteGroupFolder() {
      calls++;
      throw failure;
    },
  });
  await assert.rejects(
    deleteGroupFolder(f.context, '123', 'x'),
    (error: unknown) => error === failure,
  );
  assert.equal(calls, 1);
  f.lifetime.close();
});

test('trapping result descriptors yield fixed invalid-result without native wording', async () => {
  const f = fixture(
    new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw Error('PRIVATE_NATIVE_WORDING');
        },
      },
    ),
  );
  await assert.rejects(deleteGroupFolder(f.context, '123', 'x'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code: unknown }).code, 'invalid-result');
    assert.equal(error.message.includes('PRIVATE_NATIVE_WORDING'), false);
    return true;
  });
  assert.equal(f.calls.length, 1);
  f.lifetime.close();
});

test('native composition obtains RichMedia only for validated folder action', async () => {
  const { createNativeServices } = await import('../src/native-services.ts');
  let gets = 0;
  const calls: unknown[][] = [];
  const service = {
    deleteGroupFolder(...args: unknown[]) {
      calls.push(args);
      return { result: 0, groupFileCommonResult: { retCode: 0 } };
    },
  };
  const services = createNativeServices({
    version: 'fixture',
    events: { emit() {} },
    session: {
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getBuddyService: () => ({
        addKernelBuddyListener() {
          return 1;
        },
        removeKernelBuddyListener() {},
      }),
      getRichMediaService() {
        gets++;
        return service;
      },
    },
  });
  assert.equal(gets, 0);
  await assert.rejects(
    services.invokeOperation('deleteGroupFolder', { groupId: '123', folderId: '' }),
  );
  assert.equal(gets, 0);
  await services.invokeOperation('deleteGroupFolder', { groupId: '123', folderId: 'opaque' });
  assert.deepEqual(calls, [['123', 'opaque']]);
  assert.equal(gets, 1);
  services.close();
  await assert.rejects(
    services.invokeOperation('deleteGroupFolder', { groupId: '123', folderId: 'opaque' }),
  );
  assert.equal(calls.length, 1);
});

test('CLI folder action is captured before client and rejects absent identity', async () => {
  const { prepareCommand, validateCommandFlags } = await import('../src/cli/command-plan.ts');
  const flags = { config: 'fixture', 'group-id': '123', 'folder-id': 'opaque' };
  validateCommandFlags('group-folder-delete', flags);
  const action = await prepareCommand('group-folder-delete', flags);
  flags['folder-id'] = 'changed';
  const calls: unknown[][] = [];
  await action({
    deleteGroupFolder: async (...args: unknown[]) => {
      calls.push(args);
    },
  } as any);
  assert.deepEqual(calls, [['123', 'opaque']]);
  await assert.rejects(prepareCommand('group-folder-delete', { 'group-id': '123' }), /folder-id/);
});
