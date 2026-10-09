import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createForwardMessages } from '../src/forward-messages.ts';
import type { Message, Peer } from '../src/types.ts';
const resolvePeer = async (peer: Peer) => peer.type === 'private' ? { chatType: 1 as const, peerUid: 'u_resolved' } : { chatType: 2 as const, peerUid: peer.groupId };

test('reads native merged-forward contents with exact root and parent IDs', async () => {
  const raw = { msgId: '99', chatType: 1, elements: [] };
  const decoded = { messageId: '99', raw } as Message;
  const operations = createForwardMessages({ getMsgService: () => ({ getMultiMsg: (peer: unknown, root: string, parent: string) => {
    assert.deepEqual(peer, { chatType: 1, peerUid: 'u_resolved' }); assert.equal(root, '10'); assert.equal(parent, '20');
    return { result: 0, msgList: [raw] };
  } }) }, resolvePeer, value => { assert.equal(value, raw); return decoded; });
  assert.deepEqual(await operations.invokeOperation('getForwardMessages', { peer: { type: 'private', userId: '123' }, rootMessageId: '10', parentMessageId: '20' }), [decoded]);
});

test('forwards existing messages with exact native destinations and empty Map', async () => {
  const calls: any[] = [];
  const operations = createForwardMessages({ getMsgService: () => ({ forwardMsg: (...args: unknown[]) => { calls.push(args); return { result: 0 }; } }) }, resolvePeer, () => undefined);
  assert.equal(calls.length, 0);
  const source = { type: 'group', groupId: '123' };
  const destination = { type: 'private', userId: '456' };
  assert.equal(await operations.invokeOperation('forwardMessages', { source, destination, messageIds: ['10', '20'] }), undefined);
  assert.deepEqual(calls[0], [['10', '20'], { chatType: 2, peerUid: '123' }, [{ chatType: 1, peerUid: 'u_resolved' }], new Map()]);
  assert.deepEqual(source, { type: 'group', groupId: '123' });
});

test('validates all inputs before UID lookup or native invocation', async () => {
  let invoked = 0;
  const operations = createForwardMessages({ getMsgService: () => { invoked++; return {}; } }, async peer => { invoked++; return resolvePeer(peer); }, () => undefined);
  const cases = [
    ['getForwardMessages', { peer: { type: 'group', groupId: '123' }, rootMessageId: '10' }],
    ['getForwardMessages', { peer: { type: 'private', userId: 'bad' }, rootMessageId: '10', parentMessageId: '20' }],
    ['forwardMessages', { source: { type: 'group', groupId: '123' }, destination: { type: 'group', groupId: '456' }, messageIds: [] }],
    ['forwardMessages', { source: { type: 'group', groupId: '123' }, destination: { type: 'group', groupId: '456' }, messageIds: ['10', null] }],
  ] as const;
  for (const [method, payload] of cases) await assert.rejects(operations.invokeOperation(method, payload));
  assert.equal(invoked, 0);
});

test('native errors, malformed lists, missing messages and undecodable content reject', async () => {
  for (const result of [undefined, { result: 5 }, { result: 0 }, { result: 0, msgList: [null] }, { result: 0, msgList: [{ chatType: 0 }] }]) {
    const operations = createForwardMessages({ getMsgService: () => ({ getMultiMsg: () => result }) }, resolvePeer, () => undefined);
    await assert.rejects(operations.invokeOperation('getForwardMessages', { peer: { type: 'group', groupId: '123' }, rootMessageId: '10', parentMessageId: '20' }));
  }
  const operations = createForwardMessages({ getMsgService: () => ({ forwardMsg: () => undefined }) }, resolvePeer, () => undefined);
  await assert.rejects(operations.invokeOperation('forwardMessages', { source: { type: 'group', groupId: '123' }, destination: { type: 'group', groupId: '456' }, messageIds: ['10'] }), /failed/);
});
