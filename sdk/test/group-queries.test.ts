import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupQueries } from '../src/features/groups/group-queries.ts';
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
    service: () => ({}),
    call(_object, method, ...args) {
      calls.push({ method, args });
      return returned;
    },
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
