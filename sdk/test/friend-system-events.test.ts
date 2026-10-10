import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createFriendSystemEvents } from '../src/features/contacts/friend-system-events.ts';
import { createNativeServices } from '../src/native-services.ts';
import { observeWatchEvents } from '../src/cli.ts';

const notice = (msgId = '1', uid = 'u_friend', busiId: unknown = '19324'): any => ({
  msgId,
  chatType: 1,
  msgType: 5,
  peerUid: uid,
  elements: [
    {
      grayTipElement: {
        subElementType: 17,
        jsonGrayTipElement: { busiId, jsonStr: 'not interpreted' },
      },
    },
  ],
});
const harness = () => {
  const events: [string, any][] = [];
  return {
    events,
    listener: createFriendSystemEvents((name, value) => events.push([name, value])),
  };
};

test('explicit first-element friend-added notice preserves UID and optional decimal UIN without inferred fields', () => {
  const { events, listener } = harness();
  const raw = {
    ...notice(),
    peerUin: '900719925474099312345',
    msgTime: '123',
    senderUid: 'u_self',
    privateField: 'secret',
  };
  listener.onRecvMsg([raw, notice('2', 'u_second', 19324)]);
  assert.deepEqual(events, [
    ['friend-added', { uid: 'u_friend', messageId: '1', userId: '900719925474099312345' }],
    ['friend-added', { uid: 'u_second', messageId: '2' }],
  ]);
  raw.peerUid = 'changed';
  raw.peerUin = '999';
  assert.equal(events[0][1].uid, 'u_friend');
  assert.equal(events[0][1].userId, '900719925474099312345');
  assert.deepEqual(Object.keys(events[0][1]), ['uid', 'messageId', 'userId']);
});

test('empty peer UID does not emit; zero/empty/absent optional UIN remains absent', () => {
  const { events, listener } = harness();
  listener.onRecvMsg([
    notice('1', ''),
    { ...notice('2'), peerUin: '' },
    { ...notice('3'), peerUin: '000' },
    notice('4'),
  ]);
  assert.deepEqual(
    events.map(([, value]) => value),
    [
      { uid: 'u_friend', messageId: '2' },
      { uid: 'u_friend', messageId: '3' },
      { uid: 'u_friend', messageId: '4' },
    ],
  );
  assert.equal(listener.hasAddedCandidate([notice('5', '')]), false);
});

test('private SDK scope, exact type/subtype/business ID and first element reject false-positive relationship events', () => {
  const { events, listener } = harness();
  const wrong = [
    { ...notice(), chatType: 2 },
    { ...notice(), chatType: 100 },
    { ...notice(), msgType: 0 },
    notice('1', 'u', '019324'),
    notice('1', 'u', '1061'),
    notice('1', 'u', 19325),
    {
      ...notice(),
      elements: [
        { grayTipElement: { subElementType: 4, jsonGrayTipElement: { busiId: '19324' } } },
      ],
    },
    { ...notice(), elements: [{}, notice().elements[0]] },
  ];
  for (const value of wrong) {
    assert.equal(listener.hasAddedCandidate([value]), false);
    listener.onRecvMsg([value]);
  }
  assert.equal(events.length, 0);
  const more = notice();
  more.elements.push({ textElement: { content: 'additional' } });
  listener.onRecvMsg([more]);
  assert.equal(
    events[0][0],
    'friend-added',
    'no invented exactly-one-element or elementType guard',
  );
});

test('known candidate batch is captured atomically and malformed rows do not consume dedup', () => {
  const { events, listener } = harness();
  for (const bad of [
    null,
    undefined,
    [],
    { ...notice('2'), peerUid: ' ' },
    { ...notice('2'), msgId: 2 },
    { ...notice('2'), msgId: '0' },
    { ...notice('2'), peerUin: 'invalid' },
  ]) {
    listener.onRecvMsg([notice(), bad]);
    assert.equal(events.at(-1)?.[0], 'diagnostic');
  }
  assert.equal(events.length, 7);
  listener.onRecvMsg([notice()]);
  assert.equal(events[7][0], 'friend-added');
});

test('accessors, arbitrary business-ID coercion and thrown proxy traps never escape the projector', () => {
  const { events, listener } = harness();
  let reads = 0;
  const raw = notice();
  Object.defineProperty(raw, 'peerUid', {
    get() {
      reads++;
      return 'u';
    },
  });
  assert.equal(
    listener.hasAddedCandidate([raw]),
    true,
    'recognized business shape keeps malformed identity in validation path',
  );
  listener.onRecvMsg([raw]);
  const business = notice('2', 'u', {
    toString() {
      reads++;
      return '19324';
    },
  });
  assert.equal(listener.hasAddedCandidate([business]), false);
  listener.onRecvMsg([business]);
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error('private trap payload');
      },
    },
  );
  assert.equal(listener.hasAddedCandidate([proxy]), false);
  listener.onRecvMsg([notice('3'), proxy]);
  const indexed = [notice('4')];
  Object.defineProperty(indexed, '0', {
    get() {
      reads++;
      return notice('4');
    },
  });
  listener.onRecvMsg(indexed);
  assert.equal(reads, 0);
  assert.deepEqual(events, [
    ['diagnostic', { stage: 'invalid-native-friend-added-message' }],
    ['diagnostic', { stage: 'invalid-native-friend-added-message' }],
    ['diagnostic', { stage: 'invalid-native-friend-added-message' }],
  ]);
});

test('sparse batches and bounded malformed identifiers reject without partial event or leaked native input', () => {
  const { events, listener } = harness();
  const sparse = Array(2);
  sparse[1] = notice();
  assert.equal(listener.hasAddedCandidate(sparse), true);
  listener.onRecvMsg(sparse);
  for (const value of [
    Array(4097),
    [notice('1', 'u\0bad')],
    [notice('2', 'u\ud800')],
    [notice('3', 'u'.repeat(4097))],
    [notice('4'.repeat(4097))],
  ])
    listener.onRecvMsg(value);
  assert.equal(events.length, 6);
  assert.ok(
    events.every(([name, value]) => name === 'diagnostic' && Object.keys(value).join() === 'stage'),
  );
});

test('bounded dedup uses native UID and message ID; same UID with new message ID remains a new notice', () => {
  const { events, listener } = harness();
  listener.onRecvMsg([notice(), notice(), notice('2'), notice('1', 'u_other')]);
  assert.equal(events.length, 3);
  for (let i = 3; i < 2053; i++) listener.onRecvMsg([notice(String(i))]);
  const previous = events.length;
  listener.onRecvMsg([notice()]);
  assert.equal(events.length, previous + 1, 'old entry evicted from bounded cache');
});

test('close is idempotent and a synchronous close during emission suppresses the rest of the batch', () => {
  const events: unknown[] = [];
  const listener = createFriendSystemEvents((name, value) => {
    events.push([name, value]);
    listener.close();
  });
  listener.onRecvMsg([notice(), notice('2')]);
  listener.close();
  listener.onRecvMsg([notice('3')]);
  listener.onRecvMsg([null]);
  assert.equal(listener.hasAddedCandidate([notice('4')]), false);
  assert.equal(events.length, 1);
});

test('all/normalized watch includes friend-added and default watch stays message-only; cleanup removes listeners', () => {
  for (const mode of ['all', 'normalized', undefined] as const) {
    const events = new EventEmitter(),
      lines: any[] = [];
    const stop = observeWatchEvents(events as any, mode, (line) => lines.push(JSON.parse(line)));
    const payload = { uid: 'u_friend', messageId: '1' };
    events.emit('friend-added', payload);
    assert.deepEqual(lines, mode ? [{ event: 'friend-added', payload }] : []);
    stop();
    assert.equal(events.listenerCount('friend-added'), 0);
  }
});

test('native Msg callback emits friend notice independently of normal decoding and Session close suppresses retained callback', () => {
  let callback: any;
  let lookups = 0;
  const events: [string, any][] = [];
  const services = createNativeServices({
    session: {
      getMsgService: () => ({
        addKernelMsgListener(value: any) {
          callback = value;
        },
      }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getUixConvertService: () => ({
        getUin() {
          lookups++;
          return { uinInfo: new Map() };
        },
      }),
    },
    version: '7.0.2-53644',
    events: { emit: (name, value) => events.push([name, value]) },
  });
  callback.onRecvMsg([notice()]);
  callback.onRecvMsg([notice()]);
  assert.deepEqual(
    events.filter(([name]) => name === 'friend-added'),
    [['friend-added', { uid: 'u_friend', messageId: '1' }]],
  );
  assert.equal(lookups, 0, 'notice does not perform implicit UID lookup');
  services.close();
  const previous = events.length;
  callback.onRecvMsg([notice('2')]);
  assert.equal(events.length, previous);
});

test('closing native services synchronously from notice listener prevents later decoding/query', () => {
  let callback: any;
  const events: [string, any][] = [];
  const service: ReturnType<typeof createNativeServices> = createNativeServices({
    session: {
      getMsgService: () => ({
        addKernelMsgListener(value: any) {
          callback = value;
        },
      }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
    },
    version: '7.0.2-53644',
    events: {
      emit: (name, value) => {
        events.push([name, value]);
        if (name === 'friend-added') service.close();
      },
    },
  });
  callback.onRecvMsg([notice(), notice('2')]);
  assert.deepEqual(events, [['friend-added', { uid: 'u_friend', messageId: '1' }]]);
});
