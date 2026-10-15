import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  createGroupAvatar,
  type GroupAvatarContext,
  type GroupAvatarPort,
} from '../../../src/features/groups/group-avatar.ts';
import { NativeServiceLifetime } from '../../../src/runtime/native-service-lifetime.ts';

const success = { result: 0, errMsg: '' };
const tick = () => new Promise<void>((done) => setImmediate(done));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture(t: TestContext, configure?: (context: GroupAvatarContext) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'group-avatar-'));
  const file = join(directory, 'avatar.bin');
  await writeFile(file, 'local image fixture');
  const account = new NativeServiceLifetime();
  const called = deferred<void>();
  const calls: { receiver: unknown; args: unknown[] }[] = [];
  let acquisitions = 0;
  let supports = 0;
  let waits = 0;
  let returned: () => unknown = () => success;
  const service: GroupAvatarPort = {
    setHeader(...args) {
      calls.push({ receiver: this, args });
      called.resolve();
      return returned();
    },
  };
  const context: GroupAvatarContext = {
    signal: account.signal,
    awaitAlive(value, signal) {
      waits++;
      return account.awaitAlive(value, signal);
    },
    supportsSetting() {
      assert.equal(this, context);
      supports++;
      return true;
    },
    getGroupService() {
      assert.equal(this, context);
      acquisitions++;
      return service;
    },
  };
  configure?.(context);
  const avatar = createGroupAvatar(context);
  t.after(async () => {
    avatar.close();
    account.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    avatar,
    account,
    context,
    service,
    directory,
    file,
    calls,
    called: called.promise,
    result: (value: unknown) => {
      returned = () => value;
    },
    dispatch: (operation: () => unknown) => {
      returned = operation;
    },
    counts: () => ({ supports, acquisitions, waits }),
    run: () => avatar.setGroupAvatar('000123', file),
  };
}

test('avatar uses the original group, path and native receiver for one acknowledged call', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.run(), undefined);
  assert.deepEqual(f.calls, [{ receiver: f.service, args: ['000123', f.file] }]);
  assert.deepEqual(f.counts(), { supports: 1, acquisitions: 1, waits: 3 });
});

test('avatar invalid input and unsupported profile fail before IO or service acquisition', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.avatar.setGroupAvatar('18446744073709551616', f.file), /uint64/);
  await assert.rejects(f.avatar.setGroupAvatar('123', 'relative.png'), /absolute local/);
  assert.deepEqual(f.counts(), { supports: 0, acquisitions: 0, waits: 0 });
  f.context.supportsSetting = () => false;
  await assert.rejects(f.avatar.setGroupAvatar('123', join(f.directory, 'missing')), {
    code: 'unsupported-native-contract',
  });
  assert.deepEqual(f.counts(), { supports: 0, acquisitions: 0, waits: 0 });
  assert.equal(f.calls.length, 0);
});

test('avatar file preflight rejects missing, empty and directory inputs without native acquisition', async (t) => {
  const f = await fixture(t);
  const empty = join(f.directory, 'empty');
  await writeFile(empty, '');
  for (const file of [join(f.directory, 'missing'), empty, f.directory])
    await assert.rejects(f.avatar.setGroupAvatar('123', file), {
      message: 'Group avatar file must be a readable nonempty regular file',
    });
  assert.equal(f.counts().acquisitions, 0);
  assert.equal(f.calls.length, 0);
});

test(
  'avatar rejects an unreadable regular file before native acquisition',
  {
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async (t) => {
    const f = await fixture(t);
    await chmod(f.file, 0o000);
    try {
      await assert.rejects(f.run(), /readable nonempty regular file/);
      assert.equal(f.counts().acquisitions, 0);
      assert.equal(f.calls.length, 0);
    } finally {
      await chmod(f.file, 0o600);
    }
  },
);

test('avatar requires a native method after preflight and never treats missing service as ACK', async (t) => {
  const f = await fixture(t);
  for (const service of [null, undefined, {}]) {
    f.context.getGroupService = () => service;
    await assert.rejects(f.run(), /missing setHeader/);
  }
  assert.equal(f.calls.length, 0);
});

for (const code of [-0x80000000, -1, 1, 0x7fffffff])
  test(`avatar retains native int32 failure ${code} with fixed public wording`, async (t) => {
    const f = await fixture(t);
    f.result({ result: code, errMsg: 'private native pathname and diagnostics' });
    await assert.rejects(f.run(), { code, message: 'Native group avatar setting failed' });
    assert.equal(f.calls.length, 1);
  });

test('avatar rejects malformed ACKs without native getter evaluation or leaking raw data', async (t) => {
  const f = await fixture(t);
  const getter = () => assert.fail('native ACK accessors must never execute');
  const invalid = [
    undefined,
    null,
    true,
    0,
    '',
    [],
    {},
    { result: 0 },
    { errMsg: '' },
    { result: '0', errMsg: '' },
    { result: NaN, errMsg: '' },
    { result: Infinity, errMsg: '' },
    { result: 0.5, errMsg: '' },
    { result: -0x80000001, errMsg: '' },
    { result: 0x80000000, errMsg: '' },
    { result: 0, errMsg: null },
    { result: 1, errMsg: 1 },
    Object.create(success),
    Object.defineProperty({ errMsg: '' }, 'result', { get: getter }),
    Object.defineProperty({ result: 0 }, 'errMsg', { get: getter }),
    new Proxy(success, {
      getOwnPropertyDescriptor() {
        throw new Error('private trap detail');
      },
    }),
  ];
  for (const value of invalid) {
    f.result(value);
    await assert.rejects(f.run(), {
      code: 'invalid-result',
      message: 'Invalid native group avatar result',
    });
  }
  assert.equal(f.calls.length, invalid.length);
});

test('avatar preserves Promise assimilation rejection before ACK parsing without retry', async (t) => {
  const f = await fixture(t);
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  f.result(revoked.proxy);
  await assert.rejects(f.run(), TypeError);
  const failure = new Error('Native then lookup failed');
  f.result(
    Object.defineProperty({}, 'then', {
      get() {
        throw failure;
      },
    }),
  );
  await assert.rejects(f.run(), (error) => error === failure);
  assert.equal(f.calls.length, 2);
});

test('avatar preserves a native throw or rejection without retrying', async (t) => {
  const f = await fixture(t);
  const failure = new Error('Native invocation failed');
  f.dispatch(() => {
    throw failure;
  });
  await assert.rejects(f.run(), (error) => error === failure);
  f.dispatch(() => Promise.reject(failure));
  await assert.rejects(f.run(), (error) => error === failure);
  assert.equal(f.calls.length, 2);
});

test('avatar close is independent, idempotent and prevents all later validation or IO', async (t) => {
  const f = await fixture(t);
  f.avatar.close();
  f.avatar.close();
  await assert.rejects(f.avatar.setGroupAvatar('invalid', 'relative'), /avatar service is closed/);
  assert.deepEqual(f.counts(), { supports: 0, acquisitions: 0, waits: 0 });
  assert.equal(await f.account.awaitAlive('sibling'), 'sibling');
});

for (const stage of ['support', 'service', 'method'] as const)
  for (const throws of [false, true])
    test(`avatar retirement during ${stage} ${throws ? 'throw' : 'return'} prevents dispatch`, async (t) => {
      const f = await fixture(t);
      const retire = () => {
        f.avatar.close();
        if (throws) throw new Error('Later trap error');
      };
      if (stage === 'support')
        f.context.supportsSetting = () => {
          retire();
          return true;
        };
      if (stage === 'service')
        f.context.getGroupService = () => {
          retire();
          return f.service;
        };
      if (stage === 'method')
        Object.defineProperty(f.service, 'setHeader', {
          get() {
            retire();
            return () => success;
          },
        });
      await assert.rejects(f.run(), /avatar service is closed/);
      assert.equal(f.calls.length, 0);
      if (stage === 'support') assert.equal(f.counts().waits, 0);
    });

for (const stage of [1, 2])
  for (const retirement of ['feature', 'account'] as const)
    test(`avatar ${retirement} retirement while file preflight ${stage} waits prevents dispatch`, async (t) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      let waits = 0;
      const f = await fixture(t, (context) => {
        const awaitAlive = context.awaitAlive;
        Object.defineProperty(context, 'awaitAlive', {
          value<T>(value: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
            const observed = Promise.resolve(value);
            void observed.catch(() => {});
            if (++waits !== stage) return awaitAlive(observed, signal);
            entered.resolve();
            return awaitAlive(
              release.promise.then(() => observed),
              signal,
            );
          },
        });
      });
      const result = f.run();
      const stopped = assert.rejects(result, /closed|abort/i);
      await entered.promise;
      if (retirement === 'feature') f.avatar.close();
      else f.account.close();
      await stopped;
      release.resolve();
      await tick();
      assert.equal(f.counts().acquisitions, 0);
      assert.equal(f.calls.length, 0);
    });

for (const retirement of ['feature', 'account'] as const)
  for (const late of ['resolve', 'reject'] as const)
    test(`avatar ${retirement} retirement observes late native ${late} without success or retry`, async (t) => {
      const f = await fixture(t);
      const native = deferred<unknown>();
      f.result(native.promise);
      const result = f.run();
      const stopped = assert.rejects(result, /closed|abort/i);
      await f.called;
      if (retirement === 'feature') f.avatar.close();
      else f.account.close();
      await stopped;
      if (late === 'resolve') native.resolve(success);
      else native.reject(new Error('Late native failure'));
      await tick();
      assert.equal(f.calls.length, 1);
    });

test('avatar observes rejected native work returned after synchronous dispatch retirement', async (t) => {
  const f = await fixture(t);
  f.dispatch(() => {
    f.avatar.close();
    return Promise.reject(new Error('Late failure after close'));
  });
  await assert.rejects(f.run(), /avatar service is closed/);
  await tick();
  assert.equal(f.calls.length, 1);
});

for (const late of ['resolve', 'reject'] as const)
  test(`avatar ACK deadline releases its wait, observes late ${late} and keeps the feature usable`, async (t) => {
    let localSignal: AbortSignal | undefined;
    const f = await fixture(t, (context) => {
      const awaitAlive = context.awaitAlive;
      Object.defineProperty(context, 'awaitAlive', {
        value<T>(value: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
          localSignal = signal;
          return awaitAlive(value, signal);
        },
      });
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const clear = t.mock.method(globalThis, 'clearTimeout');
    const native = deferred<unknown>();
    f.result(native.promise);
    const beforeListeners = getEventListeners(f.account.signal, 'abort').length;
    const result = f.run();
    const stopped = assert.rejects(result, {
      message: 'Native group avatar setting timed out; remote effect unknown',
    });
    await f.called;
    assert.ok(localSignal);
    assert.equal(getEventListeners(localSignal, 'abort').length, 1);
    t.mock.timers.tick(4999);
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await tick();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    await stopped;
    assert.equal(getEventListeners(f.account.signal, 'abort').length, beforeListeners);
    assert.equal(getEventListeners(localSignal, 'abort').length, 0);
    assert.equal(clear.mock.callCount(), 1);
    assert.equal(f.calls.length, 1);
    if (late === 'resolve') native.resolve(success);
    else native.reject(new Error('Native failure after ACK deadline'));
    await tick();
    assert.equal(f.calls.length, 1, 'deadline never replays the original mutation');
    f.result(success);
    await f.run();
    assert.equal(f.calls.length, 2, 'another explicit request can still use the same feature');
    assert.equal(clear.mock.callCount(), 2);
    t.mock.timers.tick(5000);
    await tick();
  });

for (const ending of ['success', 'reject', 'close'] as const)
  test(`avatar clears its ACK deadline after native ${ending}`, async (t) => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const clear = t.mock.method(globalThis, 'clearTimeout');
    const native = deferred<unknown>();
    f.result(native.promise);
    const result = f.run();
    const settled = ending === 'success' ? result : assert.rejects(result);
    await f.called;
    if (ending === 'success') native.resolve(success);
    else if (ending === 'reject') native.reject(new Error('Native rejection'));
    else f.avatar.close();
    await settled;
    assert.equal(clear.mock.callCount(), 1);
    assert.equal(f.calls.length, 1);
    native.resolve(success);
    t.mock.timers.tick(5000);
    await tick();
  });

for (const field of ['result', 'errMsg'])
  test(`avatar retirement in the ${field} descriptor trap wins over ACK parsing`, async (t) => {
    const f = await fixture(t);
    const read: PropertyKey[] = [];
    f.result(
      new Proxy(success, {
        getOwnPropertyDescriptor(target, key) {
          read.push(key);
          if (key === field) {
            f.avatar.close();
            throw new Error('Private descriptor failure');
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      }),
    );
    await assert.rejects(f.run(), /avatar service is closed/);
    assert.deepEqual(read, field === 'result' ? ['result'] : ['result', 'errMsg']);
    assert.equal(f.calls.length, 1);
  });
