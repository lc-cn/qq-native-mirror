import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecallEvents } from '../src/recall-events.ts';
import { createNativeServices } from '../src/native-services.ts';

const id = '900719925474099312345';
const record = { msgId: id, msgSeq: id, chatType: 2, peerUid: '123', recallTime: '900719925474099399999' };

test('recall metadata preserves exact native decimal strings and conversation identity', () => {
  const events: unknown[] = [];
  const listener = createRecallEvents((event, payload) => events.push([event, payload]));
  listener.onMessageUpdate(record);
  listener.onMessageUpdate({ ...record, chatType: 1, peerUid: 'u_friend', peerUin: '000456', msgTime: '1', senderUin: '999', operator: 'unproven' });
  assert.deepEqual(events, [
    ['message.recalled', { peer: { type: 'group', groupId: '123' }, messageId: id, sequence: id, recallTime: record.recallTime }],
    ['message.recalled', { peer: { type: 'private', userId: '000456' }, messageId: id, sequence: id, recallTime: record.recallTime }],
  ]);
});

test('unrecalled updates stay silent; invalid recall candidates never fabricate fields or consume IDs', () => {
  const events: [string, unknown][] = [];
  const listener = createRecallEvents((event, payload) => events.push([event, payload]));
  for (const recallTime of [undefined, '0', '000']) listener.onMessageUpdate({ ...record, recallTime });
  assert.deepEqual(events, []);
  for (const change of [
    { recallTime: null }, { recallTime: 123 }, { recallTime: '-1' }, { recallTime: '1.5' }, { recallTime: 'unknown' },
    { msgId: 123 }, { msgSeq: undefined }, { msgSeq: {} }, { peerUid: '' }, { peerUid: 'u_group' }, { chatType: '2' }, { chatType: 3 },
    { chatType: 1, peerUid: 'u_friend' }, { chatType: 1, peerUid: 'u_friend', peerUin: '0' }, { chatType: 1, peerUin: 456 },
  ]) {
    listener.onMessageUpdate({ ...record, ...change, credential: 'fixture-secret' });
    assert.deepEqual(events.at(-1), ['diagnostic', { stage: 'invalid-native-recall-update' }]);
  }
  assert.ok(events.every(([event]) => event === 'diagnostic'));
  assert.doesNotMatch(JSON.stringify(events), /fixture-secret|credential/);
  listener.onMessageUpdate(record);
  assert.equal(events.at(-1)?.[0], 'message.recalled', 'invalid records do not suppress a later valid update');
});

test('replay deduplication is scoped to chat type, native peer UID and message ID', () => {
  const events: unknown[] = [];
  const listener = createRecallEvents((event, payload) => events.push([event, payload]));
  listener.onMessageUpdate(record);
  listener.onMessageUpdate({ ...record, recallTime: '101' });
  listener.onMessageUpdate({ ...record, peerUid: '456' });
  listener.onMessageUpdate({ ...record, chatType: 1, peerUin: '123' });
  listener.onMessageUpdate({ ...record, msgId: '42' });
  assert.equal(events.length, 4);
  const another = createRecallEvents((event, payload) => events.push([event, payload]));
  another.onMessageUpdate(record);
  assert.equal(events.length, 5, 'another Session has its own replay window');
});

test('recall replay memory is bounded and explicitly cleared on close', () => {
  let observed = 0;
  const listener = createRecallEvents(() => observed++);
  for (let i = 0; i <= 10_000; i++) listener.onMessageUpdate({ ...record, msgId: String(i) });
  listener.onMessageUpdate({ ...record, msgId: '10000' });
  assert.equal(observed, 10_001);
  listener.onMessageUpdate({ ...record, msgId: '0' });
  assert.equal(observed, 10_002, 'oldest replay entry was evicted');
  listener.close(); listener.close(); listener.onMessageUpdate(record); listener.onMessageUpdate(null);
  assert.equal(observed, 10_002);
});

test('normalized recall payload is independent of raw payload and legacy listener mutation', () => {
  const events: [string, any][] = [];
  let msgListener: any;
  const raw = { ...record, credential: 'fixture-secret' };
  const services = createNativeServices({
    getMsgService: () => ({ addKernelMsgListener(value: any) { msgListener = value; } }),
    getBuddyService: () => ({ addKernelBuddyListener() {} }),
    getGroupService: () => ({ addKernelGroupListener() {} }),
  }, '7.0.2-53644', (event, payload) => {
    events.push([event, payload]);
    if (event === 'message-recalled') (payload as any).peerUid = '999';
  });
  try {
    msgListener.onMsgInfoListUpdate([raw]);
    assert.deepEqual(events[0], ['message.recalled', { peer: { type: 'group', groupId: '123' }, messageId: id, sequence: id, recallTime: record.recallTime }]);
    assert.equal(events[1][0], 'message-recalled'); assert.equal(events[1][1], raw);
    events[0][1].peer.groupId = 'changed';
    assert.equal(raw.peerUid, '999');
    assert.doesNotMatch(JSON.stringify(events[0]), /fixture-secret|credential/);
    services.close(); msgListener.onMsgInfoListUpdate([{ ...record, msgId: '43' }]);
    assert.equal(events.length, 2);
  } finally { services.close(); }
});

test('typed notification does not settle the wrong recall operation; raw event compatibility is retained', async () => {
  let msgListener: any, settled = false;
  const events: [string, unknown][] = [];
  const services = createNativeServices({
    getMsgService: () => ({
      addKernelMsgListener(value: any) { msgListener = value; },
      recallMsg() { msgListener.onMsgInfoListUpdate([{ ...record, peerUid: '456' }]); return { result: 0 }; },
    }),
    getBuddyService: () => ({ addKernelBuddyListener() {} }),
    getGroupService: () => ({ addKernelGroupListener() {} }),
  }, '7.0.2-53644', (event, payload) => events.push([event, payload]));
  try {
    const pending = services.invokeOperation('recallMessage', { peer: { type: 'group', groupId: '123' }, messageId: id }).then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    msgListener.onMsgInfoListUpdate([record]); await pending;
    msgListener.onMsgInfoListUpdate([{ ...record }]);
    assert.equal(settled, true);
    assert.equal(events.filter(([event]) => event === 'message.recalled').length, 2);
    assert.equal(events.filter(([event]) => event === 'message-recalled').length, 3);
  } finally { services.close(); }
});
