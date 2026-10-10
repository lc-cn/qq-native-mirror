import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGroupOperations,
  type GroupOperation,
} from '../src/features/groups/group-operations.ts';

test('group operations translate explicit calls to pinned native argument contracts', async () => {
  const calls: { method: string; args: unknown[] }[] = [];
  const resolutions: string[] = [];
  const service = new Proxy(
    {},
    {
      get:
        (_, method) =>
        async (...args: unknown[]) => {
          calls.push({ method: String(method), args });
          return { result: 0 };
        },
    },
  );
  const operations = createGroupOperations({ getGroupService: () => service }, async (userId) => {
    resolutions.push(userId);
    return 'u_resolved';
  });
  const cases: [GroupOperation, Record<string, unknown>, string, unknown[]][] = [
    ['setGroupName', { name: '新群名' }, 'modifyGroupName', ['123', '新群名', false]],
    ['setGroupRemark', { remark: '本地群备注' }, 'modifyGroupRemark', ['123', '本地群备注']],
    ['setGroupRemark', { remark: '' }, 'modifyGroupRemark', ['123', '']],
    ['setGroupMute', { enabled: true }, 'setGroupShutUp', ['123', true]],
    ['setGroupMute', { enabled: false }, 'setGroupShutUp', ['123', false]],
    [
      'setGroupMemberMute',
      { userId: '456', seconds: 0 },
      'setMemberShutUp',
      ['123', [{ uid: 'u_resolved', timeStamp: 0 }]],
    ],
    [
      'setGroupMemberCard',
      { userId: '456', card: '' },
      'modifyMemberCardName',
      ['123', 'u_resolved', ''],
    ],
    [
      'setGroupAdmin',
      { userId: '456', enabled: true },
      'modifyMemberRole',
      ['123', 'u_resolved', 3],
    ],
    [
      'setGroupAdmin',
      { userId: '456', enabled: false },
      'modifyMemberRole',
      ['123', 'u_resolved', 2],
    ],
    ['kickGroupMember', { userId: '456' }, 'kickMember', ['123', ['u_resolved'], false, '']],
    [
      'kickGroupMember',
      { userId: '456', options: { rejectRejoin: true, reason: 'reason' } },
      'kickMember',
      ['123', ['u_resolved'], true, 'reason'],
    ],
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
  const operations = createGroupOperations(
    {
      getGroupService: () => {
        invoked++;
        return {};
      },
    },
    async () => {
      invoked++;
      return 'u';
    },
  );
  const cases: [GroupOperation, Record<string, unknown>][] = [
    ['leaveGroup', { groupId: '' }],
    ['setGroupName', { name: ' ' }],
    ['setGroupRemark', { remark: { toString: () => 'invalid' } }],
    ['setGroupMute', { enabled: 1 }],
    ['setGroupAdmin', { userId: '456', enabled: 'true' }],
    ['setGroupMemberMute', { userId: '456', seconds: -1 }],
    ['setGroupMemberMute', { userId: '456', seconds: 1.5 }],
    ['setGroupMemberMute', { userId: '456', seconds: Number.MAX_SAFE_INTEGER + 1 }],
    ['setGroupMemberCard', { userId: 'bad', card: 'card' }],
    ['kickGroupMember', { userId: '456', options: { rejectRejoin: 1 } }],
    ['kickGroupMember', { userId: '456', options: [] }],
  ];
  for (const [method, payload] of cases)
    await assert.rejects(operations.invokeOperation(method, { groupId: '123', ...payload }));
  assert.equal(invoked, 0);
});

test('native failure, missing methods and UID resolution errors propagate', async () => {
  for (const result of [{ result: 5 }, undefined, {}]) {
    const operations = createGroupOperations(
      { getGroupService: () => ({ modifyGroupName: async () => result }) },
      async () => 'u',
    );
    await assert.rejects(
      operations.invokeOperation('setGroupName', { groupId: '123', name: 'name' }),
      /failed/,
    );
  }
  await assert.rejects(
    createGroupOperations({}, async () => 'u').invokeOperation('leaveGroup', { groupId: '123' }),
    /missing getGroupService/,
  );
  await assert.rejects(
    createGroupOperations({ getGroupService: () => ({}) }, async () => 'u').invokeOperation(
      'leaveGroup',
      { groupId: '123' },
    ),
    /missing quitGroup/,
  );
  await assert.rejects(
    createGroupOperations({}, async () => {
      throw new Error('resolution failure');
    }).invokeOperation('setGroupAdmin', { groupId: '123', userId: '456', enabled: true }),
    /resolution failure/,
  );
});

test('void group contracts acknowledge dispatch once without requiring an invented result', async () => {
  const calls: string[] = [];
  const operations = createGroupOperations(
    {
      getGroupService: () => ({
        modifyMemberRole: () => {
          calls.push('role');
        },
        modifyMemberCardName: () => {
          calls.push('card');
        },
        kickMember: async () => {
          calls.push('kick');
        },
        quitGroup: () => {
          calls.push('quit');
        },
      }),
    },
    async () => 'u',
  );
  await operations.invokeOperation('setGroupAdmin', {
    groupId: '123',
    userId: '456',
    enabled: true,
  });
  await operations.invokeOperation('setGroupMemberCard', {
    groupId: '123',
    userId: '456',
    card: '',
  });
  await operations.invokeOperation('kickGroupMember', { groupId: '123', userId: '456' });
  await operations.invokeOperation('leaveGroup', { groupId: '123' });
  assert.deepEqual(calls, ['role', 'card', 'kick', 'quit']);
});

test('result-bearing group contracts still reject missing or malformed completion', async () => {
  for (const result of [undefined, null, {}, 0, { result: '0' }]) {
    const service = {
      modifyGroupName: () => result,
      modifyGroupRemark: () => result,
      setGroupShutUp: () => result,
      setMemberShutUp: () => result,
    };
    const operations = createGroupOperations({ getGroupService: () => service }, async () => 'u');
    for (const [method, payload] of [
      ['setGroupName', { name: 'name' }],
      ['setGroupRemark', { remark: '' }],
      ['setGroupMute', { enabled: false }],
      ['setGroupMemberMute', { userId: '456', seconds: 0 }],
    ] as [GroupOperation, Record<string, unknown>][]) {
      await assert.rejects(
        operations.invokeOperation(method, { groupId: '123', ...payload }),
        /failed/,
      );
    }
  }
});

test('void contracts retain explicit rejection codes and do not expose native response payloads', async () => {
  for (const [result, code] of [
    [{ result: 'permission-denied', credential: 'fixture-secret' }, 'permission-denied'],
    [{ result: -7003 }, -7003],
    [{ result: NaN }, 'invalid-result'],
    [{ result: Infinity }, 'invalid-result'],
    [{}, 'invalid-result'],
    [null, 'invalid-result'],
  ] as [unknown, string | number][]) {
    let calls = 0;
    const operations = createGroupOperations(
      {
        getGroupService: () => ({
          quitGroup: () => {
            calls++;
            return result;
          },
        }),
      },
      async () => 'u',
    );
    await assert.rejects(operations.invokeOperation('leaveGroup', { groupId: '123' }), (error) => {
      assert.equal((error as Error & { code: unknown }).code, code);
      assert.doesNotMatch(JSON.stringify(error), /fixture-secret|credential/);
      return true;
    });
    assert.equal(calls, 1);
  }
});
