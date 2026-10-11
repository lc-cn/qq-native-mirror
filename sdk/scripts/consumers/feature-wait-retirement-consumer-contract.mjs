import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Verify installed feature and account waits retire together using fake native ports.
 * @param {string} packageRoot
 */
export async function verifyFeatureWaitRetirementConsumer(packageRoot) {
  const { NativeServiceLifetime } =
    await /** @type {Promise<typeof import('../../src/runtime/native-service-lifetime.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/runtime/native-service-lifetime.js')).href)
    );
  const { createFriendRequests } =
    await /** @type {Promise<typeof import('../../src/features/contacts/friend-requests.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/features/contacts/friend-requests.js')).href)
    );
  const { createGroupRequests } =
    await /** @type {Promise<typeof import('../../src/features/groups/group-requests.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/features/groups/group-requests.js')).href)
    );
  const { createGroupQueries } =
    await /** @type {Promise<typeof import('../../src/features/groups/group-queries.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/features/groups/group-queries.js')).href)
    );
  const { createSelfProfile } =
    await /** @type {Promise<typeof import('../../src/features/contacts/self-profile.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/features/contacts/self-profile.js')).href)
    );
  for (const name of ['friend-approval', 'group-approval', 'group-members', 'self-uid']) {
    const account = new NativeServiceLifetime();
    /** @type {(reason: unknown) => void} */
    let rejectLate = () => {};
    /** @type {Promise<string>} */
    const native = new Promise((_, reject) => {
      rejectLate = reject;
    });
    let calls = 0,
      removals = 0,
      waitsSettled = 0;
    /** @type {AbortSignal | undefined} */
    let requestSignal;
    const dispatch = () => {
      calls++;
      return native;
    };
    const common = {
      signal: account.signal,
      /** @template T @param {T | PromiseLike<T>} value @param {AbortSignal} [signal] */
      awaitAlive(value, signal) {
        requestSignal = signal;
        const pending = account.awaitAlive(value, signal);
        void pending.then(
          () => {
            waitsSettled++;
          },
          () => {
            waitsSettled++;
          },
        );
        return pending;
      },
    };
    /** @type {{ close(): void }} */
    let owner;
    /** @type {Promise<unknown>} */
    let result;
    if (name === 'friend-approval') {
      const requests = createFriendRequests({
        ...common,
        emit() {},
        getBuddyService: () => ({
          addKernelBuddyListener: () => 1,
          removeKernelBuddyListener() {
            removals++;
          },
          approvalFriendRequest: dispatch,
        }),
      });
      owner = requests;
      result = requests.invokeOperation('handleFriendRequest', {
        request: { uid: 'u_fixture', time: '42' },
        accept: true,
      });
    } else if (name === 'group-approval') {
      const requests = createGroupRequests({
        ...common,
        emit() {},
        getGroupService: () => ({
          addKernelGroupListener: () => 1,
          removeKernelGroupListener() {
            removals++;
          },
          operateSysNotify: dispatch,
        }),
      });
      owner = requests;
      result = requests.invokeOperation('handleGroupRequest', {
        request: { groupId: '123', sequence: '42', type: 1, doubt: false },
        accept: true,
      });
    } else if (name === 'group-members') {
      const queries = createGroupQueries({
        ...common,
        getGroupService: () => ({ getAllMemberList: dispatch }),
        eventCall() {
          assert.fail('Member reads must not register a callback query');
        },
        commitMembers() {
          assert.fail('Retired members cannot update identities');
        },
      });
      owner = queries;
      result = queries.getGroupMembers('123');
    } else {
      const profile = createSelfProfile({
        ...common,
        resolveSelfUid: dispatch,
        getProfileService() {
          assert.fail('Retired UID lookup cannot acquire Profile');
        },
      });
      owner = profile;
      result = profile.invokeOperation('setNickname', { name: 'fixture' });
    }
    const stopped = assert.rejects(result, /closed/);
    void stopped.catch(() => {});
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      assert.equal(waitsSettled, 0);
      owner.close();
      owner.close();
      await stopped;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(waitsSettled, 1, 'Account wait must settle before native completes');
      assert.ok(requestSignal);
      assert.equal(requestSignal.aborted, true);
      assert.equal(getEventListeners(account.signal, 'abort').length, 0);
      assert.equal(await account.awaitAlive(Promise.resolve('sibling')), 'sibling');
      assert.equal(removals, name.endsWith('approval') ? 1 : 0);
    } finally {
      rejectLate(new Error('Controlled late native failure'));
      owner.close();
      account.close();
      await stopped;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return {
    featureAccountWaitRetirementContract: true,
    featureRetirementSiblingPreserved: true,
    featureRetirementLateFailureObserved: true,
    nativeFeatureActionAttempted: false,
    accountUsed: false,
  };
}
