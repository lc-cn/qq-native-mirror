import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeServices } from '../../../src/native-services.ts';
import type { FriendBuddyListener } from '../../../src/features/contacts/friend-requests.ts';

const user = { uid: 'u_friend', uin: '900719925474099312345', nick: 'friend' };
const category = { categoryId: 1, categoryName: 'friends', categoryMbCount: 3, buddyList: [user] };
const diagnostic = ['diagnostic', { stage: 'invalid-native-friend-list-update' }];

function fixture(observer?: (event: string, payload: unknown) => void) {
  const events: [string, unknown][] = [];
  let listener: FriendBuddyListener | undefined;
  const services = createNativeServices({
    session: {
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getMsgService: () => ({ addKernelMsgListener() {} }),
      getBuddyService: () => ({
        addKernelBuddyListener(value: FriendBuddyListener) {
          listener = value;
        },
      }),
    },
    identity: { userId: '123', uid: 'u_self' },
    version: 'fixture',
    events: {
      emit(event, payload) {
        events.push([event, payload]);
        observer?.(event, payload);
      },
    },
  });
  assert.ok(listener);
  return { events, services, listener };
}

test('the registered Buddy listener rejects a nickname accessor with only a fixed diagnostic', (t) => {
  const { events, services, listener } = fixture();
  t.after(() => services.close());
  let reads = 0;
  const malformed = {
    ...user,
    get nick(): string {
      reads++;
      throw new Error('private native nickname detail');
    },
  };
  assert.doesNotThrow(() => listener.onBuddyListChange([{ ...category, buddyList: [malformed] }]));
  assert.equal(reads, 0);
  assert.deepEqual(events, [diagnostic]);
});

test('selected category and friend accessors never run and malformed batches emit no partial update', (t) => {
  const { events, services, listener } = fixture();
  t.after(() => services.close());
  let reads = 0;
  const accessor = {
    get() {
      reads++;
      throw new Error('private native field detail');
    },
  };
  const malformed: unknown[] = [];
  for (const key of ['uid', 'uin', 'nick', 'remark'])
    malformed.push([
      { ...category, buddyList: [Object.defineProperty({ ...user }, key, accessor)] },
    ]);
  for (const key of ['categoryId', 'categoryName', 'categoryMbCount', 'buddyList'])
    malformed.push([category, Object.defineProperty({ ...category }, key, accessor)]);
  const inherited = Object.create(user) as unknown;
  malformed.push([{ ...category, buddyList: [inherited] }]);
  malformed.push(Array(1));
  malformed.push([{ ...category, buddyList: Array(1) }]);
  malformed.push(Object.defineProperty([category], '0', accessor));
  malformed.push([{ ...category, buddyList: Object.defineProperty([user], '0', accessor) }]);
  for (const input of malformed) assert.doesNotThrow(() => listener.onBuddyListChange(input));
  assert.equal(reads, 0);
  assert.deepEqual(
    events,
    malformed.map(() => diagnostic),
  );
});

test('array iterators cannot substitute a callback batch or native friend entries', (t) => {
  const { events, services, listener } = fixture();
  t.after(() => services.close());
  const buddies = [{ ...user, remark: '' }];
  const input = [{ ...category, categoryId: -1, buddyList: buddies }];
  for (const values of [input, buddies])
    Object.defineProperty(values, Symbol.iterator, {
      get: () => assert.fail('caller iterator must not be inspected'),
    });
  listener.onBuddyListChange(input);
  assert.deepEqual(events, [
    [
      'friend-list-updated',
      {
        categories: [
          {
            categoryId: -1,
            name: 'friends',
            memberCount: 3,
            friends: [{ uid: user.uid, userId: user.uin, nickname: user.nick, remark: '' }],
          },
        ],
      },
    ],
  ]);
});

test('descriptor failures produce one fixed diagnostic and later valid callbacks remain usable', (t) => {
  const { events, services, listener } = fixture();
  t.after(() => services.close());
  const opaque = <T extends object>(target: T) =>
    new Proxy(target, {
      getOwnPropertyDescriptor() {
        throw new Error('private descriptor detail');
      },
    });
  for (const input of [
    opaque([category]),
    [opaque(category)],
    [{ ...category, buddyList: [opaque(user)] }],
  ])
    assert.doesNotThrow(() => listener.onBuddyListChange(input));
  assert.deepEqual(events, [diagnostic, diagnostic, diagnostic]);
  listener.onBuddyListChange([]);
  assert.deepEqual(events.at(-1), ['friend-list-updated', { categories: [] }]);
});

test('observer failures escape unchanged and never become malformed-native diagnostics', (t) => {
  for (const eventName of ['friend-list-updated', 'diagnostic']) {
    const failure = new Error(`original ${eventName} observer failure`);
    const { events, services, listener } = fixture((event) => {
      if (event === eventName) throw failure;
    });
    t.after(() => services.close());
    assert.throws(
      () => listener.onBuddyListChange(eventName === 'diagnostic' ? null : [category]),
      (error) => error === failure,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]?.[0], eventName);
  }
});

test('closing from a descriptor trap suppresses the captured callback and all later notifications', (t) => {
  const { events, services, listener } = fixture();
  t.after(() => services.close());
  const source = new Proxy(
    { ...user },
    {
      getOwnPropertyDescriptor(target, key) {
        services.close();
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  listener.onBuddyListChange([{ ...category, buddyList: [source] }]);
  listener.onBuddyListChange([]);
  assert.deepEqual(events, []);
});
