import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupOperations, type GroupOperation } from '../src/group-operations.ts';

test('group operations translate explicit calls to pinned native argument contracts', async () => {
  const calls: { method: string; args: unknown[] }[] = [];
  const resolutions: string[] = [];
  const service = new Proxy({}, { get: (_, method) => async (...args: unknown[]) => { calls.push({ method: String(method), args }); return { result: 0 }; } });
  const operations = createGroupOperations({ getGroupService: () => service }, async userId => { resolutions.push(userId); return 'u_resolved'; });
  const cases: [GroupOperation, Record<string, unknown>, string, unknown[]][] = [
    ['setGroupName', { name: '新群名' }, 'modifyGroupName', ['123', '新群名', false]],
    ['setGroupMute', { enabled: true }, 'setGroupShutUp', ['123', true]],
    ['setGroupMute', { enabled: false }, 'setGroupShutUp', ['123', false]],
    ['setGroupMemberMute', { userId: '456', seconds: 0 }, 'setMemberShutUp', ['123', [{ uid: 'u_resolved', timeStamp: 0 }]]],
    ['setGroupMemberCard', { userId: '456', card: '' }, 'modifyMemberCardName', ['123', 'u_resolved', '']],
    ['setGroupAdmin', { userId: '456', enabled: true }, 'modifyMemberRole', ['123', 'u_resolved', 3]],
    ['setGroupAdmin', { userId: '456', enabled: false }, 'modifyMemberRole', ['123', 'u_resolved', 2]],
    ['kickGroupMember', { userId: '456' }, 'kickMember', ['123', ['u_resolved'], false, '']],
    ['kickGroupMember', { userId: '456', options: { rejectRejoin: true, reason: 'reason' } }, 'kickMember', ['123', ['u_resolved'], true, 'reason']],
    ['leaveGroup', {}, 'quitGroup', ['123']],
  ];
  assert.equal(calls.length, 0, 'construction does not perform mutations');
  for (const [method, payload, nativeMethod, args] of cases) {
    await operations.invokeOperation(method, { groupId: '123', ...payload });
    assert.deepEqual(calls.at(-1), { method: nativeMethod, args });
  }
  assert.equal(resolutions.length, 6);
});

test('invalid inputs do not resolve users or invoke native mutations', async () => {
  let invoked = 0;
  const operations = createGroupOperations({ getGroupService: () => { invoked++; return {}; } }, async () => { invoked++; return 'u'; });
  const cases: [GroupOperation, Record<string, unknown>][] = [
    ['leaveGroup', { groupId: '' }], ['setGroupName', { name: ' ' }],
    ['setGroupMute', { enabled: 1 }], ['setGroupAdmin', { userId: '456', enabled: 'true' }],
    ['setGroupMemberMute', { userId: '456', seconds: -1 }], ['setGroupMemberMute', { userId: '456', seconds: 1.5 }],
    ['setGroupMemberMute', { userId: '456', seconds: Number.MAX_SAFE_INTEGER + 1 }],
    ['setGroupMemberCard', { userId: 'bad', card: 'card' }],
    ['kickGroupMember', { userId: '456', options: { rejectRejoin: 1 } }],
    ['kickGroupMember', { userId: '456', options: [] }],
  ];
  for (const [method, payload] of cases) await assert.rejects(operations.invokeOperation(method, { groupId: '123', ...payload }));
  assert.equal(invoked, 0);
});

test('native failure, missing methods and UID resolution errors propagate', async () => {
  for (const result of [{ result: 5 }, undefined, {}]) {
    const operations = createGroupOperations({ getGroupService: () => ({ quitGroup: async () => result }) }, async () => 'u');
    await assert.rejects(operations.invokeOperation('leaveGroup', { groupId: '123' }), /failed/);
  }
  await assert.rejects(createGroupOperations({}, async () => 'u').invokeOperation('leaveGroup', { groupId: '123' }), /missing getGroupService/);
  await assert.rejects(createGroupOperations({ getGroupService: () => ({}) }, async () => 'u').invokeOperation('leaveGroup', { groupId: '123' }), /missing quitGroup/);
  await assert.rejects(createGroupOperations({}, async () => { throw new Error('resolution failure'); }).invokeOperation('setGroupAdmin', { groupId: '123', userId: '456', enabled: true }), /resolution failure/);
});
