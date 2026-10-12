import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFriendRequests,
  type FriendBuddyListener,
  type FriendBuddyPort,
} from '../src/features/contacts/friend-requests.ts';
import {
  createGroupRequests,
  type GroupRequestListener,
  type GroupRequestPort,
} from '../src/features/groups/group-requests.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';

type Family = 'friend' | 'group';
type Action = 'list' | 'handle';
type Retirement = 'local' | 'account' | 'active';
function fixture(
  family: Family,
  action: Action,
  stage: 'result' | 'method',
  retirement: Retirement,
) {
  const account = new NativeServiceLifetime();
  const thrown = Object.freeze({ opaque: 'getter failure' });
  let owner: { close(): void };
  let waitSignal: AbortSignal | undefined;
  let armed = false;
  let calls = 0;
  let reads = 0;
  const retireAndThrow = () => {
    reads++;
    if (retirement === 'local') owner.close();
    if (retirement === 'account') account.close();
    throw thrown;
  };
  const result = () => {
    if (!armed || stage !== 'result') return { result: 0 };
    return {
      get result(): never {
        return retireAndThrow();
      },
    };
  };
  const awaitAlive = <T>(value: T | PromiseLike<T>, signal?: AbortSignal) => {
    waitSignal = signal;
    return account.awaitAlive(value, signal);
  };
  const approvalPayload =
    family === 'friend'
      ? { request: { uid: 'u_fixture', time: '123' }, accept: true }
      : { request: { groupId: '456', sequence: '123', type: 1, doubt: false }, accept: true };
  let invoke: (action: Action) => Promise<unknown>;
  if (family === 'friend') {
    let listener: FriendBuddyListener;
    const service: FriendBuddyPort = {
      addKernelBuddyListener(value) {
        listener = value;
        return 1;
      },
      removeKernelBuddyListener() {},
      get getBuddyReq() {
        if (armed && action === 'list' && stage === 'method') return retireAndThrow();
        return () => {
          calls++;
          listener.onBuddyReqChange({ buddyReqs: [] });
          return result();
        };
      },
      get approvalFriendRequest() {
        if (armed && action === 'handle' && stage === 'method') return retireAndThrow();
        return () => {
          calls++;
          return result();
        };
      },
    };
    const operations = createFriendRequests({
      signal: account.signal,
      awaitAlive,
      emit() {},
      getBuddyService: () => service,
    });
    owner = operations;
    invoke = (action) =>
      operations.invokeOperation(
        action === 'list' ? 'listFriendRequests' : 'handleFriendRequest',
        action === 'list' ? {} : approvalPayload,
      );
  } else {
    let listener: GroupRequestListener;
    const service: GroupRequestPort = {
      addKernelGroupListener(value) {
        listener = value;
        return 1;
      },
      removeKernelGroupListener() {},
      get getSingleScreenNotifies() {
        if (armed && action === 'list' && stage === 'method') return retireAndThrow();
        return () => {
          calls++;
          listener.onGroupSingleScreenNotifies(false, '', []);
          return result();
        };
      },
      get operateSysNotify() {
        if (armed && action === 'handle' && stage === 'method') return retireAndThrow();
        return () => {
          calls++;
          return result();
        };
      },
    };
    const operations = createGroupRequests({
      signal: account.signal,
      awaitAlive,
      emit() {},
      getGroupService: () => service,
    });
    owner = operations;
    invoke = (action) =>
      operations.invokeOperation(
        action === 'list' ? 'listGroupRequests' : 'handleGroupRequest',
        action === 'list' ? {} : approvalPayload,
      );
  }
  return {
    thrown,
    async run() {
      // A completed approval captures the real local wait signal without a
      // pending request or query cache, making exact local reason observable.
      await invoke('handle');
      armed = true;
      calls = 0;
      reads = 0;
      return invoke(action);
    },
    reason: () => (retirement === 'account' ? account.signal.reason : waitSignal?.reason),
    counts: () => ({ calls, reads }),
    close() {
      owner.close();
      account.close();
    },
  };
}
for (const family of ['friend', 'group'] as const) {
  for (const action of ['list', 'handle'] as const) {
    for (const stage of ['result', 'method'] as const) {
      for (const retirement of ['local', 'account', 'active'] as const) {
        test(`${family} ${action} ${stage} getter ${retirement} preserves selected failure identity`, async () => {
          const f = fixture(family, action, stage, retirement);
          try {
            await assert.rejects(f.run(), (error: unknown) => {
              assert.deepEqual(f.counts(), { calls: stage === 'result' ? 1 : 0, reads: 1 });
              assert.equal(error, retirement === 'active' ? f.thrown : f.reason());
              return true;
            });
            assert.deepEqual(f.counts(), { calls: stage === 'result' ? 1 : 0, reads: 1 });
          } finally {
            f.close();
          }
        });
      }
    }
  }
}

for (const family of ['friend', 'group'] as const) {
  for (const stage of ['service', 'add-getter'] as const) {
    test(`${family} constructor ${stage} abort and throw retains account reason before registration`, () => {
      const account = new NativeServiceLifetime();
      const thrown = Object.freeze({ opaque: 'constructor getter failure' });
      let serviceReads = 0;
      let addReads = 0;
      let registrations = 0;
      let laterReads = 0;
      const fail = (): never => {
        account.close();
        throw thrown;
      };
      try {
        if (family === 'friend') {
          const service: FriendBuddyPort = {
            get addKernelBuddyListener() {
              addReads++;
              if (stage === 'add-getter') return fail();
              return () => {
                registrations++;
                return 1;
              };
            },
            get getBuddyReq() {
              laterReads++;
              return () => ({ result: 0 });
            },
          };
          assert.throws(
            () =>
              createFriendRequests({
                signal: account.signal,
                awaitAlive: account.awaitAlive,
                emit() {},
                getBuddyService() {
                  serviceReads++;
                  if (stage === 'service') return fail();
                  return service;
                },
              }),
            (error: unknown) => error === account.signal.reason,
          );
        } else {
          const service: GroupRequestPort = {
            get addKernelGroupListener() {
              addReads++;
              if (stage === 'add-getter') return fail();
              return () => {
                registrations++;
                return 1;
              };
            },
            get getSingleScreenNotifies() {
              laterReads++;
              return () => ({ result: 0 });
            },
          };
          assert.throws(
            () =>
              createGroupRequests({
                signal: account.signal,
                awaitAlive: account.awaitAlive,
                emit() {},
                getGroupService() {
                  serviceReads++;
                  if (stage === 'service') return fail();
                  return service;
                },
              }),
            (error: unknown) => error === account.signal.reason,
          );
        }
        assert.equal(serviceReads, 1);
        assert.equal(addReads, stage === 'service' ? 0 : 1);
        assert.equal(registrations, 0);
        assert.equal(laterReads, 0);
        assert.notEqual(account.signal.reason, thrown);
      } finally {
        account.close();
      }
    });
  }
}
