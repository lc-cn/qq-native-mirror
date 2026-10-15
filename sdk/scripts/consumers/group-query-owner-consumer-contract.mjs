import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Verify the installed query owner with controlled native services.
 * The shared callback channel is real; no QQ addon or account is used.
 * @param {string} packageRoot
 */
export async function verifyGroupQueryOwnerConsumer(packageRoot) {
  /** @type {Promise<typeof import('../../src/features/groups/group-queries.ts')>} */
  const queryModule = import(
    pathToFileURL(join(packageRoot, 'dist/features/groups/group-queries.js')).href
  );
  /** @type {Promise<typeof import('../../src/runtime/native-event-channel.ts')>} */
  const channelModule = import(
    pathToFileURL(join(packageRoot, 'dist/runtime/native-event-channel.js')).href
  );
  const [{ createGroupQueries }, { createNativeEventChannel }] = await Promise.all([
    queryModule,
    channelModule,
  ]);
  await verifyMemberSnapshots(createGroupQueries);
  /** @type {('getGroupInfo' | 'listGroupMutedMembers' | 'getGroupMembers')[]} */
  const identityMethods = ['getGroupInfo', 'listGroupMutedMembers', 'getGroupMembers'];
  const account = new AbortController();
  let acquisitions = 0;
  let callbackRequests = 0;
  const preflight = createGroupQueries({
    signal: account.signal,
    getGroupService() {
      acquisitions++;
      throw new Error('Invalid input reached service acquisition');
    },
    eventCall() {
      callbackRequests++;
      throw new Error('Invalid input reached callback registration');
    },
    awaitAlive: async (value) => value,
    commitMembers() {
      assert.fail('Invalid input must not update identity storage');
    },
  });
  try {
    for (const method of identityMethods)
      for (const id of ['', '0000', ' 1', '1*', 123, null])
        await assert.rejects(preflight[method](id), { message: 'Invalid send group identifier' });
    for (const userId of ['', '0000', ' 1', 'u_member', 123, null])
      await assert.rejects(preflight.getGroupMember('123', userId));
    assert.equal(acquisitions, 0);
    assert.equal(callbackRequests, 0);
  } finally {
    preflight.close();
  }

  /** @type {('getGroupInfo' | 'listGroupMutedMembers' | 'listGroups' | 'getGroupMembers' | 'getGroupMember')[]} */
  const pendingMethods = [...identityMethods, 'listGroups', 'getGroupMember'];
  for (const method of pendingMethods) {
    const channel = createNativeEventChannel(account.signal);
    /** @type {(reason: unknown) => void} */
    let rejectNative = () => {
      assert.fail('Native dispatch was not captured');
    };
    let dispatches = 0;
    const request = () => {
      dispatches++;
      return new Promise((_, reject) => {
        rejectNative = reject;
      });
    };
    const queries = createGroupQueries({
      signal: account.signal,
      getGroupService: () => ({
        getGroupDetailInfo: request,
        getGroupShutUpMemberList: request,
        getGroupList: request,
        getAllMemberList: request,
      }),
      eventCall: channel.call,
      awaitAlive: async (value) => value,
      commitMembers() {
        assert.fail('A retired query must not update identity storage');
      },
    });
    const pending =
      method === 'listGroups'
        ? queries.listGroups()
        : method === 'getGroupMember'
          ? queries.getGroupMember('000123', '456')
          : queries[method]('000123');
    const observed = pending.then(
      () => 'fulfilled',
      (error) => {
        assert.match(String(error), /closed/i);
        return 'closed';
      },
    );
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    try {
      queries.close();
      const outcome = await Promise.race([
        observed,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('deadline'), 200);
        }),
      ]);
      assert.equal(outcome, 'closed', 'Local close must settle before native completion');
      assert.equal(account.signal.aborted, false);
      assert.equal(
        await channel.call(
          'fixture/sibling',
          (value) => (value === 'ready' ? 'ready' : undefined),
          () => {
            channel.dispatch('fixture/sibling', ['ready']);
          },
          200,
        ),
        'ready',
      );
      rejectNative(new Error('fixture late native rejection'));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(dispatches, 1);
    } finally {
      if (timer) clearTimeout(timer);
      queries.close();
      rejectNative(new Error('fixture teardown rejection'));
      channel.close();
      await observed;
    }
  }
  return {
    groupQueryInputOwnerContract: true,
    groupQueryLocalCloseContract: true,
    groupQuerySharedChannelContract: true,
    groupMemberSnapshotContract: true,
    nativeGroupQueryAttempted: false,
  };
}

/** A selected member must come from a complete, unambiguous native snapshot.
 * @param {typeof import('../../src/features/groups/group-queries.ts').createGroupQueries} createGroupQueries
 */
async function verifyMemberSnapshots(createGroupQueries) {
  const account = new AbortController();
  /** @type {unknown} */
  let result;
  /** @type {unknown[][]} */
  const calls = [];
  let commits = 0;
  const nativeMember = {
    uid: 'u_member',
    uin: '9007199254740993',
    nick: 'member',
    cardName: 'project admin',
    role: 3,
  };
  const queries = createGroupQueries({
    signal: account.signal,
    getGroupService: () => ({
      getAllMemberList(...args) {
        calls.push(args);
        return result;
      },
    }),
    eventCall() {
      assert.fail('Member reads use the complete native result, not an unrelated callback');
    },
    awaitAlive: async (value) => value,
    commitMembers() {
      commits++;
    },
  });
  try {
    result = {
      errCode: 0,
      result: { finish: true, infos: new Map([[nativeMember.uid, nativeMember]]) },
    };
    assert.deepEqual(await queries.getGroupMember('000123', '09007199254740993', true), {
      userId: nativeMember.uin,
      uid: nativeMember.uid,
      nickname: nativeMember.nick,
      card: nativeMember.cardName,
      role: 'admin',
    });
    assert.equal(await queries.getGroupMember('000123', '9007199254740992', false), undefined);
    assert.deepEqual(calls, [
      ['000123', true],
      ['000123', false],
    ]);
    assert.equal(commits, 2);
    for (const invalid of [
      { errCode: 71 },
      { errCode: 0, result: { finish: false, infos: new Map() } },
      {
        errCode: 0,
        result: {
          finish: true,
          infos: new Map([
            [nativeMember.uid, nativeMember],
            ['u_duplicate', { ...nativeMember, uid: 'u_duplicate', uin: '09007199254740993' }],
          ]),
        },
      },
    ]) {
      result = invalid;
      await assert.rejects(queries.getGroupMember('123', nativeMember.uin));
      assert.equal(commits, 2, 'An invalid complete list must not update identity storage');
    }
    result = { errCode: 0, result: { finish: true, infos: new Map() } };
    assert.equal(await queries.getGroupMember('123', nativeMember.uin), undefined);
    assert.equal(commits, 3);
  } finally {
    queries.close();
  }
}
