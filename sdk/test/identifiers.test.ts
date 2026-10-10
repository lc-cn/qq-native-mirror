import assert from 'node:assert/strict';
import test from 'node:test';
import { sendUserId, sendGroupId } from '../src/validation/identifiers.ts';
import {
  sendUserId as legacyUser,
  sendGroupId as legacyGroup,
} from '../src/features/messages/send-input.ts';
import { captureDeleteGroupFolder } from '../src/features/groups/group-file-input.ts';
import { captureGroupEssenceRequest } from '../src/features/groups/group-essence-input.ts';

test('shared identifier owner preserves identity and exact accepted strings', () => {
  assert.equal(legacyUser, sendUserId);
  assert.equal(legacyGroup, sendGroupId);
  for (const value of ['1', '000123', '18446744073709551616']) {
    assert.equal(sendUserId(value), value);
    assert.equal(sendGroupId(value), value);
  }
  for (const value of ['u_fake', 'u_123']) assert.equal(sendUserId(value), value);
  assert.equal(sendUserId('all', true), 'all');
  assert.throws(() => sendUserId('all'));
});

test('identifier rules reject invalid values without coercion', () => {
  let coercions = 0;
  const object = {
    toString() {
      coercions++;
      return '123';
    },
  };
  for (const value of [
    undefined,
    null,
    123,
    object,
    '',
    '0',
    '000',
    ' 123',
    '123 ',
    '-1',
    '1.2',
    '1*',
  ]) {
    assert.throws(() => sendUserId(value));
    assert.throws(() => sendGroupId(value));
  }
  for (const value of ['u_', 'all', 'u_fake']) assert.throws(() => sendGroupId(value));
  assert.throws(() => sendUserId('u_'));
  assert.equal(coercions, 0);
});

test('uint64 constraints remain operation-specific and preserve leading zeroes', () => {
  const id = '00018446744073709551615';
  assert.equal(captureDeleteGroupFolder(id, 'opaque').groupId, id);
  assert.equal(captureGroupEssenceRequest(id, '1', true).groupId, id);
  const oversized = '18446744073709551616';
  assert.equal(sendGroupId(oversized), oversized);
  assert.throws(() => captureDeleteGroupFolder(oversized, 'opaque'), /uint64/);
  assert.throws(() => captureGroupEssenceRequest(oversized, '1', true), /uint64/);
});
