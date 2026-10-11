import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNativeMessageSender,
  type MessageSendPort,
} from '../src/features/messages/native-message-sender.ts';
import { createNativeEventChannel } from '../src/runtime/native-event-channel.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';
function receipt(overrides: Record<string, unknown> = {}) {
  return {
    guildId: 'unique',
    sendStatus: 2,
    msgId: '00042',
    msgSeq: '0009',
    msgTime: '100',
    ...overrides,
  };
}
function fixture(
  feed: (
    dispatch: (value: unknown) => void,
    destination: Parameters<NonNullable<MessageSendPort['sendMsg']>>[1],
  ) => void,
  ack: () => unknown = () => ({ result: 0 }),
) {
  const life = new NativeServiceLifetime(),
    channel = createNativeEventChannel(life.signal);
  let calls = 0;
  const service: MessageSendPort = {
    generateMsgUniqueId() {
      return 'unique';
    },
    sendMsg(_id, destination) {
      assert.equal(this, service);
      calls++;
      feed((value) => channel.dispatch('Msg/onMsgInfoListUpdate', [value]), destination);
      return ack();
    },
  };
  const sender = createNativeMessageSender({
    signal: life.signal,
    awaitAlive: life.awaitAlive,
    getMessageService: () => service,
    getServerTimeService: () => ({ getServerTime: () => '100' }),
    uidFor: async () => 'u_friend',
    eventCall: channel.call,
  });
  return {
    sender,
    life,
    channel,
    calls: () => calls,
    send: () => sender.sendPrepared({ chatType: 2, peerUid: '123' }, []),
    close() {
      sender.close();
      channel.close();
      life.close();
    },
  };
}
test('send receipt never executes changing msgId accessor or publishes invalid typed ID', async () => {
  let reads = 0;
  const raw = Object.defineProperty(receipt(), 'msgId', {
    get() {
      return ++reads < 4 ? '42' : {};
    },
  });
  const f = fixture((dispatch) => dispatch([raw]));
  try {
    await assert.rejects(f.send(), /Invalid native/);
    assert.equal(reads, 0);
    assert.equal(f.calls(), 1);
  } finally {
    f.close();
  }
});
for (const field of ['guildId', 'sendStatus', 'msgSeq', 'msgTime'] as const) {
  test(`send receipt ${field} accessor is rejected without execution`, async () => {
    let reads = 0;
    const raw = Object.defineProperty(receipt(), field, {
      get() {
        reads++;
        throw Error('sensitive accessor');
      },
    });
    const f = fixture((dispatch) => dispatch([raw]));
    try {
      await assert.rejects(f.send(), /Invalid native/);
      assert.equal(reads, 0);
      assert.equal(f.calls(), 1);
    } finally {
      f.close();
    }
  });
}
test('send receipt unrelated correlation does not read malicious metadata; explicit wrong peer cannot confirm', async () => {
  let reads = 0;
  const unrelated = Object.defineProperty(receipt({ guildId: 'other' }), 'msgId', {
    get() {
      reads++;
      throw Error('unrelated');
    },
  });
  const wrong = receipt({ chatType: 2, peerUid: '999', msgId: '99' });
  const f = fixture((dispatch) => {
    dispatch([unrelated, wrong]);
    dispatch([receipt()]);
  });
  try {
    assert.deepEqual(await f.send(), { messageId: '00042', sequence: '0009', time: 100 });
    assert.equal(reads, 0);
  } finally {
    f.close();
  }
});
test('send receipt supports missing peer metadata, long numeric IDs and success after failed row', async () => {
  const id = '000184467440737095516160000';
  const f = fixture((dispatch) => dispatch([receipt({ sendStatus: 0 }), receipt({ msgId: id })]));
  try {
    assert.deepEqual(await f.send(), { messageId: id, sequence: '0009', time: 100 });
    assert.equal(f.calls(), 1);
  } finally {
    f.close();
  }
});
test('send receipt early success cannot override rejected native completion', async () => {
  const error = new Error('native rejection');
  const f = fixture(
    (dispatch) => dispatch([receipt()]),
    () => Promise.reject(error),
  );
  try {
    await assert.rejects(f.send(), (value: unknown) => value === error);
    assert.equal(f.calls(), 1);
  } finally {
    f.close();
  }
});
test('send receipt close after callback cannot publish success', async () => {
  const f = fixture((dispatch) => {
    dispatch([receipt()]);
    f.sender.close();
  });
  try {
    await assert.rejects(f.send(), /closed|cancel|unknown/i);
    assert.equal(f.calls(), 1);
  } finally {
    f.close();
  }
});
for (const raw of [null, {}, new Array(1)]) {
  test('send receipt malformed batch rejects immediately with fixed invalid error', async () => {
    const f = fixture((dispatch) => {
      dispatch(raw);
      dispatch([receipt()]);
    });
    try {
      await assert.rejects(f.send(), /Invalid native/);
      assert.equal(f.calls(), 1);
    } finally {
      f.close();
    }
  });
}
test('send ACK preserves existing accessor and explicit nonzero failure semantics', async () => {
  let reads = 0;
  const ack = Object.defineProperty({}, 'result', {
    get() {
      reads++;
      return 7;
    },
  });
  const f = fixture(
    (dispatch) => dispatch([receipt()]),
    () => ack,
  );
  try {
    await assert.rejects(f.send(), { code: 7 });
    assert.ok(reads > 0);
    assert.equal(f.calls(), 1);
  } finally {
    f.close();
  }
});
test('send callback array index accessor is rejected without execution', async () => {
  let reads = 0;
  const raw = Object.defineProperty(new Array(1), '0', {
    get() {
      reads++;
      throw Error('sensitive index');
    },
  });
  const f = fixture((dispatch) => {
    dispatch(raw);
    dispatch([receipt()]);
  });
  try {
    await assert.rejects(f.send(), /Invalid native/);
    assert.equal(reads, 0);
  } finally {
    f.close();
  }
});

test('send vendor mutation of submitted destination cannot redefine receipt correlation', async () => {
  const f = fixture((dispatch, destination) => {
    destination.peerUid = '999';
    destination.guildId = 'vendor-changed';
    dispatch([receipt({ peerUid: '999', chatType: 2, msgId: '99' })]);
    dispatch([receipt({ peerUid: '123', chatType: 2 })]);
  });
  try {
    assert.deepEqual(await f.send(), { messageId: '00042', sequence: '0009', time: 100 });
    assert.equal(f.calls(), 1);
  } finally {
    f.close();
  }
});
