import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureFriendCategories,
  projectFriendCategories,
} from '../src/features/contacts/friend-categories.ts';

const category = (uids = ['u_a']) => ({
  categoryId: 3,
  categorySortId: 8,
  categroyName: '好友',
  categroyMbCount: 99,
  onlineCount: 40,
  buddyUids: uids,
});
const profile = (uid = 'u_a') => ({
  coreInfo: { uid, uin: '900719925474099312345', nick: '昵称', remark: '' },
});

test('categories preserve native counts, ordering, repeated relationships and exact identities', () => {
  const captured = captureFriendCategories({
    result: 0,
    data: [category(['u_a', 'u_a']), { ...category([]), categoryId: 0 }],
  });
  assert.deepEqual(captured.uniqueUIDs, ['u_a']);
  const result = projectFriendCategories(captured, new Map([['u_a', profile()]]));
  assert.deepEqual(
    result.map((row) => [
      row.categoryId,
      row.sortId,
      row.memberCount,
      row.onlineCount,
      row.friends.length,
    ]),
    [
      [3, 8, 99, 40, 2],
      [0, 8, 99, 40, 0],
    ],
  );
  assert.equal(result[0].friends[0].userId, '900719925474099312345');
  result[0].friends[0].nickname = 'changed';
  assert.equal(result[0].friends[1].nickname, '昵称');
  assert.deepEqual(
    projectFriendCategories(captureFriendCategories({ result: 0, data: [] }), new Map()),
    [],
  );
});

test('capture snapshots before profile awaits and does not execute field accessors', () => {
  const raw = category();
  const input = { result: 0, data: [raw] };
  const captured = captureFriendCategories(input);
  raw.buddyUids[0] = 'u_other';
  raw.categroyName = 'changed';
  input.data.length = 0;
  assert.equal(projectFriendCategories(captured, new Map([['u_a', profile()]]))[0].name, '好友');
  let reads = 0;
  assert.throws(
    () =>
      captureFriendCategories({
        get result() {
          reads++;
          return 0;
        },
        data: [],
      }),
    /query failed/,
  );
  assert.throws(() =>
    captureFriendCategories({
      result: 0,
      data: [
        {
          ...category(),
          get categroyName() {
            reads++;
            return 'x';
          },
        },
      ],
    }),
  );
  assert.equal(reads, 0);
});

test('failed result and malformed dense batches reject instead of partial categories', () => {
  assert.throws(
    () => captureFriendCategories({ result: -12, data: [] }),
    (error: any) => error.code === -12,
  );
  for (const data of [
    Array(1),
    [category(), null],
    [{ ...category(), buddyUids: Array(1) }],
    [{ ...category(), buddyUids: [''] }],
    [{ ...category(), categroyMbCount: -1 }],
    [{ ...category(), onlineCount: 1.5 }],
    [{ ...category(), categorySortId: NaN }],
    [{ ...category(), categroyName: 1 }],
  ])
    assert.throws(() => captureFriendCategories({ result: 0, data }));
});

test('all profile rows must validate, preserving optional nickname and requiring exact Map identity', () => {
  const captured = captureFriendCategories({ result: 0, data: [category(['u_a', 'u_b'])] });
  const missingNick = profile('u_b');
  delete (missingNick.coreInfo as any).nick;
  const good = new Map([
    ['u_a', profile()],
    ['u_b', missingNick],
  ]);
  assert.equal(projectFriendCategories(captured, good)[0].friends[1].nickname, '');
  assert.throws(
    () => projectFriendCategories(captured, new Map([['u_a', profile()]])),
    /incomplete/,
  );
  for (const coreInfo of [
    { ...profile('u_b').coreInfo, uid: 'wrong' },
    { ...profile('u_b').coreInfo, uin: 123 },
    { ...profile('u_b').coreInfo, remark: undefined },
    { ...profile('u_b').coreInfo, nick: false },
  ])
    assert.throws(
      () =>
        projectFriendCategories(
          captured,
          new Map([
            ['u_a', profile()],
            ['u_b', { coreInfo }],
          ]),
        ),
      /profile/,
    );
  assert.throws(() => projectFriendCategories(captured, {}), /map/);
});
