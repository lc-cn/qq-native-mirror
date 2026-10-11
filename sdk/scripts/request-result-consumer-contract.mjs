import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Installed request owners with controlled native ports. No addon, account or
 * remote approval is used; early callbacks alone never establish list success.
 * @param {string} packageRoot
 */
export async function verifyRequestResultConsumer(packageRoot) {
  /** @type {Promise<typeof import('../src/features/contacts/friend-requests.ts')>} */
  const contacts = import(
    pathToFileURL(join(packageRoot, 'dist/features/contacts/friend-requests.js')).href
  );
  /** @type {Promise<typeof import('../src/features/groups/group-requests.ts')>} */
  const groups = import(
    pathToFileURL(join(packageRoot, 'dist/features/groups/group-requests.js')).href
  );
  const [{ createFriendRequests }, { createGroupRequests }] = await Promise.all([contacts, groups]);

  for (const method of /** @type {const} */ (['listFriendRequests', 'handleFriendRequest'])) {
    for (const retirement of [false, true]) {
      let calls = 0;
      let reads = 0;
      let removed = 0;
      /** @type {import('../src/features/contacts/friend-requests.ts').FriendBuddyListener | undefined} */
      let listener;
      const result = {
        get result() {
          reads++;
          if (retirement) operations.close();
          return reads === 1 ? 7 : 0;
        },
        get credential() {
          throw new Error('Opaque native fields must not be read');
        },
      };
      const operations = createFriendRequests({
        signal: new AbortController().signal,
        awaitAlive: async (value) => value,
        emit() {},
        getBuddyService: () => ({
          addKernelBuddyListener(value) {
            listener = value;
            return 1;
          },
          removeKernelBuddyListener(id) {
            assert.equal(id, 1);
            removed++;
          },
          getBuddyReq() {
            calls++;
            assert.ok(listener);
            listener.onBuddyReqChange({ buddyReqs: [] });
            return result;
          },
          approvalFriendRequest() {
            calls++;
            return result;
          },
        }),
      });
      try {
        await assert.rejects(
          operations.invokeOperation(method, {
            request: { uid: 'u_fixture', time: '123' },
            accept: true,
          }),
          retirement ? /Friend request service is closed/ : { code: 7 },
        );
        assert.equal(reads, 1);
        assert.equal(calls, 1);
        if (method === 'listFriendRequests' && !retirement) {
          await assert.rejects(operations.invokeOperation(method), /query channel is invalid/);
          assert.equal(calls, 1, 'Failed uncorrelated queries cannot dispatch again');
        }
      } finally {
        operations.close();
      }
      assert.equal(removed, 1);
    }
  }

  for (const method of /** @type {const} */ (['listGroupRequests', 'handleGroupRequest'])) {
    for (const retirement of [false, true]) {
      let calls = 0;
      let reads = 0;
      let removed = 0;
      /** @type {import('../src/features/groups/group-requests.ts').GroupRequestListener | undefined} */
      let listener;
      const result = {
        get result() {
          reads++;
          if (retirement) operations.close();
          return reads === 1 ? 7 : 0;
        },
        get credential() {
          throw new Error('Opaque native fields must not be read');
        },
      };
      const operations = createGroupRequests({
        signal: new AbortController().signal,
        awaitAlive: async (value) => value,
        emit() {},
        getGroupService: () => ({
          addKernelGroupListener(value) {
            listener = value;
            return 1;
          },
          removeKernelGroupListener(id) {
            assert.equal(id, 1);
            removed++;
          },
          getSingleScreenNotifies() {
            calls++;
            assert.ok(listener);
            listener.onGroupSingleScreenNotifies(false, '', []);
            return result;
          },
          operateSysNotify() {
            calls++;
            return result;
          },
        }),
      });
      try {
        await assert.rejects(
          operations.invokeOperation(method, {
            request: { groupId: '123', sequence: '456', type: 7, doubt: false },
            accept: true,
          }),
          retirement ? /Group request service is closed/ : { code: 7 },
        );
        assert.equal(reads, 1);
        assert.equal(calls, 1);
        if (method === 'listGroupRequests' && !retirement) {
          await assert.rejects(operations.invokeOperation(method), /query channel is invalid/);
          assert.equal(calls, 1, 'Failed uncorrelated queries cannot dispatch again');
        }
      } finally {
        operations.close();
      }
      assert.equal(removed, 1);
    }
  }
  return {
    requestResultSingleCaptureContract: true,
    requestResultRetirementBeforeDecisionContract: true,
    requestResultEarlyNotificationFailureContract: true,
    requestResultFailedQueryQuarantineContract: true,
    requestResultListenerRemovalContract: true,
    nativeRequestAttempted: false,
    accountUsed: false,
  };
}
