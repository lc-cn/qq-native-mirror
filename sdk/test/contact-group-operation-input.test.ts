import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureContactOperation } from '../src/features/contacts/contact-operation-input.ts';
import { captureGroupOperation } from '../src/features/groups/group-operation-input.ts';

test('contact preflight rejects early fields before observing later accessors', () => {
  let optionReads = 0;
  assert.throws(() =>
    captureContactOperation('deleteFriend', {
      userId: 'invalid',
      get options() {
        optionReads++;
        throw new Error('Options should not be read');
      },
    }),
  );
  assert.equal(optionReads, 0);
  let bothReads = 0;
  assert.throws(
    () =>
      captureContactOperation('deleteFriend', {
        userId: '123',
        options: {
          block: 'invalid',
          get both() {
            bothReads++;
            throw new Error('Later flag should not be read');
          },
        },
      }),
    /block must be a boolean/,
  );
  assert.equal(bothReads, 0);
});

test('group preflight reads only the selected action and preserves validation order', () => {
  let reasonReads = 0;
  assert.throws(
    () =>
      captureGroupOperation('kickGroupMember', {
        groupId: '123',
        userId: '456',
        options: {
          rejectRejoin: 'invalid',
          get reason() {
            reasonReads++;
            throw new Error('Later reason should not be read');
          },
        },
      }),
    /rejectRejoin must be a boolean/,
  );
  assert.equal(reasonReads, 0);
  const captured = captureGroupOperation('leaveGroup', {
    groupId: '0000',
    get userId() {
      return assert.fail('Leave must not read a member identity');
    },
    get options() {
      return assert.fail('Leave must not read unrelated options');
    },
  });
  assert.deepEqual(captured, { method: 'leaveGroup', payload: { groupId: '0000' } });
});

test('captured intent types correlate action fields and require populated option defaults', () => {
  const deletion = captureContactOperation('deleteFriend', { userId: '123' });
  const block: boolean = deletion.payload.options.block;
  assert.equal(block, false);
  // @ts-expect-error A deletion payload cannot acquire a remark field.
  assert.equal(deletion.payload.remark, undefined);
  const kick = captureGroupOperation('kickGroupMember', { groupId: '123', userId: '456' });
  const reason: string = kick.payload.options.reason;
  assert.equal(reason, '');
  // @ts-expect-error A kick payload cannot acquire a mute duration.
  assert.equal(kick.payload.seconds, undefined);
  for (const method of ['setGroupName', 'leaveGroup'] as const) {
    const input = captureGroupOperation(method, { groupId: '123', name: 'name' });
    if (input.method === 'setGroupName') {
      const name: string = input.payload.name;
      assert.equal(name, 'name');
    } else {
      // @ts-expect-error A narrowed leave intent has no name.
      assert.equal(input.payload.name, undefined);
    }
  }
});
