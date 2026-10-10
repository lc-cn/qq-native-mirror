import assert from 'node:assert/strict';
import test from 'node:test';
import { recallMessage } from '../src/features/messages/recall-operation.ts';
import { createNativeEventChannel } from '../src/runtime/native-event-channel.ts';
import type { NativePeer } from '../src/native/message-contracts.ts';

const peer: NativePeer = { chatType: 2, peerUid: '123' };
const update = { chatType: 2, peerUid: '123', msgId: '42', recallTime: '101' };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('recall keeps peer resolution before ID coercion and acquires only its message port', async () => {
  const events = createNativeEventChannel(new AbortController().signal);
  const order: string[] = [];
  const service = {
    recallMsg(selected: NativePeer, ids: string[]) {
      assert.equal(this, service);
      assert.equal(selected, peer);
      assert.deepEqual(ids, ['42']);
      order.push('recall');
      events.dispatch('Msg/onMsgInfoListUpdate', [[update]]);
      return { result: 0 };
    },
  };
  try {
    const result = await recallMessage(
      {
        async resolvePeer(input) {
          assert.equal(input, 'legacy peer');
          order.push('resolve');
          await tick();
          order.push('resolved');
          return peer;
        },
        getMessageService() {
          order.push('acquire');
          return service;
        },
        eventCall: events.call,
      },
      'legacy peer',
      () => {
        order.push('read');
        return {
          toString() {
            order.push('coerce');
            return '42';
          },
        };
      },
    );
    assert.equal(result, undefined);
    assert.deepEqual(order, ['resolve', 'resolved', 'read', 'coerce', 'acquire', 'recall']);
  } finally {
    events.close();
  }
});

test('an early matching callback waits for native completion and native rejection wins', async () => {
  const events = createNativeEventChannel(new AbortController().signal);
  let reject!: (error: Error) => void;
  let calls = 0;
  let settled = false;
  const failure = new Error('controlled invocation failure');
  try {
    const pending = recallMessage(
      {
        resolvePeer: async () => peer,
        getMessageService: () => ({
          recallMsg() {
            calls++;
            events.dispatch('Msg/onMsgInfoListUpdate', [[update]]);
            return new Promise((_resolve, fail) => {
              reject = fail;
            });
          },
        }),
        eventCall: events.call,
      },
      peer,
      () => '42',
    );
    void pending.then(
      () => {
        settled = true;
      },
      () => {},
    );
    await tick();
    assert.equal(settled, false);
    const assertion = assert.rejects(pending, (error) => error === failure);
    reject(failure);
    await assertion;
    assert.equal(calls, 1);
  } finally {
    events.close();
  }
});

test('abort during peer resolution prevents acquiring or dispatching a recall', async () => {
  const controller = new AbortController();
  const events = createNativeEventChannel(controller.signal);
  let finish!: (value: NativePeer) => void;
  let acquired = 0;
  try {
    const pending = recallMessage(
      {
        resolvePeer: () =>
          new Promise<NativePeer>((resolve) => {
            finish = resolve;
          }),
        getMessageService: () => {
          acquired++;
          throw new Error('unexpected acquisition');
        },
        eventCall: events.call,
      },
      peer,
      () => '42',
    );
    const assertion = assert.rejects(pending, (error) => error === controller.signal.reason);
    controller.abort();
    finish(peer);
    await assertion;
    assert.equal(acquired, 0);
  } finally {
    events.close();
  }
});

test('closing a recall observes late rejection without replaying its native invocation', async () => {
  const events = createNativeEventChannel(new AbortController().signal);
  let reject!: (error: Error) => void;
  let calls = 0;
  const pending = recallMessage(
    {
      resolvePeer: async () => peer,
      getMessageService: () => ({
        recallMsg() {
          calls++;
          return new Promise((_resolve, fail) => {
            reject = fail;
          });
        },
      }),
      eventCall: events.call,
    },
    peer,
    () => '42',
  );
  const assertion = assert.rejects(pending, /Client closed during native operation/);
  await tick();
  events.close();
  await assertion;
  reject(new Error('late controlled rejection'));
  events.dispatch('Msg/onMsgInfoListUpdate', [[update]]);
  await tick();
  assert.equal(calls, 1);
});
