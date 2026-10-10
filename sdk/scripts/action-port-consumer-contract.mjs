import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Verify compiled action adapters from the installed archive, with controlled
 * services and the real Session lifetime. This never loads a QQ addon. */
export async function verifyActionPortConsumer(installedRoot) {
  const load = (path) => import(pathToFileURL(join(installedRoot, 'dist', path)).href);
  const [contacts, groups, runtime, cli, client] = await Promise.all([
    load('features/contacts/contact-operations.js'),
    load('features/groups/group-operations.js'),
    load('runtime/native-service-lifetime.js'),
    load('cli.js'),
    load('index.js'),
  ]);
  const { createContactOperations } = contacts;
  const { createGroupOperations } = groups;
  const { NativeServiceLifetime } = runtime;

  const fixture = (factory, ports, resolveUid = async () => 'u_fixture') => {
    const lifetime = new NativeServiceLifetime();
    const operations = factory({
      ...ports,
      resolveUid,
      signal: lifetime.signal,
      awaitAlive: lifetime.awaitAlive,
    });
    return { operations, lifetime };
  };
  const cases = [
    [
      createContactOperations,
      'setFriendRemark',
      { userId: '456', remark: '' },
      'getBuddyService',
      'setBuddyRemark',
    ],
    [createContactOperations, 'deleteFriend', { userId: '456' }, 'getBuddyService', 'delBuddy'],
    [
      createContactOperations,
      'getUserProfile',
      { userId: '456' },
      'getProfileService',
      'getCoreAndBaseInfo',
    ],
    [
      createGroupOperations,
      'setGroupName',
      { groupId: '123', name: 'name' },
      'getGroupService',
      'modifyGroupName',
    ],
    [
      createGroupOperations,
      'setGroupAdmin',
      { groupId: '123', userId: '456', enabled: true },
      'getGroupService',
      'modifyMemberRole',
    ],
  ];
  // A service/method accessor may synchronously retire the Session. None of the
  // actions may call a function acquired from that retired generation.
  for (const [factory, operation, payload, getter, method] of cases) {
    for (const stage of ['service', 'method']) {
      let calls = 0;
      let reads = 0;
      const service = {};
      Object.defineProperty(service, method, {
        get() {
          reads++;
          if (stage === 'method') lifetime.close();
          return () => {
            calls++;
            return { result: 0 };
          };
        },
      });
      const f = fixture(factory, {
        [getter]() {
          if (stage === 'service') lifetime.close();
          return service;
        },
      });
      const lifetime = f.lifetime;
      await assert.rejects(f.operations.invokeOperation(operation, payload), /closed|abort/i);
      assert.equal(calls, 0);
      assert.equal(reads, stage === 'method' ? 1 : 0);
    }
  }

  for (const [factory, operation, payload, getter, method] of cases.filter(
    (c) => c[1] !== 'getUserProfile',
  )) {
    let started;
    let rejectNative;
    let calls = 0;
    const began = new Promise((resolve) => {
      started = resolve;
    });
    const native = new Promise((_resolve, reject) => {
      rejectNative = reject;
    });
    const f = fixture(factory, {
      [getter]: () => ({
        [method]() {
          calls++;
          started();
          return native;
        },
      }),
    });
    const pending = f.operations.invokeOperation(operation, payload);
    await began;
    f.lifetime.close();
    let deadline;
    try {
      await assert.rejects(
        Promise.race([
          pending,
          new Promise((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error('Action close did not settle')), 1500);
          }),
        ]),
        /closed|abort/i,
      );
    } finally {
      clearTimeout(deadline);
    }
    rejectNative(new Error('Late synthetic native rejection'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1, 'a retired mutation is observed without replay');
  }

  const calls = [];
  const service = {
    modifyMemberRole: (...args) => {
      calls.push(['role', args]);
    },
    modifyMemberCardName: (...args) => {
      calls.push(['card', args]);
    },
    kickMember: async (...args) => {
      calls.push(['kick', args]);
    },
    quitGroup: (...args) => {
      calls.push(['quit', args]);
    },
  };
  const f = fixture(createGroupOperations, { getGroupService: () => service });
  const publicClient = {
    setGroupAdmin: (groupId, userId, enabled) =>
      f.operations.invokeOperation('setGroupAdmin', { groupId, userId, enabled }),
    setGroupMemberCard: (groupId, userId, card) =>
      f.operations.invokeOperation('setGroupMemberCard', { groupId, userId, card }),
    kickGroupMember: (groupId, userId, options) =>
      f.operations.invokeOperation('kickGroupMember', { groupId, userId, options }),
    leaveGroup: (groupId) => f.operations.invokeOperation('leaveGroup', { groupId }),
  };
  try {
    for (const method of Object.keys(publicClient))
      assert.equal(typeof client.QQClient.prototype[method], 'function');
    for (const [command, flags] of [
      ['member-admin', { 'user-id': '456', enabled: 'true' }],
      ['member-card', { 'user-id': '456', card: '' }],
      ['group-kick', { 'user-id': '456' }],
      ['group-leave', {}],
    ])
      await (
        await cli.prepareCommand(command, { 'group-id': '123', ...flags })
      )(publicClient);
    assert.deepEqual(calls, [
      ['role', ['123', 'u_fixture', 3]],
      ['card', ['123', 'u_fixture', '']],
      ['kick', ['123', ['u_fixture'], false, '']],
      ['quit', ['123']],
    ]);
  } finally {
    f.lifetime.close();
  }
  const strict = fixture(createGroupOperations, {
    getGroupService: () => ({ modifyGroupName() {}, setGroupShutUp() {}, setMemberShutUp() {} }),
  });
  try {
    for (const [method, payload] of [
      ['setGroupName', { name: 'name' }],
      ['setGroupMute', { enabled: true }],
      ['setGroupMemberMute', { userId: '456', seconds: 0 }],
    ])
      await assert.rejects(
        strict.operations.invokeOperation(method, { groupId: '123', ...payload }),
        { code: 'invalid-result' },
      );
  } finally {
    strict.lifetime.close();
  }
  for (const [result, code] of [
    [{ result: 'denied' }, 'denied'],
    [{ result: 73 }, 73],
    [{ result: NaN }, 'invalid-result'],
    [{}, 'invalid-result'],
  ]) {
    let attempts = 0;
    const rejection = fixture(createGroupOperations, {
      getGroupService: () => ({
        quitGroup() {
          attempts++;
          return result;
        },
      }),
    });
    try {
      await assert.rejects(rejection.operations.invokeOperation('leaveGroup', { groupId: '123' }), {
        code,
      });
      assert.equal(attempts, 1);
    } finally {
      rejection.lifetime.close();
    }
  }
  return {
    groupOperationContract: true,
    actionPortRetirementContract: true,
    actionPortPendingCloseContract: true,
    actionPortLateFailureObserved: true,
    nativeExecuted: false,
    accountUsed: false,
  };
}
