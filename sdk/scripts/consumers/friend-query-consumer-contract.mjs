import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Verify installed friend and group query composition with controlled services.
 * No QQ addon, native query or account is used.
 * @param {string} packageRoot
 */
export async function verifyFriendQueryConsumer(packageRoot) {
  const { createNativeServices } =
    await /** @type {Promise<typeof import('../../src/native-services.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/native-services.js')).href)
    );
  for (const [result, code] of [
    [-1, -1],
    [73, 73],
    ['denied', 'denied'],
    [undefined, 'invalid-result'],
    [NaN, 'invalid-result'],
  ])
    for (const data of [[], [{ buddyUids: ['u_fixture'] }]]) {
      let buddyCalls = 0,
        profileCalls = 0;
      const query = createNativeServices({
        session: {
          getMsgService: () => ({ addKernelMsgListener() {} }),
          getGroupService: () => ({ addKernelGroupListener() {} }),
          getBuddyService: () => ({
            addKernelBuddyListener() {},
            getBuddyListV2() {
              buddyCalls++;
              return { result, data };
            },
          }),
          getProfileService: () => ({
            getCoreAndBaseInfo() {
              profileCalls++;
              throw Error('Unexpected profile query');
            },
          }),
        },
        version: '7.0.2-53644',
        events: { emit: () => {} },
      });
      try {
        await assert.rejects(query.invokeOperation('listFriends'), { code });
        assert.equal(buddyCalls, 1);
        assert.equal(profileCalls, 0);
      } finally {
        query.close();
      }
    }
  // Sparse native arrays must not become a valid empty list.
  for (const data of [Array(1), [{ buddyUids: Array(1) }]]) {
    let profileCalls = 0;
    const query = createNativeServices({
      session: {
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getBuddyService: () => ({
          addKernelBuddyListener() {},
          getBuddyListV2() {
            return { result: 0, data };
          },
        }),
        getProfileService: () => ({
          getCoreAndBaseInfo() {
            profileCalls++;
            return new Map();
          },
        }),
      },
      version: '7.0.2-53644',
      events: { emit: () => {} },
    });
    try {
      await assert.rejects(query.invokeOperation('listFriends'), /Invalid native buddy/);
      assert.equal(profileCalls, 0);
    } finally {
      query.close();
    }
  }
  // A failed row must leave no usable UID cache entry from preceding rows.
  let conversions = 0;
  const atomic = createNativeServices({
    session: {
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getBuddyService: () => ({
        addKernelBuddyListener() {},
        getBuddyListV2() {
          return { result: 0, data: [{ buddyUids: ['u_partial', 'u_bad'] }] };
        },
      }),
      getProfileService: () => ({
        getCoreAndBaseInfo() {
          return new Map([
            [
              'u_partial',
              { coreInfo: { uid: 'u_partial', uin: '456', nick: 'fixture', remark: '' } },
            ],
            ['u_bad', {}],
          ]);
        },
      }),
      getUixConvertService: () => ({
        /** @param {Parameters<NonNullable<import('../../src/features/contacts/contact-directory.ts').UidDirectoryPort['getUid']>>[0]} ids */
        getUid(ids) {
          assert.deepEqual(ids, ['456']);
          conversions++;
          return { uidInfo: new Map() };
        },
      }),
    },
    version: '7.0.2-53644',
    events: { emit: () => {} },
  });
  try {
    await assert.rejects(atomic.invokeOperation('listFriends'), /Invalid native buddy profile/);
    await assert.rejects(
      atomic.invokeOperation('sendPrivateMessage', { userId: '456', message: 'fixture' }),
      /Could not resolve user identifier/,
    );
    assert.equal(conversions, 1);
  } finally {
    atomic.close();
  }
  // Preserve deduplication, category order and lossless long decimal IDs.
  const complete = createNativeServices({
    session: {
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getBuddyService: () => ({
        addKernelBuddyListener() {},
        getBuddyListV2() {
          return {
            result: 0,
            data: [{ buddyUids: ['u_first', 'u_second'] }, { buddyUids: ['u_first'] }],
          };
        },
      }),
      getProfileService: () => ({
        /**
         * @param {Parameters<NonNullable<import('../../src/features/contacts/contact-directory.ts').ProfileDirectoryPort['getCoreAndBaseInfo']>>[0]} store
         * @param {Parameters<NonNullable<import('../../src/features/contacts/contact-directory.ts').ProfileDirectoryPort['getCoreAndBaseInfo']>>[1]} uids
         */
        getCoreAndBaseInfo(store, uids) {
          assert.deepEqual([store, uids], ['nodeStore', ['u_first', 'u_second']]);
          return new Map([
            [
              'u_first',
              {
                coreInfo: {
                  uid: 'u_first',
                  uin: '900719925474099312345',
                  nick: 'first',
                  remark: '',
                },
              },
            ],
            [
              'u_second',
              { coreInfo: { uid: 'u_second', uin: '456', nick: 'second', remark: 'remark' } },
            ],
          ]);
        },
      }),
    },
    version: '7.0.2-53644',
    events: { emit: () => {} },
  });
  try {
    assert.deepEqual(await complete.invokeOperation('listFriends'), [
      { userId: '900719925474099312345', uid: 'u_first', nickname: 'first', remark: '' },
      { userId: '456', uid: 'u_second', nickname: 'second', remark: 'remark' },
    ]);
  } finally {
    complete.close();
  }
  // Friend profile identity/display fields must already have their declared types.
  const validCore = { uid: 'u_friend', uin: '900719925474099312345', nick: 'friend', remark: '' };
  for (const change of [
    { uin: 456 },
    {
      uin: {
        toString() {
          throw Error('Coercion must not run');
        },
      },
    },
    { nick: {} },
    { nick: null },
    { remark: 12 },
    { uid: 'u_other' },
    { uid: undefined },
    { remark: undefined },
  ]) {
    const query = createNativeServices({
      session: {
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getBuddyService: () => ({
          addKernelBuddyListener() {},
          getBuddyListV2() {
            return { result: 0, data: [{ buddyUids: ['u_friend'] }] };
          },
        }),
        getProfileService: () => ({
          getCoreAndBaseInfo() {
            return new Map([['u_friend', { coreInfo: { ...validCore, ...change } }]]);
          },
        }),
      },
      version: '7.0.2-53644',
      events: { emit: () => {} },
    });
    try {
      await assert.rejects(query.invokeOperation('listFriends'), /Invalid native buddy profile/);
    } finally {
      query.close();
    }
  }
  const omittedNick = createNativeServices({
    session: {
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getBuddyService: () => ({
        addKernelBuddyListener() {},
        getBuddyListV2() {
          return { result: 0, data: [{ buddyUids: ['u_friend'] }] };
        },
      }),
      getProfileService: () => ({
        getCoreAndBaseInfo() {
          return new Map([['u_friend', { coreInfo: { ...validCore, nick: undefined } }]]);
        },
      }),
    },
    version: '7.0.2-53644',
    events: { emit: () => {} },
  });
  try {
    assert.deepEqual(await omittedNick.invokeOperation('listFriends'), [
      { userId: validCore.uin, uid: 'u_friend', nickname: '', remark: '' },
    ]);
  } finally {
    omittedNick.close();
  }
  // Full group callbacks reject malformed batches and retire their uncorrelated query.
  const group = {
    groupCode: '900719925474099312345',
    groupName: 'group',
    memberCount: 2,
    maxMember: 100,
  };
  /** @param {unknown} groups */
  function groupFixture(groups) {
    /** @type {Pick<ReturnType<typeof import('../../src/features/groups/group-events.ts').createGroupEvents>, 'onGroupListUpdate'>[]} */
    const listeners = [];
    let calls = 0;
    const query = createNativeServices({
      session: {
        getMsgService: () => ({ addKernelMsgListener() {} }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getGroupService: () => ({
          /** @param {Pick<ReturnType<typeof import('../../src/features/groups/group-events.ts').createGroupEvents>, 'onGroupListUpdate'>} value */
          addKernelGroupListener(value) {
            listeners.push(value);
          },
          getGroupList() {
            calls++;
            for (const listener of listeners) listener.onGroupListUpdate?.(1, groups);
            return { result: 0 };
          },
        }),
      },
      version: '7.0.2-53644',
      events: { emit: () => {} },
    });
    return { query, calls: () => calls };
  }
  for (const groups of [
    Array(1),
    [{ ...group, groupCode: undefined }],
    [{ ...group, groupCode: 123 }],
    [{ ...group, groupName: { secret: true } }],
    [{ ...group, memberCount: -1 }],
    [{ ...group, memberCount: 1.5 }],
    [{ ...group, memberCount: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...group, maxMember: '100' }],
    [{ ...group, maxMember: Infinity }],
  ]) {
    const { query, calls } = groupFixture(groups);
    try {
      await assert.rejects(query.invokeOperation('listGroups'), /Invalid native group list/);
      await assert.rejects(query.invokeOperation('listGroups'), /channel invalidated/);
      assert.equal(calls(), 1);
    } finally {
      query.close();
    }
  }
  for (const groups of [[], [group]]) {
    const { query, calls } = groupFixture(groups);
    try {
      assert.deepEqual(
        await query.invokeOperation('listGroups'),
        groups.map((g) => ({
          groupId: g.groupCode,
          name: g.groupName,
          memberCount: g.memberCount,
          maxMemberCount: g.maxMember,
        })),
      );
      assert.equal(calls(), 1);
    } finally {
      query.close();
    }
  }
  let successCalls = 0;
  const success = createNativeServices({
    session: {
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getBuddyService: () => ({
        addKernelBuddyListener() {},
        getBuddyListV2() {
          successCalls++;
          return { result: 0, data: [] };
        },
      }),
      getProfileService: () => ({
        getCoreAndBaseInfo() {
          return new Map();
        },
      }),
    },
    version: '7.0.2-53644',
    events: { emit: () => {} },
  });
  try {
    assert.deepEqual(await success.invokeOperation('listFriends'), []);
    assert.equal(successCalls, 1);
  } finally {
    success.close();
  }
  return {
    friendListQueryContract: true,
    friendListBatchContract: true,
    friendProfileQueryContract: true,
    groupListQueryContract: true,
    nativeFriendListQueryAttempted: false,
    nativeGroupListQueryAttempted: false,
    accountUsed: false,
  };
}
