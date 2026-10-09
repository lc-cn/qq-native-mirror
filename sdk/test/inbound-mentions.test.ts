import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeResolvedElementBatches } from '../src/inbound-mentions.ts';
import { createNativeServices } from '../src/native-services.ts';

const mention = (uid = 'u_friend') => ({ elementType: 1, textElement: { atType: 2, atUid: '0', atNtUid: uid, content: '@friend' } });
const raw = (msgId: string, elements = [mention()]) => ({ msgId, msgSeq: '9', msgTime: '100', chatType: 2, peerUid: '123', peerUin: '123', senderUin: '456', senderUid: 'u_friend', sendNickName: 'friend', elements });
const peer = { type: 'group', groupId: '123' };
const turn = () => new Promise(resolve => setImmediate(resolve));

test('UID-only mentions use one exact keyed lookup per batch while preserving original IDs and order', async () => {
  const calls: unknown[] = [], stages: string[] = [];
  const result = await decodeResolvedElementBatches([[mention(), mention()], [mention('u_other')]], async uids => {
    calls.push(uids); return new Map([['u_friend', '900719925474099312345'], ['u_other', '000456']]);
  }, new AbortController().signal, stage => stages.push(stage));
  assert.deepEqual(calls, [['u_friend', 'u_other']]); assert.deepEqual(stages, []);
  assert.deepEqual(result, [
    [{ type: 'at', userId: '900719925474099312345', text: '@friend' }, { type: 'at', userId: '900719925474099312345', text: '@friend' }],
    [{ type: 'at', userId: '000456', text: '@friend' }],
  ]);
});

test('bad or missing UID mapping retains native evidence and never creates false IDs or retries', async () => {
  const element = mention();
  for (const value of [new Map(), new Map([['wrong', '456']]), new Map([['u_friend', '0']]), new Map([['u_friend', 'u_fake']]), new Map([['u_friend', 456]]), {}, null]) {
    let calls = 0; const stages: string[] = [];
    const result = await decodeResolvedElementBatches([[element]], async () => { calls++; return value as any; }, new AbortController().signal, stage => stages.push(stage));
    assert.deepEqual(result, [[{ type: 'unknown', nativeType: 1, data: element }]]);
    assert.equal(calls, 1); assert.equal(stages.length, 1);
  }
  let calls = 0; const stages: string[] = [];
  const result = await decodeResolvedElementBatches([[element]], async () => { calls++; throw new Error('credential-fixture'); }, new AbortController().signal, stage => stages.push(stage));
  assert.equal(result[0][0].type, 'unknown'); assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(stages), /credential-fixture/);
});

test('awaiting UID conversion cannot change captured mention fields or message routing', async () => {
  let finish!: (value: any) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const message = raw('1');
  try {
    f.listener().onRecvMsg([message]); await turn();
    message.peerUid = '999'; message.msgId = '2'; message.elements[0].textElement.atNtUid = 'u_other'; message.elements[0].textElement.content = '@changed';
    finish({ uinInfo: new Map([['u_friend', '456']]) }); await turn();
    const result = f.events.find(([name]) => name === 'message')?.[1];
    assert.equal(result.messageId, '1'); assert.deepEqual(result.peer, { type: 'group', groupId: '123' });
    assert.deepEqual(result.elements, [{ type: 'at', userId: '456', text: '@friend' }]); assert.equal(result.raw, message);
    f.listener().onRecvMsg([raw('1')]); await turn(); assert.equal(f.calls.length, 1, 'replay uses the captured native identity');
  } finally { f.services.close(); }
});

test('native identity deadline releases decoding with unknown evidence after one lookup', async () => {
  let calls = 0; const stages: string[] = [];
  const result = await decodeResolvedElementBatches([[mention()]], async () => { calls++; return new Promise(() => {}); }, new AbortController().signal, stage => stages.push(stage));
  assert.equal(result[0][0].type, 'unknown'); assert.deepEqual(stages, ['native-mention-lookup-failed']); assert.equal(calls, 1);
});

test('all batches validate before identity calls and abort prevents or promptly stops awaiting a lookup', async () => {
  let calls = 0;
  await assert.rejects(decodeResolvedElementBatches([[mention()], Array(1)], async () => { calls++; return new Map(); }, new AbortController().signal, () => {}), /Invalid/);
  assert.equal(calls, 0);
  const before = new AbortController(); before.abort();
  await assert.rejects(decodeResolvedElementBatches([[mention()]], async () => { calls++; return new Map(); }, before.signal, () => {}), /abort/i);
  assert.equal(calls, 0);
  const during = new AbortController(); let begin!: () => void;
  const begun = new Promise<void>(resolve => { begin = resolve; });
  const pending = decodeResolvedElementBatches([[mention()]], async () => { calls++; begin(); return new Promise(() => {}); }, during.signal, () => {});
  const stopped = assert.rejects(pending, /abort/i); await begun; during.abort(); await stopped;
  assert.equal(calls, 1);
});

function fixture(lookup: (uids: string[]) => any) {
  let listener: any; const events: [string, any][] = [], calls: string[][] = [];
  const services = createNativeServices({
    getMsgService: () => ({
      addKernelMsgListener(value: any) { listener = value; },
      getMsgsByMsgId(_peer: unknown, ids: string[]) { return { result: 0, msgList: [raw(ids[0])] }; },
      getMsgsIncludeSelf() { return { result: 0, msgList: [raw('1'), raw('2')] }; },
      getMultiMsg() { return { result: 0, msgList: [raw('1')] }; },
    }),
    getBuddyService: () => ({ addKernelBuddyListener() {} }),
    getGroupService: () => ({ addKernelGroupListener() {} }),
    getUixConvertService: () => ({ getUin(uids: string[]) { calls.push(uids); return lookup(uids); } }),
  }, '7.0.2-53644', (event, payload) => events.push([event, payload]));
  return { services, events, calls, listener: () => listener };
}

test('native getMessage, history and merged-history use the same exact UID identity conversion', async () => {
  const f = fixture(() => ({ uinInfo: new Map([['u_friend', '456']]) }));
  try {
    for (const [method, payload] of [
      ['getMessage', { peer, messageId: '1' }], ['getHistory', { peer, options: {} }],
      ['getForwardMessages', { peer, rootMessageId: '10', parentMessageId: '20' }],
    ] as const) {
      const result = await f.services.invokeOperation(method, payload);
      const messages = Array.isArray(result) ? result : [result];
      for (const message of messages) assert.deepEqual(message.elements, [{ type: 'at', userId: '456', text: '@friend' }]);
    }
    assert.deepEqual(f.calls, [['u_friend'], ['u_friend'], ['u_friend']]);
  } finally { f.services.close(); }
});

test('real-time UID lookup preserves batch and callback order and replay makes no identity query', async () => {
  let finish!: (value: unknown) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  try {
    f.listener().onRecvMsg([raw('1'), raw('2', [])]);
    f.listener().onRecvMsg([raw('1'), raw('3', [])]);
    await turn(); assert.equal(f.events.length, 0); assert.equal(f.calls.length, 1);
    finish({ uinInfo: new Map([['u_friend', '456']]) });
    await turn(); await turn();
    assert.deepEqual(f.events.filter(([name]) => name === 'message').map(([, value]) => value.messageId), ['1', '2', '3']);
    assert.equal(f.calls.length, 1);
    f.listener().onRecvMsg([raw('1')]); await turn();
    assert.equal(f.calls.length, 1, 'a known replay cannot initiate another UID lookup');
  } finally { f.services.close(); }
});

test('queued callbacks capture message fields before an earlier native identity request settles', async () => {
  let finish!: (value: unknown) => void, calls = 0;
  const f = fixture(() => calls++ === 0 ? new Promise(resolve => { finish = resolve; }) : { uinInfo: new Map([['u_friend', '456']]) });
  const second = raw('2');
  try {
    f.listener().onRecvMsg([raw('1')]); f.listener().onRecvMsg([second]);
    second.msgId = '99'; second.peerUid = '999'; second.elements[0].textElement.atNtUid = 'u_changed'; second.elements[0].textElement.content = '@changed';
    await turn(); finish({ uinInfo: new Map([['u_friend', '456']]) }); await turn(); await turn();
    const messages = f.events.filter(([name]) => name === 'message').map(([, value]) => value);
    assert.deepEqual(messages.map(message => message.messageId), ['1', '2']);
    assert.deepEqual(messages[1].peer, { type: 'group', groupId: '123' });
    assert.deepEqual(messages[1].elements, [{ type: 'at', userId: '456', text: '@friend' }]);
    assert.equal(messages[1].raw, second); assert.deepEqual(f.calls, [['u_friend'], ['u_friend']]);
    f.listener().onRecvMsg([raw('2')]); await turn(); assert.equal(f.calls.length, 2);
  } finally { f.services.close(); }
});

test('close suppresses in-flight and queued messages and all delayed queried results', async () => {
  for (const method of ['getMessage', 'getHistory', 'getForwardMessages'] as const) {
    let begin!: () => void; const begun = new Promise<void>(resolve => { begin = resolve; });
    const f = fixture(() => { begin(); return new Promise(() => {}); });
    try {
      const payload = method === 'getMessage' ? { peer, messageId: '1' } : method === 'getHistory' ? { peer, options: {} } : { peer, rootMessageId: '10', parentMessageId: '20' };
      const stopped = assert.rejects(f.services.invokeOperation(method, payload), /abort|closed/i);
      await begun; f.services.close(); await stopped; assert.equal(f.calls.length, 1);
    } finally { f.services.close(); }
  }
  const f = fixture(() => new Promise(() => {}));
  f.listener().onRecvMsg([raw('1')]); f.listener().onRecvMsg([raw('2', [])]);
  await turn(); f.services.close(); await turn();
  assert.equal(f.events.length, 0); assert.equal(f.calls.length, 1);
});

test('failed receive identity lookup preserves message evidence and does not poison later delivery', async () => {
  const f = fixture(() => { throw new Error('private-native-details'); });
  try {
    f.listener().onRecvMsg([raw('1')]); f.listener().onRecvMsg([raw('2', [])]);
    await turn(); await turn();
    const messages = f.events.filter(([name]) => name === 'message').map(([, value]) => value);
    assert.deepEqual(messages.map(value => value.messageId), ['1', '2']);
    assert.equal(messages[0].elements[0].type, 'unknown');
    assert.doesNotMatch(JSON.stringify(f.events.filter(([name]) => name === 'diagnostic')), /private-native-details/);
  } finally { f.services.close(); }
});

test('invalid or sparse received records emit bounded diagnostics while valid neighboring messages remain deliverable', () => {
  const f = fixture(() => { throw new Error('lookup must not occur'); });
  try {
    const batch = Array(3); batch[1] = raw('1', Array(1)); batch[2] = raw('2', []);
    f.listener().onRecvMsg(batch);
    assert.deepEqual(f.events.filter(([name]) => name === 'diagnostic'), [
      ['diagnostic', { stage: 'invalid-native-message' }], ['diagnostic', { stage: 'invalid-native-message' }],
    ]);
    assert.deepEqual(f.events.filter(([name]) => name === 'message').map(([, value]) => value.messageId), ['2']);
    assert.deepEqual(f.calls, []);
  } finally { f.services.close(); }
});
