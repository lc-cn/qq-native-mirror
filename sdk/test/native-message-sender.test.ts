import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createNativeMessageSender,
  type MessageSendPort,
} from '../src/features/messages/native-message-sender.ts';
import { createNativeEventChannel } from '../src/runtime/native-event-channel.ts';
import { buildMergedForwardCard } from '../src/features/forward/merged-forward-card.ts';
import type { PreparedSendElement } from '../src/native/prepared-message-contracts.ts';
async function awaitSenderAlive<T>(value: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  const pending = Promise.resolve(value);
  pending.catch(() => {});
  signal?.throwIfAborted();
  if (!signal) return pending;
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([pending, stopped]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
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
            chatType: destination.chatType,
            peerUid: destination.peerUid,
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
    awaitAlive: awaitSenderAlive,
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
    awaitAlive: awaitSenderAlive,
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
        awaitAlive: awaitSenderAlive,
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
        awaitAlive: awaitSenderAlive,
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

test('public send intent captures whole input before UID/IO and groups skip target UID lookup', async () => {
  const lookups: string[] = [];
  const f = fixture(async (id) => {
    lookups.push(id);
    return 'u_resolved';
  });
  try {
    await assert.rejects(f.sender.sendPrivateMessage('0', 'hello'));
    await assert.rejects(
      f.sender.sendPrivateMessage('123', [{ type: 'text', text: 'ok' }, { type: 'unsupported' }]),
    );
    await assert.rejects(f.sender.sendGroupMessage('0', 'hello'));
    assert.deepEqual(lookups, []);
    assert.deepEqual(f.calls, []);
    await f.sender.sendGroupMessage('123', 'group');
    assert.deepEqual(lookups, []);
    f.setUnique('private-id');
    await f.sender.sendPrivateMessage('00123', 'private');
    assert.deepEqual(lookups, ['00123']);
    assert.equal(f.sendCalls, 2);
  } finally {
    f.sender.close();
    f.channel.close();
  }
});

test('private UID await preserves captured message when caller mutates its batch', async () => {
  let resolveUid!: (uid: string) => void;
  const lookups: string[] = [];
  const f = fixture((id) => {
    lookups.push(id);
    return new Promise((resolve) => {
      resolveUid = resolve;
    });
  });
  const input = [{ type: 'text', text: 'before' }];
  const pending = f.sender.sendPrivateMessage('123', input);
  input[0]!.text = 'after';
  input.push({ type: 'text', text: 'extra' });
  resolveUid('u_resolved');
  try {
    await pending;
    assert.deepEqual(lookups, ['123']);
    assert.deepEqual(
      f.submitted[0]?.map((element) => element.elementType),
      [1],
    );
    const element = f.submitted[0]?.[0];
    assert.ok(element && element.elementType === 1);
    assert.equal(element.textElement.content, 'before');
  } finally {
    f.sender.close();
    f.channel.close();
  }
});

test('local close cancels pending private and mention UID waits and observes late failures before any write', async () => {
  for (const kind of ['private', 'mention'] as const) {
    let rejectUid!: (error: unknown) => void;
    const f = fixture(
      () =>
        new Promise<string>((_, reject) => {
          rejectUid = reject;
        }),
    );
    const pending =
      kind === 'private'
        ? f.sender.sendPrivateMessage('123', 'hello')
        : f.sender.sendGroupMessage('123', [{ type: 'at', userId: '456' }]);
    const rejection = assert.rejects(pending, /sender is closed/);
    f.sender.close();
    await rejection;
    rejectUid(new Error('late UID'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.sendCalls, 0);
    f.channel.close();
  }
});

test('local close cancels generation wait without dispatch and observes late rejection', async () => {
  let rejectGenerated!: (error: unknown) => void;
  const f = fixture();
  f.setUnique(
    new Promise<string>((_, reject) => {
      rejectGenerated = reject;
    }),
  );
  const pending = f.sender.sendPrepared(peer, []);
  const rejection = assert.rejects(pending, /sender is closed/);
  f.sender.close();
  await rejection;
  rejectGenerated(new Error('late generation'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.sendCalls, 0);
  f.channel.close();
});

test('local close cancels dispatched send and preserves independent shared-channel waiter', async () => {
  const f = fixture();
  let rejectNative!: (error: unknown) => void;
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.setInvoke(
    () =>
      new Promise((_, reject) => {
        rejectNative = reject;
        started();
      }),
  );
  const other = f.channel.call(
    'Other/event',
    (value: string) => value,
    () => ({ result: 0 }),
  );
  const pending = f.sender.sendPrepared(peer, []);
  const rejection = assert.rejects(
    pending,
    /sender is closed after dispatch; remote effect unknown/,
  );
  await dispatched;
  assert.equal(f.sendCalls, 1);
  f.sender.close();
  await rejection;
  f.channel.dispatch('Msg/onMsgInfoListUpdate', [
    [{ guildId: 'unique', sendStatus: 2, msgId: 'late', msgSeq: '1', msgTime: '1' }],
  ]);
  rejectNative(new Error('late native send'));
  f.channel.dispatch('Other/event', ['other survived']);
  assert.equal(await other, 'other survived');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.sendCalls, 1);
  f.channel.close();
});

for (const retire of [false, true])
  test(`image staging keeps two native getter reads and receiver; second getter close=${retire}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'qq-sender-image-'));
    const controller = new AbortController();
    const channel = createNativeEventChannel(controller.signal);
    let reads = 0,
      calls = 0;
    const file = join(directory, 'a.png');
    const bytes = Buffer.alloc(24);
    Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
    bytes.writeUInt32BE(2, 16);
    bytes.writeUInt32BE(3, 20);
    await writeFile(file, bytes);
    const msg: MessageSendPort = {
      get getRichMediaFilePathForGuild() {
        reads++;
        if (retire && reads === 2) sender.close();
        return function (
          this: MessageSendPort,
          request: Parameters<NonNullable<MessageSendPort['getRichMediaFilePathForGuild']>>[0],
        ) {
          assert.equal(this, msg);
          assert.equal(request.elementType, 2);
          calls++;
          return file;
        };
      },
      generateMsgUniqueId: () => 'image-id',
      sendMsg(_id, destination) {
        channel.dispatch('Msg/onMsgInfoListUpdate', [
          [{ guildId: destination.guildId, sendStatus: 2, msgId: '1', msgSeq: '1', msgTime: '1' }],
        ]);
        return { result: 0 };
      },
    };
    const sender = createNativeMessageSender({
      signal: controller.signal,
      getMessageService: () => msg,
      getServerTimeService: () => ({ getServerTime: () => '1' }),
      awaitAlive: awaitSenderAlive,
      uidFor: async () => 'u_friend',
      eventCall: channel.call,
    });
    try {
      const pending = sender.sendGroupMessage('123', [{ type: 'image', file }]);
      if (retire) await assert.rejects(pending, /sender is closed/);
      else await pending;
      assert.equal(reads, 2);
      assert.equal(calls, retire ? 0 : 1);
    } finally {
      sender.close();
      channel.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test('closing after image FS work starts prevents later staging getter and native dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'qq-sender-late-image-'));
  const file = join(directory, 'a.png');
  const bytes = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  bytes.writeUInt32BE(2, 16);
  bytes.writeUInt32BE(3, 20);
  await writeFile(file, bytes);
  const controller = new AbortController();
  const channel = createNativeEventChannel(controller.signal);
  let preparation: Promise<unknown> | undefined;
  let acquired = 0,
    stagingReads = 0,
    nativeCalls = 0;
  const sender = createNativeMessageSender({
    signal: controller.signal,
    getMessageService: () => {
      acquired++;
      return {
        get getRichMediaFilePathForGuild() {
          stagingReads++;
          return () => {
            nativeCalls++;
            return file;
          };
        },
        sendMsg: () => {
          nativeCalls++;
        },
      };
    },
    getServerTimeService: () => ({ getServerTime: () => '1' }),
    awaitAlive(value, signal) {
      preparation = Promise.resolve(value);
      return awaitSenderAlive(value, signal);
    },
    uidFor: async () => 'u_friend',
    eventCall: channel.call,
  });
  try {
    const pending = sender.sendGroupMessage('123', [{ type: 'image', file }]);
    assert.equal(acquired, 1); // Constructor has entered its asynchronous readFile.
    sender.close();
    await assert.rejects(pending, /sender is closed/);
    // Await the original whole-preparation Promise, not only its cancelled outer wait.
    assert.ok(preparation);
    await assert.rejects(preparation, /sender is closed/);
    assert.equal(stagingReads, 0);
    assert.equal(nativeCalls, 0);
  } finally {
    sender.close();
    channel.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('postdispatch cancellation does not rewrite native rejection identity or nonzero ACK', async () => {
  const nativeError = new Error('original native failure');
  const thrown = fixture();
  thrown.setInvoke(() => {
    thrown.sender.close();
    throw nativeError;
  });
  try {
    await assert.rejects(
      thrown.sender.sendPrepared(peer, []),
      (error: unknown) => error === nativeError,
    );
    assert.equal(thrown.sendCalls, 1);
  } finally {
    thrown.sender.close();
    thrown.channel.close();
  }
  const failedAck = fixture();
  failedAck.setInvoke(() => ({
    get result() {
      failedAck.sender.close();
      return 7;
    },
  }));
  try {
    await assert.rejects(
      failedAck.sender.sendPrepared(peer, []),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 7 &&
        !error.message.includes('remote effect unknown'),
    );
    assert.equal(failedAck.sendCalls, 1);
  } finally {
    failedAck.sender.close();
    failedAck.channel.close();
  }
});

test('private sender validates resolved UID before any native acquisition', async () => {
  for (const uid of ['', '   ']) {
    const f = fixture(async () => uid);
    try {
      await assert.rejects(f.sender.sendPrivateMessage('123', 'hello'), /Invalid native peer UID/);
      assert.deepEqual(f.calls, []);
      assert.equal(f.sendCalls, 0);
    } finally {
      f.sender.close();
      f.channel.close();
    }
  }
});

test('account close plus revoked native rejection preserves original opaque failure', async () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const f = fixture();
  f.setInvoke(() => {
    f.controller.abort();
    throw revoked.proxy;
  });
  try {
    const caught = await f.sender.sendPrepared(peer, []).then(
      () => {
        throw new Error('Expected native rejection');
      },
      (error: unknown) => ({ error }),
    );
    assert.equal(caught.error, revoked.proxy);
    assert.equal(f.sendCalls, 1);
  } finally {
    f.sender.close();
    f.channel.close();
  }
});

test('account close does not read native failure message getter or overwrite its identity/code', async () => {
  let reads = 0;
  const error = Object.defineProperty(
    Object.assign(new Error('native failure'), { code: 73 }),
    'message',
    {
      get() {
        reads++;
        throw new Error('sensitive getter');
      },
    },
  );
  const f = fixture();
  f.setInvoke(() => {
    f.controller.abort();
    throw error;
  });
  try {
    await assert.rejects(f.sender.sendPrepared(peer, []), (actual: unknown) => actual === error);
    assert.equal(reads, 0);
    assert.equal(error.code, 73);
    assert.equal(f.sendCalls, 1);
  } finally {
    f.sender.close();
    f.channel.close();
  }
});

test('account cancellation still classifies the channel own-data closed error as unknown effect', async () => {
  const f = fixture();
  let started!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.setInvoke(() => {
    started();
    return new Promise(() => {});
  });
  const pending = f.sender.sendPrepared(peer, []);
  const rejection = assert.rejects(
    pending,
    /sender is closed after dispatch; remote effect unknown/,
  );
  try {
    await dispatched;
    f.controller.abort();
    await rejection;
    assert.equal(f.sendCalls, 1);
  } finally {
    f.sender.close();
    f.channel.close();
  }
});
