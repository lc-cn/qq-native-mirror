import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeMessageSender } from '../src/features/messages/native-message-sender.ts';
import { createNativeEventChannel } from '../src/runtime/native-event-channel.ts';
import type { NativeObject } from '../src/native/native-object.ts';
const peer = { chatType: 2 as const, peerUid: '123' };
function fixture() {
  const controller = new AbortController();
  const channel = createNativeEventChannel(controller.signal);
  const calls: string[] = [];
  let unique: unknown = 'unique';
  let sendCalls = 0;
  let invoke: () => unknown = () => ({ result: 0 });
  const msg: NativeObject = {
    generateMsgUniqueId() {
      calls.push('unique');
      return unique;
    },
    sendMsg(_id: string, destination: NativeObject) {
      calls.push('send');
      sendCalls++;
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
    service(name) {
      calls.push(name);
      return name === 'Msg'
        ? msg
        : {
            getServerTime() {
              calls.push('time');
              return '100';
            },
          };
    },
    call(object, name, ...args) {
      return object[name](...args);
    },
    awaitAlive: async (value) => value,
    uidFor: async () => 'u_fixture',
    eventCall: channel.call,
  });
  return {
    sender,
    channel,
    controller,
    calls,
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
    service: (name) =>
      name === 'Msg'
        ? {
            generateMsgUniqueId: () =>
              new Promise<string>((done) => {
                resolve = done;
              }),
            sendMsg() {
              sends++;
              return { result: 0 };
            },
          }
        : { getServerTime: () => '100' },
    call: (object, name, ...args) => object[name](...args),
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
