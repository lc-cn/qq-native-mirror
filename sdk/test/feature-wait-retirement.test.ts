import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { createFriendRequests } from '../src/features/contacts/friend-requests.ts';
import { createSelfProfile } from '../src/features/contacts/self-profile.ts';
import { createGroupQueries } from '../src/features/groups/group-queries.ts';
import { createGroupRequests } from '../src/features/groups/group-requests.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';

const names = ['friend-approval', 'group-approval', 'group-members', 'self-uid'] as const;
type OwnerName = (typeof names)[number];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(name: OwnerName, legacy = false) {
  const account = new NativeServiceLifetime();
  let resolveLate!: (value: string) => void;
  let rejectLate!: (reason: unknown) => void;
  const native = new Promise<string>((resolve, reject) => {
    resolveLate = resolve;
    rejectLate = reject;
  });
  let calls = 0;
  let removals = 0;
  let waitsStarted = 0;
  let waitsSettled = 0;
  let requestSignal: AbortSignal | undefined;
  const dispatch = () => {
    calls++;
    return native;
  };
  const common = {
    signal: account.signal,
    awaitAlive<T>(value: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
      waitsStarted++;
      requestSignal = signal;
      const pending = legacy ? Promise.resolve(value) : account.awaitAlive(value, signal);
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
  let owner: { close(): void }, result: Promise<unknown>;
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
        assert.fail('Member lookup must not register a callback query');
      },
      commitMembers() {
        assert.fail('A retired member query cannot commit identities');
      },
    });
    owner = queries;
    result = queries.getGroupMembers('123');
  } else {
    const profile = createSelfProfile({
      ...common,
      resolveSelfUid: dispatch,
      getProfileService() {
        assert.fail('Retired UID resolution must not acquire Profile');
      },
    });
    owner = profile;
    result = profile.invokeOperation('setNickname', { name: 'fixture' });
  }
  return {
    account,
    owner,
    result,
    resolveLate,
    rejectLate,
    counts: () => ({ calls, removals, waitsStarted, waitsSettled }),
    waitSignal: () => requestSignal,
  };
}

for (const name of names)
  for (const completion of ['resolve', 'reject'] as const)
    test(`${name} close releases account wait before native ${completion}`, async () => {
      const f = fixture(name);
      const stopped = assert.rejects(f.result, /closed/);
      void stopped.catch(() => {});
      try {
        await tick();
        assert.equal(f.counts().calls, 1);
        assert.equal(f.counts().waitsStarted, 1);
        assert.equal(f.counts().waitsSettled, 0);
        f.owner.close();
        f.owner.close();
        await stopped;
        await tick();
        assert.equal(getEventListeners(f.account.signal, 'abort').length, 0);
        assert.equal(f.counts().waitsSettled, 1, 'Account wait must release before native settles');
        assert.equal(f.waitSignal()?.aborted, true);
        assert.equal(f.account.closed, false);
        assert.equal(await f.account.awaitAlive(Promise.resolve('sibling')), 'sibling');
        assert.equal(f.counts().removals, name.endsWith('approval') ? 1 : 0);
      } finally {
        if (completion === 'resolve') f.resolveLate('u_late');
        else f.rejectLate(new Error('Controlled late failure'));
        f.owner.close();
        f.account.close();
        await stopped;
      }
      await tick();
      assert.equal(f.counts().calls, 1);
    });

for (const name of names)
  for (const legacy of [false, true])
    test(`${name} retains parent cancellation policy with ${legacy ? 'legacy' : 'account'} port`, async () => {
      const f = fixture(name, legacy);
      const stopped = assert.rejects(f.result, (error) =>
        name === 'self-uid'
          ? error instanceof Error && error.message === 'Self profile module is closed'
          : error === f.account.signal.reason,
      );
      void stopped.catch(() => {});
      try {
        await tick();
        f.account.close();
        await stopped;
      } finally {
        f.rejectLate(new Error('Controlled late parent failure'));
        f.owner.close();
        f.account.close();
        await stopped;
      }
    });
