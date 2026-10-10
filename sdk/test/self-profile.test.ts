import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSelfProfile as createNarrowSelfProfile,
  type SelfProfilePort,
  type SelfProfileListener,
} from '../src/features/contacts/self-profile.ts';
function createSelfProfile(
  session: { getProfileService(): SelfProfilePort },
  resolveSelfUid: () => string | Promise<string>,
) {
  return createNarrowSelfProfile({
    getProfileService: () => session.getProfileService(),
    resolveSelfUid,
    signal: new AbortController().signal,
    awaitAlive: async (value) => value,
  });
}

function fixture(
  base: Record<string, unknown> = {
    longNick: 'preserve signature',
    sex: 255,
    birthday_year: 2000,
    birthday_month: 1,
    birthday_day: 2,
  },
  core: Record<string, unknown> = { nick: 'existing nickname' },
) {
  let listener: SelfProfileListener | undefined;
  const calls: unknown[][] = [];
  const service = {
    addKernelProfileListener: (value: SelfProfileListener) => {
      listener = value;
      return 3;
    },
    removeKernelProfileListener: (id: unknown) => calls.push(['remove', id]),
    fetchUserDetailInfo: async (...args: unknown[]) => {
      calls.push(['fetch', ...args]);
      listener!.onUserDetailInfoChanged({ uid: 'other' });
      listener!.onUserDetailInfoChanged({
        uid: 'self',
        simpleInfo: { baseInfo: base, coreInfo: core },
      });
      return { result: 0 };
    },
    modifyDesktopMiniProfile: async (payload: unknown) => {
      calls.push(['modify', payload]);
      return { result: 0 };
    },
  };
  return {
    service,
    calls,
    client: createSelfProfile({ getProfileService: () => service }, () => 'self'),
  };
}
test('nickname uses native self detail and preserves all required fields with exact mutation payload', async () => {
  const f = fixture();
  await f.client.invokeOperation('setNickname', { name: 'new nickname' });
  assert.deepEqual(f.calls, [
    ['fetch', 'BuddyProfileStore', ['self'], 1, [0]],
    ['remove', 3],
    [
      'modify',
      {
        nick: 'new nickname',
        longNick: 'preserve signature',
        sex: 255,
        birthday: { birthday_year: '2000', birthday_month: '1', birthday_day: '2' },
        location: undefined,
      },
    ],
  ]);
});
test('invalid names and incomplete existing profiles do not mutate; native failures reject', async () => {
  const f = fixture({ longNick: 'signature' });
  await assert.rejects(f.client.invokeOperation('setNickname', { name: '' }), /nonempty/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.client.invokeOperation('setNickname', { name: 'new' }), /preserve/);
  assert.ok(!f.calls.some((call) => call[0] === 'modify'));
  const failed = fixture();
  failed.service.modifyDesktopMiniProfile = async () => ({ result: 9 });
  await assert.rejects(failed.client.invokeOperation('setNickname', { name: 'new' }), {
    message: /update failed/,
    code: 9,
  });
});
test('lookup failure invalidates uncorrelated channel and close cancels pending lookup', async () => {
  const f = fixture();
  f.service.fetchUserDetailInfo = async (...args) => {
    f.calls.push(['fetch', ...args]);
    return { result: 9 };
  };
  await assert.rejects(f.client.invokeOperation('setNickname', { name: 'new' }), {
    message: /lookup failed/,
    code: 9,
  });
  await assert.rejects(f.client.invokeOperation('setNickname', { name: 'new' }), /recreate/);
  assert.equal(f.calls.filter((call) => call[0] === 'fetch').length, 1);
  const pending = fixture();
  pending.service.fetchUserDetailInfo = async () => ({ result: 0 });
  const assertion = assert.rejects(
    pending.client.invokeOperation('setNickname', { name: 'new' }),
    /closed/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  pending.client.close();
  await assertion;
  assert.deepEqual(pending.calls, [['remove', 3]]);
});

test('actual lookup deadline blocks a late profile callback and later mutation attempts', async () => {
  let listener: SelfProfileListener | undefined,
    fetches = 0,
    modifications = 0,
    removed = 0;
  const service = {
    addKernelProfileListener(value: SelfProfileListener) {
      listener = value;
      return 7;
    },
    removeKernelProfileListener(id: unknown) {
      assert.equal(id, 7);
      removed++;
    },
    async fetchUserDetailInfo() {
      fetches++;
      return { result: 0 };
    },
    async modifyDesktopMiniProfile() {
      modifications++;
      return { result: 0 };
    },
  };
  const client = createSelfProfile({ getProfileService: () => service }, () => 'self');
  try {
    await assert.rejects(
      client.invokeOperation('setNickname', { name: 'never sent' }),
      /timed out/,
    );
    listener!.onUserDetailInfoChanged({
      uid: 'self',
      simpleInfo: {
        baseInfo: {
          longNick: 'keep',
          sex: 0,
          birthday_year: 0,
          birthday_month: 0,
          birthday_day: 0,
        },
      },
    });
    await assert.rejects(
      client.invokeOperation('setNickname', { name: 'also never sent' }),
      /recreate/,
    );
    assert.equal(fetches, 1);
    assert.equal(modifications, 0);
    assert.equal(removed, 1);
  } finally {
    client.close();
  }
});

for (const text of ['new signature', '']) {
  test(`signature ${text ? 'update' : 'clear'} preserves the exact existing nickname and profile`, async () => {
    const f = fixture(undefined, { nick: '  Original nickname  ' });
    await f.client.invokeOperation('setSignature', { text });
    assert.deepEqual(f.calls, [
      ['fetch', 'BuddyProfileStore', ['self'], 1, [0]],
      ['remove', 3],
      [
        'modify',
        {
          nick: '  Original nickname  ',
          longNick: text,
          sex: 255,
          birthday: { birthday_year: '2000', birthday_month: '1', birthday_day: '2' },
          location: undefined,
        },
      ],
    ]);
  });
}
test('invalid signature input never invokes native methods', async () => {
  const f = fixture();
  for (const text of [undefined, null, 1, {}, []])
    await assert.rejects(
      f.client.invokeOperation('setSignature', { text }),
      /text must be a string/,
    );
  assert.deepEqual(f.calls, []);
});
test('signature refuses missing or invalid nickname and preserves native rejection code', async () => {
  for (const nick of [undefined, null, false, {}, '', '   ']) {
    const f = fixture(undefined, { nick });
    await assert.rejects(f.client.invokeOperation('setSignature', { text: 'new' }), /nickname/);
    assert.equal(f.calls.filter((call) => call[0] === 'modify').length, 0);
  }
  const f = fixture();
  f.service.modifyDesktopMiniProfile = async () => ({ result: 17 });
  await assert.rejects(f.client.invokeOperation('setSignature', { text: '' }), { code: 17 });
});
test('signature and nickname updates share busy guard and close prevents a pending mutation', async () => {
  const f = fixture();
  let complete!: (value: { result: number }) => void;
  f.service.fetchUserDetailInfo = (...args: unknown[]) => {
    f.calls.push(['fetch', ...args]);
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  const pending = f.client.invokeOperation('setSignature', { text: '' });
  const rejected = assert.rejects(pending, /closed/);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.client.invokeOperation('setNickname', { name: 'new' }), /pending/);
  await assert.rejects(f.client.invokeOperation('setSignature', { text: 'other' }), /pending/);
  f.client.close();
  await rejected;
  complete({ result: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.client.invokeOperation('setSignature', { text: '' }), /closed/);
  assert.equal(f.calls.filter((call) => call[0] === 'modify').length, 0);
});

const detail = {
  uid: 'self',
  simpleInfo: {
    baseInfo: { longNick: 'keep', sex: 0, birthday_year: 2000, birthday_month: 1, birthday_day: 2 },
    coreInfo: { nick: 'keep nick' },
  },
};
function narrowFixture(
  options: {
    remove?: (id: unknown) => unknown;
    uid?: () => string | Promise<string>;
    modify?: (request: unknown) => unknown;
  } = {},
) {
  let listener!: SelfProfileListener;
  const calls: string[] = [];
  const service: SelfProfilePort = {
    addKernelProfileListener(value) {
      assert.equal(this, service);
      calls.push('add');
      listener = value;
      return 'opaque-id';
    },
    removeKernelProfileListener(id) {
      assert.equal(this, service);
      assert.equal(id, 'opaque-id');
      calls.push('remove');
      return options.remove?.(id);
    },
    fetchUserDetailInfo(...args) {
      assert.equal(this, service);
      assert.deepEqual(args, ['BuddyProfileStore', ['self'], 1, [0]]);
      calls.push('fetch');
      listener.onUserDetailInfoChanged(detail);
      return { result: 0 };
    },
    modifyDesktopMiniProfile(request) {
      assert.equal(this, service);
      calls.push('modify');
      return options.modify?.(request) ?? { result: 0 };
    },
  };
  const client = createNarrowSelfProfile({
    getProfileService: () => service,
    resolveSelfUid: options.uid ?? (() => 'self'),
    signal: new AbortController().signal,
    awaitAlive: async (value) => value,
  });
  return {
    service,
    client,
    calls,
    callback: (value: unknown) => listener.onUserDetailInfoChanged(value),
  };
}
test('synchronous registration close removes the acquired opaque ID exactly once and never fetches', async () => {
  const f = narrowFixture();
  f.service.addKernelProfileListener = function (listener) {
    assert.equal(this, f.service);
    f.calls.push('add');
    f.client.close();
    listener.onUserDetailInfoChanged(detail);
    return 'opaque-id';
  };
  await assert.rejects(f.client.invokeOperation('setNickname', { name: 'new' }), /closed/);
  assert.deepEqual(f.calls, ['add', 'remove']);
  f.client.close();
  assert.deepEqual(f.calls, ['add', 'remove']);
});
for (const stage of ['service', 'add-getter', 'fetch-getter', 'modify-getter'] as const) {
  test(`synchronous close in ${stage} prevents later native dispatch`, async () => {
    const f = narrowFixture();
    let reads = 0;
    if (stage === 'service') {
      const client = createNarrowSelfProfile({
        getProfileService() {
          client.close();
          return f.service;
        },
        resolveSelfUid: () => 'self',
        signal: new AbortController().signal,
        awaitAlive: async (value) => value,
      });
      await assert.rejects(client.invokeOperation('setNickname', { name: 'new' }), /closed/);
      assert.deepEqual(f.calls, []);
      return;
    }
    const method =
      stage === 'add-getter'
        ? 'addKernelProfileListener'
        : stage === 'fetch-getter'
          ? 'fetchUserDetailInfo'
          : 'modifyDesktopMiniProfile';
    const original = f.service[method];
    Object.defineProperty(f.service, method, {
      get() {
        reads++;
        f.client.close();
        return original;
      },
    });
    await assert.rejects(f.client.invokeOperation('setNickname', { name: 'new' }), /closed/);
    assert.equal(reads, 1);
    assert.equal(f.calls.includes('modify'), false);
    if (stage === 'add-getter') assert.deepEqual(f.calls, []);
    if (stage === 'fetch-getter') assert.deepEqual(f.calls, ['add', 'remove']);
  });
}
test('successful callback does not replace failed native lookup or cause mutation', async () => {
  const f = narrowFixture();
  f.service.fetchUserDetailInfo = () => {
    f.callback(detail);
    return Promise.resolve({ result: 9 });
  };
  await assert.rejects(f.client.invokeOperation('setNickname', { name: 'new' }), { code: 9 });
  assert.deepEqual(f.calls, ['add', 'remove']);
  await assert.rejects(f.client.invokeOperation('setNickname', { name: 'new' }), /invalidated/);
});
test('cleanup throw rejects success once, preserves identity and does not leave lookup hanging', async () => {
  const error = Error('remove failed');
  const f = narrowFixture({
    remove() {
      throw error;
    },
  });
  await assert.rejects(
    f.client.invokeOperation('setNickname', { name: 'new' }),
    (received) => received === error,
  );
  assert.deepEqual(f.calls, ['add', 'fetch', 'remove']);
  f.client.close();
  await assert.rejects(f.client.invokeOperation('setNickname', { name: 'new' }), /closed/);
});
test('lookup failure plus cleanup failure preserves both errors, while close retains cleanup identity', async () => {
  const error = Error('remove failed');
  const f = narrowFixture({
    remove() {
      throw error;
    },
  });
  f.service.fetchUserDetailInfo = () => new Promise(() => {});
  const pending = assert.rejects(
    f.client.invokeOperation('setSignature', { text: '' }),
    (received) => {
      assert.ok(received instanceof AggregateError);
      assert.match(received.errors[0].message, /closed/);
      assert.equal(received.errors[1], error);
      return true;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.throws(
    () => f.client.close(),
    (received) => received === error,
  );
  await pending;
  f.client.close();
  f.callback(detail);
  assert.deepEqual(f.calls, ['add', 'remove']);
});
for (const mode of ['pending', 'rejected'] as const) {
  test(`undocumented ${mode} cleanup return is observed without awaiting or retrying`, async () => {
    const f = narrowFixture({
      remove: () =>
        mode === 'pending' ? new Promise(() => {}) : Promise.reject(Error('late remove failure')),
    });
    await f.client.invokeOperation('setSignature', { text: '' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(f.calls, ['add', 'fetch', 'remove', 'modify']);
    f.client.close();
  });
}
for (const stage of ['uid', 'mutation', 'lookup'] as const) {
  test(`close interrupts pending ${stage} and observes late native rejection`, async () => {
    let reject!: (error: Error) => void;
    const native = new Promise<never>((_, fail) => {
      reject = fail;
    });
    const f = narrowFixture({
      uid: stage === 'uid' ? () => native : undefined,
      modify: stage === 'mutation' ? () => native : undefined,
    });
    if (stage === 'lookup')
      f.service.fetchUserDetailInfo = () => {
        f.callback(detail);
        return native;
      };
    const pending = assert.rejects(
      f.client.invokeOperation('setNickname', { name: 'new' }),
      /closed/,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.client.close();
    await pending;
    reject(Error('late rejection'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      f.calls.filter((value) => value === 'modify').length,
      stage === 'mutation' ? 1 : 0,
    );
  });
}
for (const operation of ['setNickname', 'setSignature'] as const) {
  test(`${operation} snapshots validated input before asynchronous UID resolution`, async () => {
    let resolve!: (value: string) => void;
    const uid = new Promise<string>((done) => {
      resolve = done;
    });
    let request: unknown;
    const f = narrowFixture({
      uid: () => uid,
      modify: (value) => {
        request = value;
        return { result: 0 };
      },
    });
    const payload: Record<string, unknown> =
      operation === 'setNickname' ? { name: 'captured' } : { text: 'captured' };
    const pending = f.client.invokeOperation(operation, payload);
    payload.name = 'mutated';
    payload.text = 'mutated';
    resolve('self');
    await pending;
    assert.equal(
      (request as Record<string, unknown>)[operation === 'setNickname' ? 'nick' : 'longNick'],
      'captured',
    );
    f.client.close();
  });
}

for (const service of [null, undefined, {}]) {
  test(`nullable or absent registration port rejects without dispatch`, async () => {
    const client = createNarrowSelfProfile({
      getProfileService: () => service,
      resolveSelfUid: () => 'self',
      signal: new AbortController().signal,
      awaitAlive: async (value) => value,
    });
    await assert.rejects(client.invokeOperation('setNickname', { name: 'new' }), {
      message: 'Native self profile lookup failed',
    });
    await assert.rejects(client.invokeOperation('setNickname', { name: 'new' }), /invalidated/);
    client.close();
  });
}
test('all four native methods are captured once and keep their original receiver', async () => {
  const f = narrowFixture();
  const reads = new Map<string, number>();
  for (const name of [
    'addKernelProfileListener',
    'removeKernelProfileListener',
    'fetchUserDetailInfo',
    'modifyDesktopMiniProfile',
  ] as const) {
    const method = f.service[name];
    Object.defineProperty(f.service, name, {
      get() {
        reads.set(name, (reads.get(name) ?? 0) + 1);
        return method;
      },
    });
  }
  await f.client.invokeOperation('setNickname', { name: 'new' });
  assert.deepEqual([...reads.values()], [1, 1, 1, 1]);
  f.client.close();
});
test('native lookup code and fallible cleanup are both retained without mutation', async () => {
  const cleanup = Error('cleanup identity');
  const f = narrowFixture({
    remove() {
      throw cleanup;
    },
  });
  f.service.fetchUserDetailInfo = () => ({ result: 9 });
  await assert.rejects(f.client.invokeOperation('setNickname', { name: 'new' }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].code, 9);
    assert.equal(error.errors[1], cleanup);
    return true;
  });
  assert.deepEqual(f.calls, ['add', 'remove']);
  f.client.close();
});
test('synchronous fetch closes then returns a rejected promise without an unobserved rejection', async () => {
  const f = narrowFixture();
  f.service.fetchUserDetailInfo = () => {
    f.client.close();
    return Promise.reject(Error('late after synchronous close'));
  };
  await assert.rejects(f.client.invokeOperation('setNickname', { name: 'new' }), /closed/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls, ['add', 'remove']);
});

test('mutation acknowledgement getter closing owner cannot report success', async () => {
  const f = narrowFixture({
    modify: () => ({
      get result() {
        f.client.close();
        return 0;
      },
    }),
  });
  await assert.rejects(f.client.invokeOperation('setNickname', { name: 'new' }), /closed/);
  assert.deepEqual(f.calls, ['add', 'fetch', 'remove', 'modify']);
});
