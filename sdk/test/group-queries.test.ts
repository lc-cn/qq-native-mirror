import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupQueries, type GroupQueryPort } from '../src/features/groups/group-queries.ts';
import { createNativeEventChannel } from '../src/runtime/native-event-channel.ts';
import type { GroupMember } from '../src/types.ts';
import type { NativeObject } from '../src/native/native-object.ts';
const detail = (id: string) => ({
  groupCode: id,
  groupName: 'fixture',
  ownerUid: 'u_owner',
  ownerUin: '123',
  fingerMemo: '',
  memberNum: 2,
  maxMemberNum: 100,
});
const member = { uid: 'u_member', uin: '123', nick: 'fixture', cardName: '', role: 2 };
function fixture() {
  const controller = new AbortController();
  const channel = createNativeEventChannel(controller.signal);
  const calls: { method: string; args: unknown[] }[] = [];
  const commits: (readonly GroupMember[])[] = [];
  let returned: unknown = { result: 0 };
  const queries = createGroupQueries({
    signal: controller.signal,
    getGroupService: () => ({
      getGroupDetailInfo(...args) {
        calls.push({ method: 'getGroupDetailInfo', args });
        return returned;
      },
      getGroupShutUpMemberList(...args) {
        calls.push({ method: 'getGroupShutUpMemberList', args });
        return returned;
      },
      getGroupList(...args) {
        calls.push({ method: 'getGroupList', args });
        return returned;
      },
      getAllMemberList(...args) {
        calls.push({ method: 'getAllMemberList', args });
        return returned;
      },
    }),
    eventCall: channel.call,
    awaitAlive: async (value) => value,
    commitMembers: (members) => commits.push(members),
  });
  return {
    queries,
    channel,
    controller,
    calls,
    commits,
    setResult(value: unknown) {
      returned = value;
    },
  };
}
test('detail coalesces by ID, correlates concurrent IDs and clones each caller result', async () => {
  const f = fixture();
  const first = f.queries.getGroupInfo('1'),
    same = f.queries.getGroupInfo('1'),
    second = f.queries.getGroupInfo('2');
  assert.equal(f.calls.length, 2);
  f.channel.dispatch('Group/onGroupDetailInfoChange', [detail('2')]);
  f.channel.dispatch('Group/onGroupDetailInfoChange', [detail('1')]);
  const [a, b, c] = await Promise.all([first, same, second]);
  a.name = 'mutated';
  assert.equal(b.name, 'fixture');
  assert.equal(c.groupId, '2');
  f.queries.close();
  f.channel.close();
});
test('native failure quarantines detail despite callback and rejects retry without dispatch', async () => {
  const f = fixture();
  f.setResult({ result: 7 });
  const pending = assert.rejects(
    f.queries.getGroupInfo('1'),
    (error) => error instanceof Error && 'code' in error && error.code === 7,
  );
  f.channel.dispatch('Group/onGroupDetailInfoChange', [detail('1')]);
  await pending;
  await assert.rejects(f.queries.getGroupInfo('1'), /invalid/);
  assert.equal(f.calls.length, 1);
  f.queries.close();
  f.channel.close();
});
test('group full list ignores deltas, shares result and retains caller refresh argument', async () => {
  const f = fixture();
  const first = f.queries.listGroups('native-refresh'),
    same = f.queries.listGroups(false);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].args, ['native-refresh']);
  f.channel.dispatch('Group/onGroupListUpdate', [2, []]);
  f.channel.dispatch('Group/onGroupListUpdate', [
    1,
    [{ groupCode: '1', groupName: 'fixture', memberCount: 1, maxMember: 100 }],
  ]);
  const [a, b] = await Promise.all([first, same]);
  assert.equal(a, b);
  f.queries.close();
  f.channel.close();
});
test('mute caller snapshots are independent and full member batches commit only after validation', async () => {
  const f = fixture();
  const first = f.queries.listGroupMutedMembers('1'),
    same = f.queries.listGroupMutedMembers('1');
  f.channel.dispatch('Group/onShutUpMemberListChanged', ['1', [{ ...member, shutUpTime: 12 }]]);
  const [a, b] = await Promise.all([first, same]);
  a[0].nickname = 'changed';
  assert.equal(b[0].nickname, 'fixture');
  f.setResult({ errCode: 0, result: { finish: true, infos: new Map([['u_member', member]]) } });
  await f.queries.getGroupMembers('1');
  assert.equal(f.commits.length, 1);
  f.setResult({
    errCode: 0,
    result: {
      finish: true,
      infos: new Map([
        ['u_member', member],
        ['u_bad', { ...member, uid: 'u_bad', role: 99 }],
      ]),
    },
  });
  await assert.rejects(f.queries.getGroupMembers('1'), /role/);
  assert.equal(f.commits.length, 1);
  f.queries.close();
  f.channel.close();
});
test('member partial/error results never commit and invalid refresh makes zero native calls', async () => {
  const f = fixture();
  await assert.rejects(f.queries.getGroupMembers('1', 'true'), /boolean/);
  assert.equal(f.calls.length, 0);
  for (const result of [
    { errCode: 8, result: { finish: true, infos: new Map() } },
    { errCode: 0, result: { finish: false, infos: new Map() } },
  ]) {
    f.setResult(result);
    await assert.rejects(f.queries.getGroupMembers('1'));
  }
  assert.equal(f.commits.length, 0);
  f.queries.close();
  f.channel.close();
});
test('close while member response is deferred suppresses commit and subsequent native requests', async () => {
  const f = fixture();
  let resolve!: (value: NativeObject) => void;
  f.setResult(
    new Promise<NativeObject>((done) => {
      resolve = done;
    }),
  );
  const pending = assert.rejects(f.queries.getGroupMembers('1'), /closed/);
  f.queries.close();
  resolve({ errCode: 0, result: { finish: true, infos: new Map([['u_member', member]]) } });
  await pending;
  assert.equal(f.commits.length, 0);
  await assert.rejects(f.queries.getGroupInfo('2'), /closed/);
  assert.equal(f.calls.length, 1);
  f.channel.close();
});

test('closing invalidates every joined list caller even when the provider completes later', async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  f.setResult(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const first = assert.rejects(f.queries.listGroups(), /closed/);
  const joined = assert.rejects(f.queries.listGroups(), /closed/);
  try {
    // The callback has succeeded, but native completion still belongs to the provider.
    f.channel.dispatch('Group/onGroupListUpdate', [1, []]);
    f.queries.close();
    finish({ result: 0 });
    await Promise.all([first, joined]);
    assert.equal(f.calls.length, 1);
  } finally {
    f.channel.close();
  }
});

const queryCases = [
  {
    method: 'getGroupDetailInfo',
    run: (q: ReturnType<typeof createGroupQueries>) => q.getGroupInfo('1'),
    args: ['1', 2],
  },
  {
    method: 'getGroupShutUpMemberList',
    run: (q: ReturnType<typeof createGroupQueries>) => q.listGroupMutedMembers('1'),
    args: ['1'],
  },
  {
    method: 'getGroupList',
    run: (q: ReturnType<typeof createGroupQueries>) => q.listGroups('native-refresh'),
    args: ['native-refresh'],
  },
  {
    method: 'getAllMemberList',
    run: (q: ReturnType<typeof createGroupQueries>) => q.getGroupMembers('1', true),
    args: ['1', true],
  },
] as const;
for (const entry of queryCases) {
  for (const stage of ['service', 'getter'] as const) {
    for (const termination of ['close', 'abort'] as const) {
      test(`${entry.method}: reentrant ${termination} in ${stage} prevents invocation`, async () => {
        const controller = new AbortController();
        const channel = createNativeEventChannel(controller.signal);
        let nativeCalls = 0;
        let reads = 0;
        const stop = () =>
          termination === 'close'
            ? queries.close()
            : controller.abort(new Error('fixture aborted'));
        const group: GroupQueryPort = {};
        Object.defineProperty(group, entry.method, {
          get() {
            reads++;
            if (stage === 'getter') stop();
            return function (this: GroupQueryPort) {
              assert.equal(this, group);
              nativeCalls++;
              return { result: 0 };
            };
          },
        });
        const queries = createGroupQueries({
          signal: controller.signal,
          getGroupService() {
            if (stage === 'service') stop();
            return group;
          },
          eventCall: channel.call,
          awaitAlive: async (value) => value,
          commitMembers() {
            assert.fail('no commit after close');
          },
        });
        try {
          await assert.rejects(entry.run(queries), /closed|aborted/);
          assert.equal(nativeCalls, 0);
          assert.equal(reads, stage === 'getter' ? 1 : 0);
        } finally {
          queries.close();
          channel.close();
        }
      });
    }
  }
  test(`${entry.method}: missing method rejects without dispatch`, async () => {
    const controller = new AbortController();
    const channel = createNativeEventChannel(controller.signal);
    const queries = createGroupQueries({
      signal: controller.signal,
      getGroupService: () => ({}),
      eventCall: channel.call,
      awaitAlive: async (value) => value,
      commitMembers() {
        assert.fail();
      },
    });
    try {
      await assert.rejects(entry.run(queries), new RegExp(`missing ${entry.method}`));
    } finally {
      queries.close();
      channel.close();
    }
  });
  for (const stage of ['service', 'getter', 'call'] as const) {
    test(`${entry.method}: ${stage} failure preserves identity and captures receiver once`, async () => {
      const original = Object.assign(new Error('fixture original'), { code: 'fixture-code' });
      const controller = new AbortController();
      const channel = createNativeEventChannel(controller.signal);
      let reads = 0;
      const group: GroupQueryPort = {};
      Object.defineProperty(group, entry.method, {
        get() {
          reads++;
          if (stage === 'getter') throw original;
          return function (this: GroupQueryPort, ...args: unknown[]) {
            assert.equal(this, group);
            assert.deepEqual(args, entry.args);
            throw original;
          };
        },
      });
      const queries = createGroupQueries({
        signal: controller.signal,
        getGroupService() {
          if (stage === 'service') throw original;
          return group;
        },
        eventCall: channel.call,
        awaitAlive: async (value) => value,
        commitMembers() {
          assert.fail();
        },
      });
      try {
        await assert.rejects(entry.run(queries), (error) => error === original);
        assert.equal(reads, stage === 'service' ? 0 : 1);
      } finally {
        queries.close();
        channel.close();
      }
    });
  }
}

for (const entry of queryCases) {
  for (const returned of [null, undefined]) {
    test(`${entry.method}: ${String(returned)} service keeps fixed missing-method error`, async () => {
      const controller = new AbortController();
      const channel = createNativeEventChannel(controller.signal);
      const queries = createGroupQueries({
        signal: controller.signal,
        getGroupService: () => returned,
        eventCall: channel.call,
        awaitAlive: async (value) => value,
        commitMembers() {
          assert.fail();
        },
      });
      try {
        await assert.rejects(entry.run(queries), {
          message: `Native service is missing ${entry.method}`,
        });
      } finally {
        queries.close();
        channel.close();
      }
    });
    for (const termination of ['close', 'abort'] as const) {
      test(`${entry.method}: ${String(returned)} service with synchronous ${termination} keeps lifecycle priority`, async () => {
        const controller = new AbortController();
        const channel = createNativeEventChannel(controller.signal);
        const queries = createGroupQueries({
          signal: controller.signal,
          getGroupService() {
            if (termination === 'close') queries.close();
            else controller.abort(new Error('fixture aborted'));
            return returned;
          },
          eventCall: channel.call,
          awaitAlive: async (value) => value,
          commitMembers() {
            assert.fail();
          },
        });
        try {
          await assert.rejects(entry.run(queries), /closed|aborted/);
        } finally {
          queries.close();
          channel.close();
        }
      });
    }
  }
}

test('member fields are captured once before validated full-batch commit', async () => {
  const f = fixture();
  let reads = 0;
  const row = {
    ...member,
    get cardName() {
      return ++reads === 1 ? 'captured' : 123;
    },
  };
  f.setResult({ errCode: 0, result: { finish: true, infos: new Map([['u_member', row]]) } });
  const rows = await f.queries.getGroupMembers('789');
  assert.equal(reads, 1);
  assert.equal(rows[0].card, 'captured');
  assert.equal(f.commits[0][0].card, 'captured');
  f.queries.close();
  f.channel.close();
});

test('member Map storage is authoritative rather than overridden entries', async () => {
  const f = fixture();
  const infos = new Map<string, unknown>();
  let calls = 0;
  infos.entries = () => {
    calls++;
    return new Map([['u_member', member]]).entries();
  };
  f.setResult({ errCode: 0, result: { finish: true, infos } });
  assert.deepEqual(await f.queries.getGroupMembers('789'), []);
  assert.equal(calls, 0);
  assert.deepEqual(f.commits, [[]]);
  f.queries.close();
  f.channel.close();
});

test('full-list row fields and member envelope are each captured once', async () => {
  const f = fixture();
  let names = 0;
  const pending = f.queries.listGroups();
  f.channel.dispatch('Group/onGroupListUpdate', [
    0,
    [
      {
        groupCode: '789',
        get groupName() {
          return ++names === 1 ? 'captured' : 123;
        },
        memberCount: 1,
        maxMember: 10,
      },
    ],
  ]);
  assert.equal((await pending)[0].name, 'captured');
  assert.equal(names, 1);
  let envelopes = 0;
  f.setResult({
    errCode: 0,
    get result() {
      envelopes++;
      return envelopes === 1
        ? { finish: true, infos: new Map([['u_member', member]]) }
        : { finish: false };
    },
  });
  assert.equal((await f.queries.getGroupMembers('789')).length, 1);
  assert.equal(envelopes, 1);
  f.queries.close();
  f.channel.close();
});

test('member projection closing the owner cannot commit or publish the batch', async () => {
  const f = fixture();
  f.setResult({
    errCode: 0,
    result: {
      finish: true,
      infos: new Map([
        [
          'u_member',
          {
            ...member,
            get cardName() {
              f.queries.close();
              return 'card';
            },
          },
        ],
      ]),
    },
  });
  await assert.rejects(f.queries.getGroupMembers('789'), /closed/);
  assert.equal(f.commits.length, 0);
  f.channel.close();
});

test('member failure code is captured once without changing native error policy', async () => {
  const f = fixture();
  let reads = 0;
  f.setResult({
    get errCode() {
      return ++reads === 1 ? 12 : 0;
    },
  });
  await assert.rejects(f.queries.getGroupMembers('789'), { code: 12 });
  assert.equal(reads, 1);
  assert.equal(f.commits.length, 0);
  f.queries.close();
  f.channel.close();
});

for (const method of ['getGroupInfo', 'listGroupMutedMembers', 'getGroupMembers'] as const) {
  test(`${method}: direct invalid group IDs reject before acquisition, callback or cache`, async () => {
    const controller = new AbortController();
    let acquisitions = 0;
    let callbacks = 0;
    let commits = 0;
    const queries = createGroupQueries({
      signal: controller.signal,
      getGroupService() {
        acquisitions++;
        throw new Error('unexpected service acquisition');
      },
      eventCall() {
        callbacks++;
        throw new Error('unexpected callback request');
      },
      awaitAlive: async (value) => value,
      commitMembers() {
        commits++;
      },
    });
    try {
      for (const id of ['', '0', '0000', ' ', '-1', '1.5', 'abc', '1*']) {
        await assert.rejects(queries[method](id), { message: 'Invalid send group identifier' });
      }
      assert.equal(acquisitions, 0);
      assert.equal(callbacks, 0);
      assert.equal(commits, 0);
    } finally {
      queries.close();
    }
  });
}

test('direct query IDs preserve leading zero spelling and legacy refresh defaults', async () => {
  const f = fixture();
  try {
    const info = f.queries.getGroupInfo('0001');
    f.channel.dispatch('Group/onGroupDetailInfoChange', [detail('0001')]);
    assert.equal((await info).groupId, '0001');
    const mute = f.queries.listGroupMutedMembers('0001');
    f.channel.dispatch('Group/onShutUpMemberListChanged', ['0001', []]);
    assert.deepEqual(await mute, []);
    f.setResult({ errCode: 0, result: { finish: true, infos: new Map() } });
    for (const refresh of [null, undefined]) await f.queries.getGroupMembers('0001', refresh);
    assert.deepEqual(
      f.calls.map((call) => call.args),
      [['0001', 2], ['0001'], ['0001', false], ['0001', false]],
    );
    await f.queries.getGroupMembers('18446744073709551616');
    assert.deepEqual(f.calls.at(-1)?.args, ['18446744073709551616', false]);
    f.setResult({ result: 0 });
    const list = f.queries.listGroups({ legacy: true });
    f.channel.dispatch('Group/onGroupListUpdate', [0, []]);
    await list;
    assert.deepEqual(f.calls.at(-1)?.args, [{ legacy: true }]);
  } finally {
    f.queries.close();
    f.channel.close();
  }
});

for (const entry of queryCases) {
  test(`${entry.method}: local close settles stalled query without retiring shared channel`, async () => {
    const f = fixture();
    let rejectNative!: (reason: unknown) => void;
    f.setResult(
      new Promise((_, reject) => {
        rejectNative = reject;
      }),
    );
    const pending = entry.run(f.queries);
    const observed = pending.then(
      () => ({ kind: 'fulfilled' as const }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      f.queries.close();
      const outcome = await Promise.race([
        observed,
        new Promise<{ kind: 'deadline' }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'deadline' }), 100);
        }),
      ]);
      assert.equal(outcome.kind, 'rejected', 'local close must settle before native completion');
      if (outcome.kind === 'rejected') assert.match(String(outcome.error), /closed/i);
      assert.equal(f.controller.signal.aborted, false);
      const sibling = f.channel.call(
        'fixture/sibling',
        (value: unknown) => (value === 'ready' ? 'ready' : undefined),
        () => {
          f.channel.dispatch('fixture/sibling', ['ready']);
          return { result: 0 };
        },
        100,
        (value) => !!value && typeof value === 'object' && 'result' in value && value.result === 0,
      );
      assert.equal(await sibling, 'ready');
      rejectNative(new Error('late provider failure'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(f.commits.length, 0);
      assert.equal(f.calls.length, 1);
    } finally {
      if (timer) clearTimeout(timer);
      rejectNative(new Error('late provider cleanup'));
      f.channel.close();
      await observed;
    }
  });
}
