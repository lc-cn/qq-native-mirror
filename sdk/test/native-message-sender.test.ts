import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNativeMessageSender,
  type MessageSendPort,
} from '../src/features/messages/native-message-sender.ts';
import { createNativeEventChannel } from '../src/runtime/native-event-channel.ts';
import { buildMergedForwardCard } from '../src/features/forward/merged-forward-card.ts';
import type { PreparedSendElement } from '../src/native/prepared-message-contracts.ts';
const peer = { chatType: 2 as const, peerUid: '123' };
function fixture(uidFor: (id: string) => Promise<string> = async () => 'u_fixture') {
  const controller = new AbortController();
  const channel = createNativeEventChannel(controller.signal);
  const calls: string[] = [];
  let unique: unknown = 'unique';
  let sendCalls = 0;
  let invoke: () => unknown = () => ({ result: 0 });
  const submitted: PreparedSendElement[][] = [];
  const msg: MessageSendPort = {
    generateMsgUniqueId() {
      assert.equal(this, msg);
      calls.push('unique');
      return unique;
    },
    sendMsg(id, destination, elements) {
      assert.equal(this, msg);
      assert.equal(id, '0');
      calls.push('send');
      sendCalls++;
      submitted.push(elements);
      channel.dispatch('Msg/onMsgInfoListUpdate', [
        [
          {
            guildId: destination.guildId,
            chatType: 1,
            peerUid: '456',
            sendStatus: 2,
            msgId: '99',
            msgSeq: '9',
            msgTime: '100',
          },
          { guildId: destination.guildId, chatType: 2, peerUid: '123', sendStatus: 0 },
          {
            guildId: destination.guildId,
            chatType: 2,
            peerUid: '123',
            sendStatus: 2,
            msgId: '42',
            msgSeq: '9',
            msgTime: '100',
          },
        ],
      ]);
      return invoke();
    },
  };
  const sender = createNativeMessageSender({
    signal: controller.signal,
    getMessageService() {
      calls.push('Msg');
      return msg;
    },
    getServerTimeService() {
      calls.push('MSF');
      return {
        getServerTime() {
          calls.push('time');
          return '100';
        },
      };
    },
    awaitAlive: async (value) => value,
    uidFor,
    eventCall: channel.call,
  });
  return {
    sender,
    channel,
    controller,
    calls,
    submitted,
    get sendCalls() {
      return sendCalls;
    },
    setUnique(value: unknown) {
      unique = value;
    },
    setInvoke(value: () => unknown) {
      invoke = value;
    },
  };
}
test('construction is lazy and send keeps native ordering, correct peer correlation and success priority', async () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  const receipt = await f.sender.send(peer, 'fixture');
  assert.equal(receipt.messageId, '42');
  assert.deepEqual(f.calls, ['Msg', 'MSF', 'time', 'unique', 'send']);
  f.sender.close();
  f.channel.close();
});
test('sender captures all elements before UID resolution can mutate caller input', async () => {
  const input = [
    { type: 'at', userId: '123' },
    { type: 'text', text: 'captured' },
  ];
  const f = fixture(async () => {
    input[1]!.text = 'mutated';
    input.length = 1;
    return 'u_fixture';
  });
  try {
    await f.sender.send(peer, input);
    const elements = f.submitted[0]!;
    assert.equal(elements.length, 2);
    assert.deepEqual(elements[1], {
      elementType: 1,
      elementId: '',
      textElement: {
        content: 'captured',
        atType: 0,
        atUid: '',
        atTinyId: '',
        atNtUid: '',
      },
    });
  } finally {
    f.sender.close();
    f.channel.close();
  }
});
const sparseInput = new Array<unknown>(2);
sparseInput[0] = { type: 'text', text: 'valid' };
for (const [name, input] of [
  [
    'later invalid face',
    [
      { type: 'at', userId: '123' },
      { type: 'face', id: '14' },
    ],
  ],
  ['sparse batch', sparseInput],
  ['relative media path', [{ type: 'image', file: 'relative.png' }]],
  ['raw card input', [{ elementType: 10, elementId: '', arkElement: { bytesData: '{}' } }]],
] as const) {
  test(`sender rejects ${name} before UID or native acquisition`, async () => {
    let uidCalls = 0;
    const f = fixture(async () => {
      uidCalls++;
      return 'u_fixture';
    });
    try {
      await assert.rejects(f.sender.send(peer, input));
      assert.equal(uidCalls, 0);
      assert.deepEqual(f.calls, []);
    } finally {
      f.sender.close();
      f.channel.close();
    }
  });
}
test('prepared forward cards use the same sender without rewriting the envelope', async () => {
  const card = buildMergedForwardCard({
    resourceId: 'fixture-resource',
    cardId: '12345678-1234-4123-8123-123456789abc',
    nodes: [{ displayName: 'fixture', text: 'captured' }],
  });
  const batch = [card];
  const f = fixture();
  let dispatched = 0;
  try {
    const receipt = await f.sender.sendPrepared(peer, batch, () => dispatched++);
    assert.equal(receipt.messageId, '42');
    assert.equal(dispatched, 1);
    assert.equal(f.sendCalls, 1);
    assert.equal(f.submitted[0], batch);
    assert.equal(f.submitted[0]![0], card);
    assert.deepEqual(f.calls, ['Msg', 'MSF', 'time', 'unique', 'send']);
  } finally {
    f.sender.close();
    f.channel.close();
  }
});
test('invalid correlation and duplicate correlation never dispatch another send', async () => {
  const f = fixture();
  f.setUnique(undefined);
  await assert.rejects(f.sender.send(peer, 'first'), /Invalid native send correlation/);
  assert.equal(f.sendCalls, 0);
  f.setUnique('unique');
  await f.sender.send(peer, 'second');
  await assert.rejects(f.sender.send(peer, 'third'), /Duplicate native send correlation/);
  assert.equal(f.sendCalls, 1);
  f.sender.close();
  f.channel.close();
});
test('synchronous successful callback cannot replace native rejection and failed correlation remains reserved', async () => {
  const f = fixture();
  f.setInvoke(() => ({ result: 71 }));
  await assert.rejects(
    f.sender.send(peer, 'fixture'),
    (error) => error instanceof Error && 'code' in error && error.code === 71,
  );
  await assert.rejects(f.sender.send(peer, 'fixture'), /Duplicate native send correlation/);
  assert.equal(f.sendCalls, 1);
  f.sender.close();
  f.channel.close();
});
test('closing while unique ID generation stalls prevents subsequent send', async () => {
  let resolve!: (value: string) => void;
  const controller = new AbortController();
  const channel = createNativeEventChannel(controller.signal);
  let sends = 0;
  const sender = createNativeMessageSender({
    signal: controller.signal,
    getMessageService: () => ({
      generateMsgUniqueId: () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
      sendMsg() {
        sends++;
        return { result: 0 };
      },
    }),
    getServerTimeService: () => ({ getServerTime: () => '100' }),
    awaitAlive: async (value) => value,
    uidFor: async () => 'u_fixture',
    eventCall: channel.call,
  });
  const pending = assert.rejects(sender.sendPrepared(peer, []), /sender is closed/);
  sender.close();
  resolve('unique');
  await pending;
  assert.equal(sends, 0);
  channel.close();
});
test('reentrant close in onDispatch prevents actual send without replay', async () => {
  const f = fixture();
  await assert.rejects(
    f.sender.sendPrepared(peer, [], () => f.sender.close()),
    /sender is closed/,
  );
  assert.equal(f.sendCalls, 0);
  f.channel.close();
});

for (const stage of [
  'message-service',
  'time-service',
  'time-getter',
  'time-call',
  'unique-getter',
  'send-getter',
]) {
  for (const termination of ['close', 'abort']) {
    test(`reentrant ${termination} during ${stage} prevents subsequent native dispatch`, async () => {
      const controller = new AbortController();
      const channel = createNativeEventChannel(controller.signal);
      let uniqueCalls = 0,
        sendCalls = 0;
      const terminate = () => (termination === 'close' ? sender.close() : controller.abort());
      const messages = {
        get generateMsgUniqueId() {
          if (stage === 'unique-getter') terminate();
          return function (this: unknown) {
            assert.equal(this, messages);
            uniqueCalls++;
            return 'unique';
          };
        },
        get sendMsg() {
          if (stage === 'send-getter') terminate();
          return function (this: unknown) {
            assert.equal(this, messages);
            sendCalls++;
            return { result: 0 };
          };
        },
      };
      const msf = {
        get getServerTime() {
          if (stage === 'time-getter') terminate();
          return function (this: unknown) {
            assert.equal(this, msf);
            if (stage === 'time-call') terminate();
            return '100';
          };
        },
      };
      const sender = createNativeMessageSender({
        signal: controller.signal,
        getMessageService() {
          if (stage === 'message-service') terminate();
          return messages;
        },
        getServerTimeService() {
          if (stage === 'time-service') terminate();
          return msf;
        },
        awaitAlive: async (value) => value,
        uidFor: async () => 'u_fixture',
        eventCall: channel.call,
      });
      try {
        await assert.rejects(sender.sendPrepared(peer, []));
        assert.equal(uniqueCalls, stage === 'send-getter' ? 1 : 0);
        assert.equal(sendCalls, 0);
      } finally {
        sender.close();
        channel.close();
      }
    });
  }
}

for (const absent of [undefined, null])
  for (const family of ['message', 'time'])
    test(`${family} absent service ${String(absent)} preserves missing-method error`, async () => {
      const controller = new AbortController();
      const channel = createNativeEventChannel(controller.signal);
      const sender = createNativeMessageSender({
        signal: controller.signal,
        getMessageService: () =>
          family === 'message' ? absent : { generateMsgUniqueId: () => 'id' },
        getServerTimeService: () => (family === 'time' ? absent : { getServerTime: () => '100' }),
        awaitAlive: async (value) => value,
        uidFor: async () => 'u_fixture',
        eventCall: channel.call,
      });
      try {
        await assert.rejects(sender.sendPrepared(peer, []), {
          message: `Native service is missing ${family === 'message' ? 'generateMsgUniqueId' : 'getServerTime'}`,
        });
      } finally {
        sender.close();
        channel.close();
      }
    });
