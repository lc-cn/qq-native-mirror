import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureRecallPayload,
  captureRecallRequest,
} from '../src/features/messages/recall-input.ts';
test('recall captures exact numeric strings and rejects coercion/accessors/inheritance', () => {
  assert.deepEqual(captureRecallRequest({ type: 'group', groupId: '00123' }, '00042'), {
    peer: { type: 'group', groupId: '00123' },
    messageId: '00042',
  });
  let reads = 0;
  assert.throws(() =>
    captureRecallPayload({
      peer: { type: 'group', groupId: '123' },
      get messageId() {
        reads++;
        return '42';
      },
    }),
  );
  assert.equal(reads, 0);
  for (const value of [
    42,
    false,
    null,
    {
      toString() {
        throw Error('coercion');
      },
    },
  ])
    assert.throws(() => captureRecallRequest({ type: 'group', groupId: '123' }, value));
  assert.throws(() => captureRecallRequest(Object.create({ type: 'group', groupId: '123' }), '42'));
});
