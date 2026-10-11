import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFriendRequests,
  type FriendBuddyListener,
} from '../src/features/contacts/friend-requests.ts';
import {
  createGroupRequests,
  type GroupRequestListener,
} from '../src/features/groups/group-requests.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';

const methods = [
  'getBuddyReq',
  'approvalFriendRequest',
  'getSingleScreenNotifies',
  'operateSysNotify',
] as const;
for (const method of methods) {
  for (const mode of [
    'changing-zero',
    'changing-throw',
    'throw',
    'abort',
    'success',
    'void',
    'string-code',
    'malformed',
  ] as const) {
    test(`${method}: ${mode} native result is captured once`, async () => {
      const lifetime = new NativeServiceLifetime();
      const original = Error('result getter original');
      let reads = 0,
        calls = 0;
      let friendListener: FriendBuddyListener | undefined;
      let groupListener: GroupRequestListener | undefined;
      const result =
        mode === 'void'
          ? undefined
          : {
              get secret() {
                return assert.fail('unrelated native accessor must not be read');
              },
              get result() {
                reads++;
                if (mode === 'throw' || (mode === 'changing-throw' && reads > 1)) throw original;
                if (mode === 'abort') {
                  lifetime.close();
                  return 7;
                }
                if (mode === 'success') return 0;
                if (mode === 'string-code') return 'DENIED';
                if (mode === 'malformed') return NaN;
                return reads === 1 ? 7 : 0;
              },
            };
      const returned = () => {
        calls++;
        if (method === 'getBuddyReq') friendListener?.onBuddyReqChange({ buddyReqs: [] });
        if (method === 'getSingleScreenNotifies')
          groupListener?.onGroupSingleScreenNotifies(false, '', []);
        return result;
      };
      const friend = createFriendRequests({
        signal: lifetime.signal,
        awaitAlive: lifetime.awaitAlive,
        emit() {},
        getBuddyService: () => ({
          addKernelBuddyListener(value) {
            friendListener = value;
            return 'friend-id';
          },
          removeKernelBuddyListener() {},
          getBuddyReq: returned,
          approvalFriendRequest: returned,
        }),
      });
      const group = createGroupRequests({
        signal: lifetime.signal,
        awaitAlive: lifetime.awaitAlive,
        emit() {},
        getGroupService: () => ({
          addKernelGroupListener(value) {
            groupListener = value;
            return 'group-id';
          },
          removeKernelGroupListener() {},
          getSingleScreenNotifies: returned,
          operateSysNotify: returned,
        }),
      });
      const list = method === 'getBuddyReq' || method === 'getSingleScreenNotifies';
      const run = () => {
        switch (method) {
          case 'getBuddyReq':
            return friend.invokeOperation('listFriendRequests');
          case 'approvalFriendRequest':
            return friend.invokeOperation('handleFriendRequest', {
              request: { uid: 'u_friend', time: '0' },
              accept: true,
            });
          case 'getSingleScreenNotifies':
            return group.invokeOperation('listGroupRequests');
          case 'operateSysNotify':
            return group.invokeOperation('handleGroupRequest', {
              request: { groupId: '0', sequence: '0', type: 7, doubt: false },
              accept: false,
            });
        }
      };
      try {
        if (mode === 'success' || (mode === 'void' && !list)) await run();
        else {
          await assert.rejects(
            run(),
            mode === 'throw'
              ? (error) => error === original
              : mode === 'abort'
                ? /closed|abort/i
                : {
                    code:
                      mode === 'string-code'
                        ? 'DENIED'
                        : mode === 'malformed' || mode === 'void'
                          ? 'invalid-result'
                          : 7,
                  },
          );
        }
        assert.equal(reads, mode === 'void' ? 0 : 1);
        assert.equal(calls, 1);
        if (list && mode !== 'success' && mode !== 'abort') {
          await assert.rejects(run(), /invalid|closed/i);
          assert.equal(calls, 1, 'failed list is quarantined rather than replayed');
        }
      } finally {
        friend.close();
        group.close();
        lifetime.close();
      }
    });
  }
}
