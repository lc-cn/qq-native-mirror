import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeServices } from '../src/native-services.ts';
import { queryNativeMessages } from '../src/message-query.ts';

const id = '900719925474099312345';
function raw(msgId: string, privatePeer = false) {
  return { msgId, msgSeq: '9', msgTime: '100', chatType: privatePeer ? 1 : 2,
    peerUid: privatePeer ? 'u_friend' : '123', peerUin: privatePeer ? '456' : '123',
    senderUin: '456', senderUid: 'u_friend', sendNickName: 'fixture', elements: [] };
}
function fixture(response: unknown, getUid?: () => Promise<unknown>) {
  const calls: unknown[][] = [], uidCalls: unknown[] = [];
  const services = createNativeServices({
    getMsgService: () => ({ addKernelMsgListener() {}, getMsgsByMsgId(...args: unknown[]) { calls.push(args); return response; } }),
    getGroupService: () => ({ addKernelGroupListener() {} }),
    getBuddyService: () => ({ addKernelBuddyListener() {} }),
    getUixConvertService: () => ({ getUid(ids: string[]) { uidCalls.push(ids); return getUid ? getUid() : { uidInfo: new Map([['456', 'u_friend']]) }; } }),
  }, '7.0.2-53644', () => {});
  return { services, calls, uidCalls };
}

for (const privatePeer of [false, true]) test(`batch lookup uses one ${privatePeer ? 'private' : 'group'} call and aligns reordered, missing and long IDs`, async () => {
  const f = fixture({ result: 0, msgList: [raw('2', privatePeer), raw(id, privatePeer)] });
  try {
    const messages = await f.services.invokeOperation('getMessages', { peer: privatePeer ? { type: 'private', userId: '456' } : { type: 'group', groupId: '123' }, messageIds: [id, '3', '2'] }) as any[];
    assert.deepEqual(messages.map(message => message?.messageId), [id, undefined, '2']);
    assert.equal(messages.length, 3); assert.ok(1 in messages, 'missing positions are explicit undefined');
    assert.deepEqual(f.calls, [[{ chatType: privatePeer ? 1 : 2, peerUid: privatePeer ? 'u_friend' : '123' }, [id, '3', '2']]]);
  } finally { f.services.close(); }
});

test('invalid batch input rejects before UID resolution or native lookup', async () => {
  const f = fixture({ result: 0, msgList: [] });
  try {
    for (const ids of [[], Array(1), [id, id], [42], [''], ['1.5'], Array.from({ length: 101 }, (_, i) => String(i))]) {
      await assert.rejects(f.services.invokeOperation('getMessages', { peer: { type: 'private', userId: '456' }, messageIds: ids }), /messageIds/);
    }
    await assert.rejects(f.services.invokeOperation('getMessages', { peer: { type: 'private', userId: 'bad' }, messageIds: [id] }), /peer/);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.uidCalls, []);
  } finally { f.services.close(); }
});

for (const [name, response] of [
  ['unexpected ID', { result: 0, msgList: [raw('7')] }],
  ['duplicate response ID', { result: 0, msgList: [raw(id), raw(id)] }],
  ['wrong conversation', { result: 0, msgList: [{ ...raw(id), peerUid: 'other' }] }],
  ['sparse message list', { result: 0, msgList: Array(1) }],
  ['sparse elements', { result: 0, msgList: [{ ...raw(id), elements: Array(1) }] }],
] as const) test(`batch rejects ${name} without retry or partial result`, async () => {
  const f = fixture(response);
  try {
    await assert.rejects(f.services.invokeOperation('getMessages', { peer: { type: 'group', groupId: '123' }, messageIds: [id, '2'] }), /invalid|mismatched|unexpected|duplicate/);
    assert.equal(f.calls.length, 1);
  } finally { f.services.close(); }
});

test('batch preserves rejection code and represents successful empty response by explicit missing slots', async () => {
  for (const result of [23, 'denied']) {
    const f = fixture({ result, msgList: [raw(id)] });
    try {
      await assert.rejects(f.services.invokeOperation('getMessages', { peer: { type: 'group', groupId: '123' }, messageIds: [id] }), { code: result });
      assert.equal(f.calls.length, 1);
    } finally { f.services.close(); }
  }
  const f = fixture({ result: 0, msgList: [] });
  try { assert.deepEqual(await f.services.invokeOperation('getMessages', { peer: { type: 'group', groupId: '123' }, messageIds: [id, '2'] }), [undefined, undefined]); }
  finally { f.services.close(); }
});

test('batch captures peer and IDs before asynchronous UID resolution', async () => {
  let release!: (value: unknown) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const uid = new Promise(resolve => { release = resolve; });
  const f = fixture({ result: 0, msgList: [raw(id, true)] }, () => { entered(); return uid; });
  const peer = { type: 'private', userId: '456' }, ids = [id, '2'];
  try {
    const request = f.services.invokeOperation('getMessages', { peer, messageIds: ids });
    await started; peer.userId = '999'; ids[0] = '999';
    release({ uidInfo: new Map([['456', 'u_friend']]) });
    assert.deepEqual((await request as any[]).map(message => message?.messageId), [id, undefined]);
    assert.deepEqual(f.calls, [[{ chatType: 1, peerUid: 'u_friend' }, [id, '2']]]);
  } finally { f.services.close(); }
});

test('close during UID resolution prevents native batch query', async () => {
  let release!: (value: unknown) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const uid = new Promise(resolve => { release = resolve; });
  const f = fixture({ result: 0, msgList: [] }, () => { entered(); return uid; });
  const request = f.services.invokeOperation('getMessages', { peer: { type: 'private', userId: '456' }, messageIds: [id] });
  await started; f.services.close(); release({ uidInfo: new Map([['456', 'u_friend']]) });
  await assert.rejects(request, /closed|abort/i); assert.equal(f.calls.length, 0);
});

test('close rejects dispatched batch result and does not replay it', async () => {
  let finish!: (value: unknown) => void;
  const response = new Promise(resolve => { finish = resolve; });
  const f = fixture(response);
  const request = f.services.invokeOperation('getMessages', { peer: { type: 'group', groupId: '123' }, messageIds: [id] });
  while (!f.calls.length) await new Promise<void>(resolve => setImmediate(resolve));
  f.services.close(); finish({ result: 0, msgList: [raw(id)] });
  await assert.rejects(request, /closed|abort/i); assert.equal(f.calls.length, 1);
});

test('native batch adapter preserves captured inputs if native code mutates call arguments', async () => {
  const peer = { chatType: 2 as const, peerUid: '123' }, ids = [id, '2'];
  const result = await queryNativeMessages({ getMsgsByMsgId(p: any, requested: string[]) {
    p.peerUid = 'other'; requested[0] = '999'; return { result: 0, msgList: [raw(id)] };
  } }, peer, ids);
  assert.deepEqual(result.map(message => message?.msgId), [id, undefined]);
  assert.deepEqual(peer, { chatType: 2, peerUid: '123' }); assert.deepEqual(ids, [id, '2']);
});
