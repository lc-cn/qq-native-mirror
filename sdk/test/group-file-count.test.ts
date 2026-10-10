import assert from 'node:assert/strict';
import test from 'node:test';
import { getGroupFileCount } from '../src/features/groups/group-file-operations.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';
function fixture(response: unknown = { result: 0, groupCodes: ['123'], groupFileCounts: [0] }) {
  const lifetime = new NativeServiceLifetime();
  const calls: string[][] = [];
  let gets = 0;
  const service = {
    batchGetGroupFileCount(groups: string[]) {
      assert.equal(this, service);
      calls.push(groups);
      return response;
    },
  };
  const context = {
    signal: lifetime.signal,
    awaitAlive: lifetime.awaitAlive,
    getRichMediaService() {
      gets++;
      return service;
    },
  };
  return { context, lifetime, calls, gets: () => gets };
}
test('single count preserves original uint64 request and compares canonical numeric namespace', async () => {
  const f = fixture({
    result: 0,
    groupCodes: ['18446744073709551615'],
    groupFileCounts: [4294967295],
  });
  assert.equal(await getGroupFileCount(f.context, '018446744073709551615'), 4294967295);
  assert.deepEqual(f.calls, [['018446744073709551615']]);
  f.lifetime.close();
});
test('invalid input acquires no service; malformed whole response never yields count', async () => {
  for (const id of [
    '',
    0,
    '0',
    '18446744073709551616',
    null,
    {
      toString() {
        assert.fail('coercion');
      },
    },
  ]) {
    const f = fixture();
    await assert.rejects(getGroupFileCount(f.context, id));
    assert.equal(f.gets(), 0);
    f.lifetime.close();
  }
  const sparse = Array(1);
  let gets = 0;
  const accessor = Object.defineProperty([0], '0', {
    get() {
      gets++;
      return 0;
    },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const response of [
    revoked.proxy,
    { result: '0' },
    { result: 0, groupCodes: ['123'], groupFileCounts: sparse },
    { result: 0, groupCodes: ['123'], groupFileCounts: accessor },
    ...['124', '0', 123, '18446744073709551616'].map((group) => ({
      result: 0,
      groupCodes: [group],
      groupFileCounts: [1],
    })),
    ...[NaN, -1, 1.1, 4294967296, '1'].map((count) => ({
      result: 0,
      groupCodes: ['123'],
      groupFileCounts: [count],
    })),
    { result: 0, groupCodes: ['123', '124'], groupFileCounts: [1, 2] },
  ]) {
    const f = fixture(response);
    await assert.rejects(getGroupFileCount(f.context, '123'), (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.equal((e as Error & { code: unknown }).code, 'invalid-result');
      return true;
    });
    assert.equal(f.calls.length, 1);
    f.lifetime.close();
  }
  assert.equal(gets, 0);
});
test('native status has precedence with fixed wording, no retries', async () => {
  const f = fixture({ result: -9, errMsg: 'PRIVATE', groupCodes: [] });
  await assert.rejects(getGroupFileCount(f.context, '123'), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.equal((e as Error & { code: unknown }).code, -9);
    assert.equal(e.message.includes('PRIVATE'), false);
    return true;
  });
  assert.equal(f.calls.length, 1);
  f.lifetime.close();
});
test('close during acquisition or stalled completion cannot return a count', async () => {
  const f = fixture();
  f.context.getRichMediaService = () => {
    f.lifetime.close();
    return {
      batchGetGroupFileCount() {
        assert.fail('mutation');
      },
    };
  };
  await assert.rejects(getGroupFileCount(f.context, '123'));
  assert.equal(f.calls.length, 0);
  let resolve!: (v: unknown) => void;
  const g = fixture(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const pending = getGroupFileCount(g.context, '123');
  g.lifetime.close();
  await assert.rejects(pending);
  resolve({ result: 0, groupCodes: ['123'], groupFileCounts: [3] });
  await Promise.resolve();
  assert.equal(g.calls.length, 1);
});
test('CLI count preflight captures ID without dispatch and returns numeric output', async () => {
  const { prepareCommand, validateCommandFlags } = await import('../src/cli/command-plan.ts');
  const flags = { 'group-id': '00123', config: 'fixture' };
  validateCommandFlags('group-file-count', flags);
  const action = await prepareCommand('group-file-count', flags);
  flags['group-id'] = '9';
  const calls: string[] = [];
  assert.equal(
    await action({
      getGroupFileCount: async (id: string) => {
        calls.push(id);
        return 7;
      },
    } as any),
    7,
  );
  assert.deepEqual(calls, ['00123']);
  await assert.rejects(prepareCommand('group-file-count', { 'group-id': '0' }));
});

test('native completion accessor is not invoked or leaked', async () => {
  let getters = 0;
  const f = fixture({
    get then() {
      getters++;
      throw Error('PRIVATE_NATIVE_WORDING');
    },
  });
  await assert.rejects(getGroupFileCount(f.context, '123'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code: unknown }).code, 'invalid-result');
    assert.equal(error.message.includes('PRIVATE_NATIVE_WORDING'), false);
    return true;
  });
  assert.equal(getters, 0);
  assert.equal(f.calls.length, 1);
  f.lifetime.close();
});

test('captured native then and boxed fulfillment never re-read proxy getters', async () => {
  let gets = 0;
  const response = {
    result: 0,
    groupCodes: ['123'],
    groupFileCounts: [9],
    get then() {
      gets++;
      throw Error('PRIVATE');
    },
  };
  const original = {
    then(resolve: (value: unknown) => void) {
      assert.equal(this, proxy);
      resolve(response);
    },
  };
  const proxy = new Proxy(original, {
    get() {
      gets++;
      throw Error('PRIVATE');
    },
  });
  const f = fixture(proxy);
  assert.equal(await getGroupFileCount(f.context, '123'), 9);
  assert.equal(gets, 0);
  f.lifetime.close();
});

test('array length is inspected by descriptor rather than native proxy get', async () => {
  let gets = 0;
  const codes = new Proxy(['123'], {
    get() {
      gets++;
      throw Error('PRIVATE');
    },
  });
  const counts = new Proxy([7], {
    get() {
      gets++;
      throw Error('PRIVATE');
    },
  });
  const f = fixture({ result: 0, groupCodes: codes, groupFileCounts: counts });
  assert.equal(await getGroupFileCount(f.context, '123'), 7);
  assert.equal(gets, 0);
  f.lifetime.close();
});

test('synchronous call close still observes late native rejection without unhandled failure', async () => {
  const f = fixture();
  let rejectNative!: (error: unknown) => void;
  const original = Error('synthetic late rejection');
  const promise = new Promise((_, reject) => {
    rejectNative = reject;
  });
  f.context.getRichMediaService = () => ({
    batchGetGroupFileCount() {
      f.lifetime.close();
      return promise;
    },
  });
  const unhandled: unknown[] = [];
  const observe = (value: unknown) => {
    unhandled.push(value);
  };
  process.on('unhandledRejection', observe);
  try {
    await assert.rejects(getGroupFileCount(f.context, '123'));
    rejectNative(original);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', observe);
  }
});

test('count native rejection retains original error identity without replay', async () => {
  const error = Object.assign(Error('synthetic rejection'), { code: 47 });
  const f = fixture(Promise.reject(error));
  await assert.rejects(
    getGroupFileCount(f.context, '123'),
    (received: unknown) => received === error,
  );
  assert.equal(f.calls.length, 1);
  f.lifetime.close();
});
