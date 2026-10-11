import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureFriendRequest } from '../src/features/contacts/friend-request-input.ts';
import { captureGroupRequestOperation } from '../src/features/groups/group-request-input.ts';

const approval = { groupId: '0000', sequence: '0001', type: 7 as const, doubt: false };

test('request preflight remains idempotent across facade and worker boundaries', () => {
  const friend = captureFriendRequest({ request: { uid: ' exact ', time: '0000' }, accept: false });
  assert.deepEqual(captureFriendRequest(friend), friend);
  for (const options of [
    undefined,
    {},
    { limit: null },
    { before: '0000', doubt: true, limit: 100 },
  ]) {
    const first = captureGroupRequestOperation('listGroupRequests', { options });
    const second = captureGroupRequestOperation(first.method, first.payload);
    assert.deepEqual(second, first);
    assert.notEqual(second.payload.options, first.payload.options);
    assert.equal(Object.hasOwn(first.payload.options, 'before'), options?.before !== undefined);
  }
  for (const reason of [undefined, '', ' exact ']) {
    const first = captureGroupRequestOperation('handleGroupRequest', {
      request: approval,
      accept: true,
      reason,
    });
    const second = captureGroupRequestOperation(first.method, first.payload);
    assert.deepEqual(second, first);
    assert.notEqual(second.payload.request, first.payload.request);
    assert.equal(second.payload.reason, reason);
  }
});

test('list input retains read-before-validation ordering and cursor admission', () => {
  const reads: string[] = [];
  const options = {
    get doubt() {
      reads.push('doubt');
      return 'invalid';
    },
    get before() {
      reads.push('before');
      return '0';
    },
    get limit() {
      reads.push('limit');
      return 20;
    },
  };
  assert.throws(
    () => captureGroupRequestOperation('listGroupRequests', { options }),
    /doubt must be a boolean/,
  );
  assert.deepEqual(reads, ['doubt', 'before', 'limit']);
  for (const before of ['', null, -1, 'bad'])
    assert.throws(
      () => captureGroupRequestOperation('listGroupRequests', { options: { before } }),
      /before must be a numeric string/,
    );
});

test('approval validation stops before later fields and preserves getter exceptions', () => {
  const original = Error('request getter original');
  assert.throws(
    () =>
      captureFriendRequest({
        request: {
          uid: '',
          get time(): never {
            throw original;
          },
        },
        accept: true,
      }),
    /request.uid/,
  );
  assert.throws(
    () =>
      captureFriendRequest({
        request: {
          uid: 'u_fixture',
          get time(): never {
            throw original;
          },
        },
        accept: true,
      }),
    (error) => error === original,
  );
  assert.throws(
    () =>
      captureGroupRequestOperation('handleGroupRequest', {
        request: {
          ...approval,
          groupId: 'bad',
          get sequence(): never {
            throw original;
          },
        },
        accept: true,
      }),
    /request.groupId/,
  );
  assert.throws(
    () =>
      captureGroupRequestOperation('handleGroupRequest', {
        request: approval,
        accept: 'invalid',
        get reason(): never {
          throw original;
        },
      }),
    /accept must be a boolean/,
  );
});

test('literal and union request intents keep payload correlation in strict consumers', () => {
  const list = captureGroupRequestOperation('listGroupRequests', {});
  const limit: number = list.payload.options.limit;
  assert.equal(limit, 20);
  // @ts-expect-error Listing has no approval identity.
  void list.payload.request;
  const handle = captureGroupRequestOperation('handleGroupRequest', {
    request: approval,
    accept: true,
  });
  const kind: 1 | 5 | 7 = handle.payload.request.type;
  assert.equal(kind, 7);
  // @ts-expect-error Approval has no page options.
  void handle.payload.options;
  for (const method of ['listGroupRequests', 'handleGroupRequest'] as const) {
    const input = captureGroupRequestOperation(method, { request: approval, accept: true });
    if (input.method === 'listGroupRequests') assert.equal(input.payload.options.doubt, false);
    else assert.equal(input.payload.request.sequence, '0001');
  }
});
