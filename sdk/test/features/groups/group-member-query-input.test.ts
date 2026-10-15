import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureGroupMemberList,
  captureGroupMemberQuery,
  groupMemberIdentity,
} from '../../../src/features/groups/group-member-query-input.ts';

test('member query input preserves decimal spelling and only explicit refresh values', () => {
  const groupId = '000123';
  const userId = '0009007199254740993';
  assert.deepEqual(captureGroupMemberList(groupId), { groupId });
  assert.deepEqual(captureGroupMemberList(groupId, {}), { groupId });
  assert.deepEqual(captureGroupMemberList(groupId, { refresh: undefined }), { groupId });
  assert.deepEqual(captureGroupMemberQuery(groupId, userId), { groupId, userId });
  for (const refresh of [false, true]) {
    const options = { refresh };
    const captured = captureGroupMemberQuery(groupId, userId, options);
    options.refresh = !refresh;
    assert.deepEqual(captured, { groupId, userId, refresh });
    assert.deepEqual(captureGroupMemberList(groupId, { refresh }), { groupId, refresh });
  }
  const options = Object.create(null, { refresh: { value: false } });
  assert.deepEqual(captureGroupMemberQuery(groupId, userId, options), {
    groupId,
    userId,
    refresh: false,
  });
  assert.equal(groupMemberIdentity(userId), '9007199254740993');
  assert.notEqual(groupMemberIdentity('9007199254740992'), groupMemberIdentity(userId));
});

test('member query rejects invalid selectors without coercion or reading options', () => {
  const options = new Proxy({}, { ownKeys: () => assert.fail('invalid selector reached options') });
  const invalid = [
    undefined,
    null,
    1,
    1n,
    '',
    '0',
    '000',
    '-1',
    '+1',
    '1.2',
    '1e3',
    ' 123',
    '123 ',
    'u_member',
    new String('123'),
    { toString: () => assert.fail('selector coerced') },
  ];
  for (const value of invalid) {
    assert.throws(() => captureGroupMemberQuery('1', value, options), /positive decimal/);
    assert.throws(() => captureGroupMemberQuery(value, '1', options));
    assert.throws(() => captureGroupMemberList(value, options));
  }
});

test('member options reject accessors, unknown keys and nonboolean refresh without getters', () => {
  let reads = 0;
  const accessor = Object.defineProperty({}, 'refresh', {
    get() {
      reads++;
      throw new Error('private getter details');
    },
  });
  for (const options of [
    null,
    true,
    false,
    [],
    'true',
    new Date(),
    Object.create({ refresh: true }),
    accessor,
    { refresh: 'true' },
    { refresh: 0 },
    { refresh: null },
    { extra: true },
    { [Symbol('extra')]: true },
  ]) {
    assert.throws(() => captureGroupMemberList('1', options));
    assert.throws(() => captureGroupMemberQuery('1', '2', options));
  }
  assert.equal(reads, 0);
});
