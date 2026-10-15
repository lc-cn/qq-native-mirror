import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroupQueries } from '../../../src/features/groups/group-queries.ts';
import { createNativeEventChannel } from '../../../src/runtime/native-event-channel.ts';
import type { GroupMember } from '../../../src/types.ts';

const member = (uid: string, uin: string, role = 2) => ({
  uid,
  uin,
  role,
  nick: `nickname ${uid}`,
  cardName: `card ${uid}`,
});
function response(...members: ReturnType<typeof member>[]) {
  return {
    errCode: 0,
    result: { finish: true, infos: new Map(members.map((item) => [item.uid, item])) },
  };
}
function fixture() {
  const controller = new AbortController();
  const channel = createNativeEventChannel(controller.signal);
  const calls: unknown[][] = [];
  const commits: (readonly GroupMember[])[] = [];
  let acquired = 0;
  let returned: unknown = response();
  const service = {
    getAllMemberList(this: unknown, ...args: unknown[]) {
      assert.equal(this, service);
      calls.push(args);
      return returned;
    },
  };
  const queries = createGroupQueries({
    signal: controller.signal,
    getGroupService() {
      acquired++;
      return service;
    },
    eventCall: channel.call,
    awaitAlive: async (value) => value,
    commitMembers: (members) => commits.push(members),
  });
  return {
    queries,
    controller,
    calls,
    commits,
    acquired: () => acquired,
    result(value: unknown) {
      returned = value;
    },
    close() {
      queries.close();
      channel.close();
    },
  };
}

test('single member uses a full native query, decimal identity and original DTO spelling', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  f.result(
    response(
      member('u_a', '9007199254740992'),
      member('u_b', '0009007199254740993', 3),
      member('u_c', '789', 4),
    ),
  );
  assert.deepEqual(await f.queries.getGroupMember('000456', '9007199254740993', true), {
    userId: '0009007199254740993',
    uid: 'u_b',
    nickname: 'nickname u_b',
    card: 'card u_b',
    role: 'admin',
  });
  assert.equal((await f.queries.getGroupMember('456', '000789', false))?.role, 'owner');
  assert.equal((await f.queries.getGroupMember('456', '9007199254740992'))?.role, 'member');
  assert.deepEqual(f.calls, [
    ['000456', true],
    ['456', false],
    ['456', false],
  ]);
  assert.equal(f.commits.length, 3);
  assert.equal(f.commits[0].length, 3);
});

test('undefined requires an explicitly successful complete validated list', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  assert.equal(await f.queries.getGroupMember('456', '123'), undefined);
  f.result(response(member('u_other', '789')));
  assert.equal(await f.queries.getGroupMember('456', '123'), undefined);
  assert.equal(f.commits.length, 2);
  for (const value of [
    { errCode: 7, result: { finish: true, infos: new Map() } },
    { result: { finish: true, infos: new Map() } },
    { errCode: 0, result: { finish: false, infos: new Map() } },
    { errCode: 0, result: { infos: new Map() } },
    { errCode: 0, result: { finish: true, infos: [] } },
  ]) {
    f.result(value);
    await assert.rejects(f.queries.getGroupMember('456', '123'));
  }
  assert.equal(f.commits.length, 2);
  assert.equal(f.calls.length, 7);
});

test('complete projection rejects later invalid and duplicate identities before selection or commit', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const invalidLists = [
    response(member('u_target', '123'), member('u_bad', '789', 99)),
    response(member('u_target', '123'), member('u_duplicate', '00123')),
    response(member('u_target', '123'), member('u_duplicate', '123')),
    response(member('u_a', '9007199254740993'), member('u_b', '0009007199254740993')),
    response(member('u_zero', '0')),
    response(member('u_zero', '000')),
  ];
  for (const value of invalidLists) {
    f.result(value);
    await assert.rejects(f.queries.getGroupMember('456', '123'));
    await assert.rejects(f.queries.getGroupMember('456', '999'));
    await assert.rejects(f.queries.getGroupMembers('456'));
  }
  assert.equal(f.commits.length, 0);
  assert.equal(f.calls.length, invalidLists.length * 3);
});

test('invalid member selectors and refresh reject before service acquisition', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  for (const userId of [undefined, null, 123, '', '0', '000', 'u_member', '-1'])
    await assert.rejects(f.queries.getGroupMember('456', userId));
  await assert.rejects(f.queries.getGroupMember('0', '123'));
  await assert.rejects(f.queries.getGroupMember('456', '123', 'true'));
  assert.equal(f.acquired(), 0);
  assert.deepEqual(f.calls, []);
});

test('native failures retain error code and never become missing membership or retries', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  f.result({ errCode: 17, errMsg: 'private native details' });
  await assert.rejects(f.queries.getGroupMember('456', '123'), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(Reflect.get(error, 'code'), 17);
    assert.doesNotMatch(error.message, /private native details/);
    return true;
  });
  const failure = new Error('provider rejection');
  f.result(Promise.reject(failure));
  await assert.rejects(f.queries.getGroupMember('456', '123'), (error) => error === failure);
  assert.equal(f.calls.length, 2);
  assert.equal(f.commits.length, 0);
});

test('retirement ends pending single-member waits and observes late native rejection', async (t) => {
  for (const stop of ['owner', 'account'] as const) {
    const f = fixture();
    t.after(() => f.close());
    let reject!: (error: Error) => void;
    f.result(
      new Promise((_, no) => {
        reject = no;
      }),
    );
    const pending = assert.rejects(
      f.queries.getGroupMember('456', '123'),
      /closed|account retired/,
    );
    if (stop === 'owner') f.queries.close();
    else f.controller.abort(new Error('account retired'));
    await pending;
    reject(new Error('late native rejection'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.commits.length, 0);
    await assert.rejects(f.queries.getGroupMember('456', '123'), /closed|account retired/);
    assert.equal(f.calls.length, 1);
  }
});

test('retirement during native row capture preserves session failure and prevents commit', async (t) => {
  const f = fixture();
  t.after(() => f.close());
  const row = member('u_target', '123');
  Object.defineProperty(row, 'cardName', {
    get() {
      f.queries.close();
      throw new Error('row accessor details');
    },
  });
  f.result(response(row));
  await assert.rejects(f.queries.getGroupMember('456', '999'), /Group queries are closed/);
  assert.equal(f.commits.length, 0);
  assert.equal(f.calls.length, 1);
});
