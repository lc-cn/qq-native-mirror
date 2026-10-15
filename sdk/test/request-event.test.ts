import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFriendRequestEvent,
  createGroupRequestEvent,
  type FriendRequestEventContext,
  type GroupRequestEventContext,
} from '../src/client/request-event.ts';
import type { FriendRequest } from '../src/contracts/contacts.ts';
import type { GroupRequest } from '../src/contracts/groups.ts';

function friend(): FriendRequest {
  return {
    uid: 'u_exact UID',
    time: '000123',
    nickname: 'friend',
    message: 'hello',
    decided: false,
    unread: true,
    initiator: false,
    raw: { native: 'friend' },
  };
}

function group(): GroupRequest {
  return {
    groupId: '000456',
    sequence: '000789',
    type: 5,
    kind: 'join',
    doubt: true,
    status: 0,
    message: 'hello',
    raw: { native: 'group' },
  };
}

function fixture() {
  const friendCalls: Parameters<FriendRequestEventContext['handleFriendRequest']>[] = [];
  const groupCalls: Parameters<GroupRequestEventContext['handleGroupRequest']>[] = [];
  let active = true;
  const failure = new Error('retired session');
  const assertActive = () => {
    if (!active) throw failure;
  };
  return {
    friendCalls,
    groupCalls,
    failure,
    retire: () => (active = false),
    friendContext: {
      assertActive,
      async handleFriendRequest(...args) {
        friendCalls.push(args);
      },
    } satisfies FriendRequestEventContext,
    groupContext: {
      assertActive,
      async handleGroupRequest(...args) {
        groupCalls.push(args);
      },
    } satisfies GroupRequestEventContext,
  };
}

test('friend approval captures its original identity and adds no capability to the source DTO', async () => {
  const source = friend();
  const { friendCalls, friendContext } = fixture();
  const event = createFriendRequestEvent(source, friendContext);
  assert.ok(event);
  assert.notEqual(event, source);
  assert.equal(event.raw, source.raw);
  assert.deepEqual(Object.keys(event), Object.keys(source));
  assert.equal(Object.hasOwn(source, 'approve'), false);
  assert.equal(
    Reflect.set(event, 'approve', () => {}),
    false,
  );
  assert.equal(Reflect.deleteProperty(event, 'approve'), false);
  source.uid = 'u_changed';
  source.time = '9';
  event.uid = 'u_listener';
  event.time = '8';
  assert.equal(await event.approve(), undefined);
  assert.deepEqual(friendCalls, [[{ uid: 'u_exact UID', time: '000123' }, true]]);
  friendCalls[0]![0].uid = 'u_callback_mutation';
  await event.approve(false);
  assert.deepEqual(friendCalls[1], [{ uid: 'u_exact UID', time: '000123' }, false]);
});

test('group approval preserves all operation identity fields and explicit decision reason', async () => {
  const source = group();
  const { groupCalls, groupContext } = fixture();
  const event = createGroupRequestEvent(source, groupContext);
  assert.ok(event);
  assert.notEqual(event, source);
  assert.equal(event.raw, source.raw);
  assert.deepEqual(Object.keys(event), Object.keys(source));
  assert.equal(Object.hasOwn(source, 'approve'), false);
  assert.equal(
    Reflect.set(event, 'approve', () => {}),
    false,
  );
  assert.equal(Reflect.deleteProperty(event, 'approve'), false);
  Object.assign(source, { groupId: '9', sequence: '8', type: 1, doubt: false });
  Object.assign(event, { groupId: '7', sequence: '6', type: 7, doubt: false });
  assert.equal(await event.approve(false, 'exact reason'), undefined);
  assert.deepEqual(groupCalls, [
    [{ groupId: '000456', sequence: '000789', type: 5, doubt: true }, false, 'exact reason'],
  ]);
  groupCalls[0]![0].sequence = 'callback mutation';
  await event.approve();
  assert.deepEqual(groupCalls[1], [
    { groupId: '000456', sequence: '000789', type: 5, doubt: true },
    true,
    undefined,
  ]);
});

test('supported group request kinds keep their native type and doubt branch', async () => {
  for (const type of [1, 5, 7] as const) {
    for (const doubt of [false, true]) {
      const { groupCalls, groupContext } = fixture();
      const event = createGroupRequestEvent({ ...group(), type, doubt }, groupContext);
      assert.ok(event);
      await event.approve();
      assert.deepEqual(groupCalls, [
        [{ groupId: '000456', sequence: '000789', type, doubt }, true, undefined],
      ]);
    }
  }
});

test('malformed selected identities are rejected without reading accessors or dispatching', () => {
  const { friendCalls, groupCalls, friendContext, groupContext } = fixture();
  for (const source of [null, undefined, [], 'request', false, {}, { uid: 'u_uid', time: 123 }]) {
    assert.equal(createFriendRequestEvent(source, friendContext), undefined);
    assert.equal(createGroupRequestEvent(source, groupContext), undefined);
  }
  for (const key of ['uid', 'time']) {
    const source = Object.defineProperty(friend(), key, {
      get: () => assert.fail('selected friend getter must not run'),
    });
    assert.equal(createFriendRequestEvent(source, friendContext), undefined);
  }
  for (const key of ['groupId', 'sequence', 'type', 'doubt']) {
    const source = Object.defineProperty(group(), key, {
      get: () => assert.fail('selected group getter must not run'),
    });
    assert.equal(createGroupRequestEvent(source, groupContext), undefined);
  }
  for (const patch of [{ uid: ' ' }, { time: ' ' }, { time: '-1' }])
    assert.equal(createFriendRequestEvent({ ...friend(), ...patch }, friendContext), undefined);
  for (const patch of [{ groupId: 'bad' }, { sequence: '' }, { type: 2 }, { doubt: 1 }])
    assert.equal(createGroupRequestEvent({ ...group(), ...patch }, groupContext), undefined);
  assert.deepEqual(friendCalls, []);
  assert.deepEqual(groupCalls, []);
});

test('display descriptors and raw identity survive without evaluating an existing approve accessor', async () => {
  const { friendContext, groupContext } = fixture();
  for (const [source, create] of [
    [friend(), (value: unknown) => createFriendRequestEvent(value, friendContext)],
    [group(), (value: unknown) => createGroupRequestEvent(value, groupContext)],
  ] as const) {
    const marker = Symbol('display marker');
    Object.defineProperty(source, marker, { value: 42 });
    Object.defineProperty(source, 'approve', {
      get: () => assert.fail('untrusted approve accessor'),
    });
    Object.defineProperty(source, 'message', {
      get: () => assert.fail('unrelated display accessor'),
    });
    const event = create(source);
    assert.ok(event);
    assert.equal(event.raw, source.raw);
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(event, 'message'),
      Object.getOwnPropertyDescriptor(source, 'message'),
    );
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(event, marker),
      Object.getOwnPropertyDescriptor(source, marker),
    );
    await event.approve();
  }
});

test('descriptor failures are suppressed as invalid request events', () => {
  const { friendContext, groupContext } = fixture();
  const source = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('private descriptor details');
      },
    },
  );
  assert.equal(createFriendRequestEvent(source, friendContext), undefined);
  assert.equal(createGroupRequestEvent(source, groupContext), undefined);
});

test('retired sessions reject actions before dispatch and preserve the guard error', async () => {
  const { friendCalls, groupCalls, friendContext, groupContext, retire, failure } = fixture();
  const friendEvent = createFriendRequestEvent(friend(), friendContext);
  const groupEvent = createGroupRequestEvent(group(), groupContext);
  assert.ok(friendEvent);
  assert.ok(groupEvent);
  retire();
  await assert.rejects(friendEvent.approve(), (error) => error === failure);
  await assert.rejects(groupEvent.approve(), (error) => error === failure);
  assert.deepEqual(friendCalls, []);
  assert.deepEqual(groupCalls, []);
});

test('the second session check prevents dispatch after capture loses its authorization', async () => {
  const failure = new Error('session retired during capture');
  for (const kind of ['friend', 'group']) {
    let checks = 0;
    const context = {
      assertActive() {
        if (++checks === 2) throw failure;
      },
      async handleFriendRequest() {
        assert.fail('retired friend action was dispatched');
      },
      async handleGroupRequest() {
        assert.fail('retired group action was dispatched');
      },
    };
    const event =
      kind === 'friend'
        ? createFriendRequestEvent(friend(), context)
        : createGroupRequestEvent(group(), context);
    assert.ok(event);
    await assert.rejects(event.approve(), (error) => error === failure);
    assert.equal(checks, 2);
  }
});

test('invalid decisions fail preflight without dispatch; native failures are not retried', async () => {
  const { friendCalls, groupCalls, friendContext, groupContext } = fixture();
  const friendEvent = createFriendRequestEvent(friend(), friendContext);
  const groupEvent = createGroupRequestEvent(group(), groupContext);
  assert.ok(friendEvent);
  assert.ok(groupEvent);
  for (const value of [null, 0, 'yes', {}]) {
    await assert.rejects(Reflect.apply(friendEvent.approve, undefined, [value]), /boolean/);
    await assert.rejects(Reflect.apply(groupEvent.approve, undefined, [value]), /boolean/);
  }
  for (const value of [null, 0, true, {}]) {
    await assert.rejects(Reflect.apply(groupEvent.approve, undefined, [true, value]), /string/);
  }
  assert.deepEqual(friendCalls, []);
  assert.deepEqual(groupCalls, []);
  const failure = new Error('original native rejection');
  let failures = 0;
  const reject = () => {
    failures++;
    return Promise.reject(failure);
  };
  const failingFriend = createFriendRequestEvent(friend(), {
    ...friendContext,
    handleFriendRequest: reject,
  });
  const failingGroup = createGroupRequestEvent(group(), {
    ...groupContext,
    handleGroupRequest: reject,
  });
  assert.ok(failingFriend);
  assert.ok(failingGroup);
  await assert.rejects(failingFriend.approve(), (error) => error === failure);
  await assert.rejects(failingGroup.approve(), (error) => error === failure);
  assert.equal(failures, 2);
});
