import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeServices } from '../src/native-services.ts';

test('close rejects a pending message lookup result without a follow-up native call', async () => {
  let finish!: (result: unknown) => void;
  let started!: () => void;
  const called = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const services = createNativeServices({
    getMsgService: () => ({ addKernelMsgListener() {}, getMsgsByMsgId() { started(); return pending; } }),
    getGroupService: () => ({ addKernelGroupListener() {} }),
    getBuddyService: () => ({ addKernelBuddyListener() {} }),
  }, '7.0.2-53644', () => {});
  const request = services.invokeOperation('getMessage', { peer: { type: 'group', groupId: '123' }, messageId: '9' });
  await called;
  services.close();
  finish({ result: 0, msgList: [] });
  await assert.rejects(request, /closed|abort/i);
});

const messageId = '900719925474099312345';
function rawMessage(privatePeer = false): Record<string, any> {
  return { msgId: messageId, msgSeq: '9', msgTime: '100', chatType: privatePeer ? 1 : 2,
    peerUid: privatePeer ? 'u_friend' : '123', peerUin: privatePeer ? '456' : '123',
    senderUin: '456', senderUid: 'u_friend', sendNickName: 'fixture',
    elements: [{ elementType: 1, textElement: { content: 'fixture only', atType: 0 } }] };
}
function fixture(result: any = { result: 0, msgList: [rawMessage()] }) {
  const calls: any[][] = [];
  const uidCalls: string[][] = [];
  const services = createNativeServices({
    getMsgService: () => ({ addKernelMsgListener() {}, getMsgsByMsgId(...args: any[]) { calls.push(args); return result; } }),
    getGroupService: () => ({ addKernelGroupListener() {} }),
    getBuddyService: () => ({ addKernelBuddyListener() {} }),
    getUixConvertService: () => ({ getUid(ids: string[]) { uidCalls.push(ids); return { uidInfo: new Map(ids.map(id => [id, 'u_friend'])) }; } }),
  }, '7.0.2-53644', () => {});
  return { services, calls, uidCalls };
}
for (const privatePeer of [false, true]) {
  test(`getMessage ${privatePeer ? 'private' : 'group'} preserves ID and native peer and returns normalized raw`, async () => {
    const raw = rawMessage(privatePeer), f = fixture({ result: 0, msgList: [raw] });
    const peer = privatePeer ? { type: 'private', userId: '456' } : { type: 'group', groupId: '123' };
    try {
      const message = await f.services.invokeOperation('getMessage', { peer, messageId }) as any;
      assert.deepEqual(f.calls, [[{ chatType: privatePeer ? 1 : 2, peerUid: privatePeer ? 'u_friend' : '123' }, [messageId]]]);
      assert.equal(message.messageId, messageId);
      assert.deepEqual(message.peer, peer);
      assert.deepEqual(message.elements, [{ type: 'text', text: 'fixture only' }]);
      assert.deepEqual(message.raw, raw);
    } finally { f.services.close(); }
  });
}
test('empty successful list returns undefined; close prevents future lookup', async () => {
  const f = fixture({ result: 0, msgList: [] });
  assert.equal(await f.services.invokeOperation('getMessage', { peer: { type: 'group', groupId: '123' }, messageId }), undefined);
  f.services.close();
  await assert.rejects(f.services.invokeOperation('getMessage', { peer: { type: 'private', userId: '456' }, messageId }), /closed/);
  assert.equal(f.calls.length, 1); assert.equal(f.uidCalls.length, 0);
});
test('native getMessage rejection preserves code and never retries', async () => {
  const f = fixture({ result: 23, msgList: [] });
  try {
    await assert.rejects(f.services.invokeOperation('getMessage', { peer: { type: 'group', groupId: '123' }, messageId }), { code: 23 });
    assert.equal(f.calls.length, 1);
  } finally { f.services.close(); }
});
for (const [name, result] of [
  ['missing result', { msgList: [] }], ['bad list', { result: 0, msgList: {} }],
  ['duplicate ID', { result: 0, msgList: [rawMessage(), rawMessage()] }],
  ['wrong conversation', { result: 0, msgList: [{ ...rawMessage(), peerUid: '999' }] }],
  ['wrong ID', { result: 0, msgList: [{ ...rawMessage(), msgId: 'other' }] }],
  ['invalid elements', { result: 0, msgList: [{ ...rawMessage(), elements: {} }] }],
] as const) {
  test(`getMessage rejects ${name} as invalid native response`, async () => {
    const f = fixture(result);
    try {
      await assert.rejects(f.services.invokeOperation('getMessage', { peer: { type: 'group', groupId: '123' }, messageId }), /invalid|mismatch|duplicate|unexpected|conversation|message.*list|result|element/i);
      assert.equal(f.calls.length, 1);
    } finally { f.services.close(); }
  });
}
for (const [peer, id] of [
  [{ type: 'private', userId: '' }, messageId], [{ type: 'group', groupId: '' }, messageId],
  [{ type: 'unknown', userId: '456' }, messageId], [{ type: 'private', userId: '456' }, ''],
  [{ type: 'private', userId: '456' }, 123],
]) {
  test(`invalid query ${JSON.stringify({ peer, id })} rejects before UID and message lookup`, async () => {
    const f = fixture();
    try {
      await assert.rejects(f.services.invokeOperation('getMessage', { peer, messageId: id }), /peer|identifier|message.?id|target|string/i);
      assert.equal(f.calls.length, 0); assert.equal(f.uidCalls.length, 0);
    } finally { f.services.close(); }
  });
}
