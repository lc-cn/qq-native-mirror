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
