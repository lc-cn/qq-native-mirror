import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeMessageQuery,
  normalizeMessageBatchQuery,
  messageIds,
} from '../src/features/messages/query-input.ts';
import { createMessageQueries } from '../src/features/messages/message-queries.ts';
for (const field of ['type', 'userId'] as const) {
  test(`query peer ${field} accessor rejected before UID/native`, async () => {
    let reads = 0,
      effects = 0;
    const peer = Object.defineProperty({ type: 'private', userId: '123' }, field, {
      get() {
        reads++;
        return reads < 3 ? (field === 'type' ? 'private' : '123') : 42;
      },
    });
    const controller = new AbortController();
    const queries = createMessageQueries({
      signal: controller.signal,
      getMessageService() {
        effects++;
        return {};
      },
      resolvePeer: async () => {
        effects++;
        return { chatType: 1, peerUid: 'u_friend' };
      },
      decode: async () => {
        effects++;
        return [];
      },
      awaitAlive: async (value) => value,
    });
    await assert.rejects(queries.getMessage(peer, '00042'));
    assert.equal(reads, 0);
    assert.equal(effects, 0);
  });
}
test('query peer rejects inherited selected fields but reads only applicable identity', () => {
  assert.throws(() =>
    normalizeMessageQuery(Object.create({ type: 'private', userId: '123' }), '42'),
  );
  let reads = 0;
  const privatePeer = Object.defineProperty({ type: 'private', userId: '00123' }, 'groupId', {
    get() {
      reads++;
      throw Error('irrelevant');
    },
  });
  const groupPeer = Object.defineProperty({ type: 'group', groupId: '000' }, 'userId', {
    get() {
      reads++;
      throw Error('irrelevant');
    },
  });
  assert.deepEqual(normalizeMessageQuery(privatePeer, '00042'), {
    peer: { type: 'private', userId: '00123' },
    messageId: '00042',
  });
  assert.deepEqual(normalizeMessageQuery(groupPeer, '0'), {
    peer: { type: 'group', groupId: '000' },
    messageId: '0',
  });
  assert.equal(reads, 0);
});
test('query peer accepts class and null-prototype own data without changing numeric spellings', () => {
  class PrivatePeer {
    type = 'private';
    userId = '00123';
  }
  const group = Object.assign(Object.create(null) as Record<string, unknown>, {
    type: 'group',
    groupId: '0000',
  });
  assert.deepEqual(normalizeMessageQuery(new PrivatePeer(), '00042').peer, {
    type: 'private',
    userId: '00123',
  });
  assert.deepEqual(normalizeMessageBatchQuery(group, ['00042', '0']), {
    peer: { type: 'group', groupId: '0000' },
    messageIds: ['00042', '0'],
  });
});
test('query ID slots are dense own data and accessors never execute', () => {
  let reads = 0;
  const accessor = Object.defineProperty(new Array(1), '0', {
    get() {
      reads++;
      return '42';
    },
  });
  const inherited = new Array(1);
  Object.setPrototypeOf(inherited, {
    0: '42',
    [Symbol.iterator]: Array.prototype[Symbol.iterator],
  });
  for (const ids of [accessor, inherited, new Array(1)]) assert.throws(() => messageIds(ids));
  assert.equal(reads, 0);
});
test('query ID custom iterator cannot replace, hide invalid slots or bypass bounds', () => {
  let calls = 0;
  const replace = (input: unknown[], output: unknown[]) =>
    Object.defineProperty(input, Symbol.iterator, {
      value() {
        calls++;
        return output[Symbol.iterator]();
      },
    });
  assert.deepEqual(
    messageIds(
      replace(
        ['00042'],
        Array.from({ length: 101 }, (_, index) => String(index)),
      ),
    ),
    ['00042'],
  );
  assert.throws(() => messageIds(replace(['42', {}], ['42'])));
  const hundred = Array.from({ length: 100 }, (_, index) => String(index));
  assert.deepEqual(messageIds(replace(hundred, ['replacement'])), hundred);
  assert.equal(calls, 0);
  assert.equal(messageIds(Array.from({ length: 100 }, (_, index) => String(index))).length, 100);
  assert.throws(() => messageIds(Array.from({ length: 101 }, (_, index) => String(index))));
  assert.throws(() => messageIds(['42', '42']));
  assert.deepEqual(messageIds(['00042', '42']), ['00042', '42']);
});
test('query invalid later ID cannot reach UID/native even with hiding iterator', async () => {
  let effects = 0;
  const ids = Object.defineProperty(['42', null], Symbol.iterator, {
    value() {
      return ['42'][Symbol.iterator]();
    },
  });
  const controller = new AbortController();
  const queries = createMessageQueries({
    signal: controller.signal,
    getMessageService() {
      effects++;
      return {};
    },
    resolvePeer: async () => {
      effects++;
      return { chatType: 1, peerUid: 'u_friend' };
    },
    decode: async () => {
      effects++;
      return [];
    },
    awaitAlive: async (value) => value,
  });
  await assert.rejects(queries.getMessages({ type: 'private', userId: '123' }, ids));
  assert.equal(effects, 0);
});
