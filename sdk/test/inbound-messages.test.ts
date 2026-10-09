import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeServices } from '../src/native-services.ts';
const turn = () => new Promise(resolve => setImmediate(resolve));
const text = { elementType: 1, textElement: { atType: 0, content: 'fixture' } };
const raw = (change = {}) => ({ chatType: 1, peerUid: 'u_peer', peerUin: '0', senderUid: 'u_sender', senderUin: '', sendNickName: 'fixture', msgId: '1', msgSeq: '0009', msgTime: '100', elements: [text], ...change });
function fixture(records: any[], resolver = async (_ids: string[]) => ({ uinInfo: new Map([['u_peer', '000456'], ['u_sender', '900719925474099312345']]) })) {
  let listener: any;
  const calls: string[][] = [], events: [string, any][] = [];
  const services = createNativeServices({
    getMsgService: () => ({ addKernelMsgListener(value: any) { listener = value; }, getMsgsByMsgId: () => ({ result: 0, msgList: records }), getMsgsIncludeSelf: () => ({ result: 0, msgList: records }), getMultiMsg: () => ({ result: 0, msgList: records }) }),
    getBuddyService: () => ({ addKernelBuddyListener() {} }), getGroupService: () => ({ addKernelGroupListener() {} }),
    getUixConvertService: () => ({ getUid: () => ({ uidInfo: new Map([['456', 'u_peer']]) }), getUin(ids: string[]) { calls.push(ids); return resolver(ids); } }),
  }, '7.0.2-53644', (event, value) => events.push([event, value]));
  return { services, calls, events, listener: () => listener };
}
const peer = { type: 'private', userId: '456' };
for (const method of ['getMessage', 'getHistory', 'getForwardMessages'] as const) test(`${method} resolves peer and sender UID without fabricated QQ IDs`, async () => {
  const f = fixture([raw()]);
  try {
    const result: any = await f.services.invokeOperation(method, { peer, messageId: '1', rootMessageId: '10', parentMessageId: '20', options: {} });
    const message = Array.isArray(result) ? result[0] : result;
    assert.deepEqual(message.peer, { type: 'private', userId: '000456' });
    assert.deepEqual(message.sender, { userId: '900719925474099312345', uid: 'u_sender', nickname: 'fixture' });
    assert.equal(message.sequence, '0009'); assert.deepEqual(f.calls, [['u_peer', 'u_sender']]);
  } finally { f.services.close(); }
});

for (const [field, value] of [['msgSeq', undefined], ['msgTime', 'garbage'], ['msgTime', '9007199254740993'], ['senderUin', {}], ['sendNickName', {}]] as [string, unknown][]) test(`history rejects invalid ${field} before UID work`, async () => {
  const f = fixture([raw(), raw({ msgId: '2', [field]: value })]);
  try { await assert.rejects(f.services.invokeOperation('getHistory', { peer, options: {} }), /invalid|native|metadata|nickname/i); assert.equal(f.calls.length, 0); }
  finally { f.services.close(); }
});

test('incoming missing identity gets one merged lookup with mentions and preserves replay/order', async () => {
  const mention = { elementType: 1, textElement: { atType: 2, atUid: '0', atNtUid: 'u_sender', content: '@fixture' } };
  const f = fixture([]);
  try {
    f.listener().onRecvMsg([raw({ elements: [mention] }), raw({ msgId: '2' })]); await turn(); await turn();
    const messages = f.events.filter(([event]) => event === 'message').map(([, value]) => value);
    assert.deepEqual(messages.map(message => message.messageId), ['1', '2']); assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0], ['u_peer', 'u_sender']);
    assert.deepEqual(messages[0].elements, [{ type: 'at', userId: '900719925474099312345', text: '@fixture' }]);
    f.listener().onRecvMsg([raw()]); await turn(); assert.equal(f.calls.length, 1);
  } finally { f.services.close(); }
});

test('unresolved required identity rejects read instead of returning false account fields', async () => {
  for (const value of [{ uinInfo: new Map() }, { uinInfo: new Map([['u_peer', '0'], ['u_sender', 456]]) }, { uinInfo: {} }]) {
    const f = fixture([raw()], async () => value as any);
    try { await assert.rejects(f.services.invokeOperation('getMessage', { peer, messageId: '1' }), /unresolved.*identity/i); assert.equal(f.calls.length, 1); }
    finally { f.services.close(); }
  }
});

test('existing UIN identity stays synchronous without requiring sender UID or nickname', () => {
  const f = fixture([]);
  try {
    f.listener().onRecvMsg([raw({ chatType: 2, peerUid: '000123', peerUin: undefined, senderUin: '000456', senderUid: undefined, sendNickName: undefined })]);
    assert.equal(f.calls.length, 0);
    const value = f.events.find(([event]) => event === 'message')![1];
    assert.deepEqual(value.peer, { type: 'group', groupId: '000123' });
    assert.deepEqual(value.sender, { userId: '000456', uid: '', nickname: '' });
  } finally { f.services.close(); }
});

test('failed live identity is diagnosed while complete neighbor delivers; no raw details leak', async () => {
  const f = fixture([], async () => { throw Error('private-source-fixture'); });
  try {
    f.listener().onRecvMsg([raw(), raw({ msgId: '2', peerUin: '456', senderUin: '789' })]); await turn(); await turn();
    assert.deepEqual(f.events.filter(([event]) => event === 'message').map(([, value]) => value.messageId), ['2']);
    assert.ok(f.events.some(([event, value]) => event === 'diagnostic' && value.stage === 'unresolved-native-message-identity'));
    assert.doesNotMatch(JSON.stringify(f.events.filter(([event]) => event === 'diagnostic')), /private-source-fixture|u_sender|u_peer/);
    assert.equal(f.calls.length, 1);
  } finally { f.services.close(); }
});

test('close stops unresolved queried message even when UID lookup never settles', async () => {
  const f = fixture([raw()], async () => new Promise(() => {}));
  const pending = assert.rejects(f.services.invokeOperation('getMessage', { peer, messageId: '1' }), /closed|abort/i);
  await turn(); f.services.close(); await pending; assert.equal(f.calls.length, 1);
});

test('pending UID lookup captures metadata and nonmention media paths before raw mutation', async () => {
  let finish: any;
  const original = raw({ elements: [{ elementType: 2, picElement: { filePath: '/tmp/original.png' } }] as any });
  const f = fixture([original], () => new Promise(resolve => { finish = resolve; }));
  try {
    const pending = f.services.invokeOperation('getMessage', { peer, messageId: '1' }); await turn();
    original.senderUid = 'u_changed'; original.peerUid = 'u_changed'; original.msgId = '2';
    original.elements[0].picElement.filePath = '/tmp/changed.png';
    finish({ uinInfo: new Map([['u_peer', '456'], ['u_sender', '789']]) });
    const value = await pending as any;
    assert.equal(value.messageId, '1'); assert.equal(value.sender.userId, '789'); assert.equal(value.raw, original);
    assert.deepEqual(value.elements, [{ type: 'image', file: '/tmp/original.png' }]);
  } finally { f.services.close(); }
});

test('live private record with known UIN needs no peer UID and replays stay peer-scoped', () => {
  const f = fixture([]);
  try {
    const first = raw({ peerUid: undefined, peerUin: '456', senderUid: undefined, senderUin: '789', elements: [] });
    f.listener().onRecvMsg([first, { ...first }]);
    f.listener().onRecvMsg([{ ...first, peerUin: '999' }]);
    assert.deepEqual(f.events.filter(([event]) => event === 'message').map(([, message]) => message.peer.userId), ['456', '999']);
    assert.equal(f.calls.length, 0);
  } finally { f.services.close(); }
});

test('unknown received elements retain original native evidence through identity snapshots', async () => {
  const unknown = { elementType: 999, payload: { fixture: true } };
  const record = raw({ elements: [unknown] as any });
  const f = fixture([record]);
  try {
    const result = await f.services.invokeOperation('getMessage', { peer, messageId: '1' }) as any;
    assert.equal(result.elements[0].type, 'unknown'); assert.equal(result.elements[0].data, unknown); assert.equal(result.raw, record);
    f.listener().onRecvMsg([record]); await turn(); await turn();
    const received = f.events.find(([event]) => event === 'message')![1];
    assert.equal(received.elements[0].data, unknown); assert.equal(received.raw, record);
  } finally { f.services.close(); }
});
