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
    assert.equal(acquisitions, 0);
    assert.equal(callbackRequests, 0);
  } finally {
    preflight.close();
  }

  /** @type {('getGroupInfo' | 'listGroupMutedMembers' | 'listGroups' | 'getGroupMembers')[]} */
  const pendingMethods = [...identityMethods, 'listGroups'];
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
    const pending = method === 'listGroups' ? queries.listGroups() : queries[method]('000123');
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
    nativeGroupQueryAttempted: false,
  };
}
