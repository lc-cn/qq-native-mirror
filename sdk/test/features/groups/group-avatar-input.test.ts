import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { captureSetGroupAvatar } from '../../../src/features/groups/group-avatar-input.ts';

test('avatar input preserves exact uint64 decimal spelling and absolute pathname', () => {
  const file = resolve('avatar with spaces.png');
  for (const groupId of ['1', '000123', '18446744073709551615', `${'0'.repeat(100)}123`])
    assert.deepEqual(captureSetGroupAvatar(groupId, file), { groupId, file });
  assert.notStrictEqual(captureSetGroupAvatar('123', file), captureSetGroupAvatar('123', file));
});

test('avatar input rejects invalid, overflowing or coerced group identifiers', () => {
  const file = resolve('avatar.png');
  const coercion = { toString: () => assert.fail('group identifiers cannot be coerced') };
  for (const groupId of [
    undefined,
    null,
    123,
    123n,
    '',
    '0',
    '000',
    '-1',
    '+1',
    ' 123',
    '123 ',
    '1e3',
    '1.0',
    'u_123',
    '18446744073709551616',
    new String('123'),
    coercion,
  ])
    assert.throws(() => captureSetGroupAvatar(groupId, file));
});

test('avatar input accepts only non-NUL absolute string paths without coercion or IO', () => {
  const coercion = { toString: () => assert.fail('file paths cannot be coerced') };
  for (const file of [
    undefined,
    null,
    '',
    123,
    'avatar.png',
    './avatar.png',
    'https://example.invalid/avatar.png',
    `file://${resolve('avatar.png')}`,
    `${resolve('avatar.png')}\0suffix`,
    new String(resolve('avatar.png')),
    coercion,
  ])
    assert.throws(() => captureSetGroupAvatar('123', file), /absolute local path/);
  const nonexistent = resolve('this-path-does-not-need-to-exist/avatar.png');
  assert.deepEqual(captureSetGroupAvatar('123', nonexistent), {
    groupId: '123',
    file: nonexistent,
  });
});
