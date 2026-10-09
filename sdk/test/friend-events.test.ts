import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFriendEvents } from '../src/friend-events.ts';

const user = { uid: 'u_friend', uin: '900719925474099312345', nick: '昵称' };
const category = { categoryId: 1, categoryName: '好友', categoryMbCount: 1, buddyList: [user] };

test('friend metadata preserves categories, long IDs and absent or empty remarks', () => {
  const events: [string, any][] = [];
  const listener = createFriendEvents((event, value) => events.push([event, value]));
  listener.onBuddyListChange([category, { categoryId: 9999, categoryName: '', categoryMbCount: 5, buddyList: [{ ...user, remark: '' }] }]);
  assert.deepEqual(events, [['friend-list-updated', { categories: [
    { categoryId: 1, name: '好友', memberCount: 1, friends: [{ uid: user.uid, userId: user.uin, nickname: user.nick }] },
    { categoryId: 9999, name: '', memberCount: 5, friends: [{ uid: user.uid, userId: user.uin, nickname: user.nick, remark: '' }] },
  ] }]]);
  assert.equal(events[0][1].categories[1].memberCount, 5, 'do not synthesize counts from the supplied array');
  listener.onBuddyListChange([]);
  assert.deepEqual(events.at(-1), ['friend-list-updated', { categories: [] }]);
  listener.onBuddyListChange([{ ...category, categoryMbCount: 0, buddyList: [] }]);
  assert.deepEqual(events.at(-1), ['friend-list-updated', { categories: [{ categoryId: 1, name: '好友', memberCount: 0, friends: [] }] }]);
});

test('invalid nested friend batches emit only a fixed diagnostic without partial updates', () => {
  const events: [string, any][] = [];
  const listener = createFriendEvents((event, value) => events.push([event, value]));
  const invalid = [undefined, null, {}, Array(1), [category, null],
    [{ ...category, categoryId: NaN }], [{ ...category, categoryId: 1.5 }],
    [{ ...category, categoryName: 1 }], [{ ...category, categoryMbCount: -1 }],
    [{ ...category, categoryMbCount: Infinity }], [{ ...category, buddyList: Array(1) }],
    [{ ...category, buddyList: [user, { uid: 'u_bad', uin: 'bad', credential: 'fixture-secret' }] }],
    ...[{ uid: '' }, { uin: 456 }, { nick: undefined }, { remark: null }].map(change => [{ ...category, buddyList: [{ ...user, ...change }] }]),
  ];
  for (const value of invalid) listener.onBuddyListChange(value);
  assert.equal(events.length, invalid.length);
  assert.ok(events.every(([name, payload]) => name === 'diagnostic' && payload.stage === 'invalid-native-friend-list-update'));
  assert.doesNotMatch(JSON.stringify(events), /credential|fixture-secret|u_bad/);
});

test('friend events project independent objects and exclude unrelated native profile fields', () => {
  const events: [string, any][] = [];
  const listener = createFriendEvents((event, value) => events.push([event, value]));
  const source = { ...category, buddyList: [{ ...user, remark: 'original', phoneNum: 'private fixture', extra: { credential: 'fixture-secret' } }] };
  listener.onBuddyListChange([source]);
  events[0][1].categories[0].name = 'changed';
  events[0][1].categories[0].friends[0].remark = 'changed';
  assert.equal(source.categoryName, '好友');
  assert.equal(source.buddyList[0].remark, 'original');
  assert.doesNotMatch(JSON.stringify(events), /phoneNum|private fixture|credential|fixture-secret/);
});
