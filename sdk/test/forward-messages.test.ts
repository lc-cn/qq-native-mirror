import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createForwardMessages as createWithContext,
  type ForwardMessagePort,
  type NativeForwardPeer,
} from '../src/features/forward/forward-messages.ts';
import type { Message, Peer } from '../src/types.ts';
function createForwardMessages(
  session: { getMsgService?: () => ForwardMessagePort },
  resolvePeer: (peer: Peer) => Promise<NativeForwardPeer>,
  decodeMessage: (
    message: Record<string, unknown>,
  ) => Message | undefined | Promise<Message | undefined>,
  signal = new AbortController().signal,
  decodeMessages?: (messages: Record<string, unknown>[]) => Promise<(Message | undefined)[]>,
) {
  return createWithContext({
    getMessageService() {
      if (!session.getMsgService) throw new Error('Native service is missing getMsgService');
      return session.getMsgService();
    },
    resolvePeer,
    decodeMessage,
    decodeMessages,
    signal,
    awaitAlive: async (value) => value,
  });
}
const resolvePeer = async (peer: Peer) =>
  peer.type === 'private'
    ? { chatType: 1 as const, peerUid: 'u_resolved' }
    : { chatType: 2 as const, peerUid: peer.groupId };

test('reads native merged-forward contents with exact root and parent IDs', async () => {
  const raw = { msgId: '99', chatType: 1, elements: [] };
  const decoded = { messageId: '99', raw } as Message;
  const operations = createForwardMessages(
    {
      getMsgService: () => ({
        getMultiMsg: (peer: unknown, root: string, parent: string) => {
          assert.deepEqual(peer, { chatType: 1, peerUid: 'u_resolved' });
          assert.equal(root, '10');
          assert.equal(parent, '20');
          return { result: 0, msgList: [raw] };
        },
      }),
    },
    resolvePeer,
    (value) => {
      assert.equal(value, raw);
      return decoded;
    },
  );
  assert.deepEqual(
    await operations.invokeOperation('getForwardMessages', {
      peer: { type: 'private', userId: '123' },
      rootMessageId: '10',
      parentMessageId: '20',
    }),
    [decoded],
  );
});

test('forwards existing messages with exact native destinations and empty Map', async () => {
  const calls: any[] = [];
  const operations = createForwardMessages(
    {
      getMsgService: () => ({
        forwardMsg: (...args: unknown[]) => {
          calls.push(args);
          return { result: 0 };
        },
      }),
    },
    resolvePeer,
    () => undefined,
  );
  assert.equal(calls.length, 0);
  const source = { type: 'group', groupId: '123' };
  const destination = { type: 'private', userId: '456' };
  assert.equal(
    await operations.invokeOperation('forwardMessages', {
      source,
      destination,
      messageIds: ['10', '20'],
    }),
    undefined,
  );
  assert.deepEqual(calls[0], [
    ['10', '20'],
    { chatType: 2, peerUid: '123' },
    [{ chatType: 1, peerUid: 'u_resolved' }],
    new Map(),
  ]);
  assert.deepEqual(source, { type: 'group', groupId: '123' });
});

test('validates all inputs before UID lookup or native invocation', async () => {
  let invoked = 0;
  const operations = createForwardMessages(
    {
      getMsgService: () => {
        invoked++;
        return {};
      },
    },
    async (peer) => {
      invoked++;
      return resolvePeer(peer);
    },
    () => undefined,
  );
  const cases = [
    ['getForwardMessages', { peer: { type: 'group', groupId: '123' }, rootMessageId: '10' }],
    [
      'getForwardMessages',
      { peer: { type: 'private', userId: 'bad' }, rootMessageId: '10', parentMessageId: '20' },
    ],
    [
      'forwardMessages',
      {
        source: { type: 'group', groupId: '123' },
        destination: { type: 'group', groupId: '456' },
        messageIds: [],
      },
    ],
    [
      'forwardMessages',
      {
        source: { type: 'group', groupId: '123' },
        destination: { type: 'group', groupId: '456' },
        messageIds: ['10', null],
      },
    ],
  ] as const;
  for (const [method, payload] of cases)
    await assert.rejects(operations.invokeOperation(method, payload));
  assert.equal(invoked, 0);
});

test('native errors, malformed lists, missing messages and undecodable content reject', async () => {
  for (const result of [
    undefined,
    { result: 5 },
    { result: 0 },
    { result: 0, msgList: [null] },
    { result: 0, msgList: [{ chatType: 0 }] },
  ]) {
    const operations = createForwardMessages(
      { getMsgService: () => ({ getMultiMsg: () => result }) },
      resolvePeer,
      () => undefined,
    );
    await assert.rejects(
      operations.invokeOperation('getForwardMessages', {
        peer: { type: 'group', groupId: '123' },
        rootMessageId: '10',
        parentMessageId: '20',
      }),
    );
  }
  const operations = createForwardMessages(
    { getMsgService: () => ({ forwardMsg: () => undefined }) },
    resolvePeer,
    () => undefined,
  );
  await assert.rejects(
    operations.invokeOperation('forwardMessages', {
      source: { type: 'group', groupId: '123' },
      destination: { type: 'group', groupId: '456' },
      messageIds: ['10'],
    }),
    /failed/,
  );
});

test('sparse forward identifiers reject before any resolver or native call', async () => {
  let calls = 0;
  const operations = createForwardMessages(
    {
      getMsgService() {
        calls++;
        return {
          forwardMsg() {
            calls++;
            return { result: 0 };
          },
        };
      },
    },
    async (p) => {
      calls++;
      return resolvePeer(p);
    },
    () => undefined,
  );
  for (const messageIds of [Array(1), ['10', ...Array(1)]]) {
    await assert.rejects(
      operations.invokeOperation('forwardMessages', {
        source: { type: 'group', groupId: '123' },
        destination: { type: 'group', groupId: '456' },
        messageIds,
      }),
    );
  }
  assert.equal(calls, 0);
});

for (const [label, invalid] of [
  ['sparse messages', Array(1)],
  ['numeric message ID', [{ msgId: 99, chatType: 1, elements: [] }]],
  ['absent elements', [{ msgId: '99', chatType: 1 }]],
  ['sparse elements', [{ msgId: '99', chatType: 1, elements: Array(1) }]],
  ['invalid element object', [{ msgId: '99', chatType: 1, elements: [[]] }]],
] as const)
  test(`merged-forward rejects ${label} without decoding a partial batch`, async () => {
    let decoded = 0;
    const first = { msgId: '10', chatType: 2, elements: [] };
    const msgList = label === 'sparse messages' ? invalid : [first, ...invalid];
    const operations = createForwardMessages(
      { getMsgService: () => ({ getMultiMsg: () => ({ result: 0, msgList }) }) },
      resolvePeer,
      (raw) => {
        decoded++;
        return { messageId: String(raw.msgId) } as Message;
      },
    );
    await assert.rejects(
      operations.invokeOperation('getForwardMessages', {
        peer: { type: 'group', groupId: '123' },
        rootMessageId: '10',
        parentMessageId: '20',
      }),
    );
    assert.equal(decoded, 0);
  });

test('merged-forward preserves empty success, mixed source conversations, order and long IDs', async () => {
  const messages = [
    { msgId: '900719925474099312345', chatType: 2, elements: [] },
    { msgId: '2', chatType: 1, elements: [{ elementType: 1 }] },
  ];
  for (const msgList of [[], messages]) {
    const operations = createForwardMessages(
      { getMsgService: () => ({ getMultiMsg: () => ({ result: 0, msgList }) }) },
      resolvePeer,
      (raw) => ({ messageId: raw.msgId }) as Message,
    );
    const result = await operations.invokeOperation('getForwardMessages', {
      peer: { type: 'group', groupId: '123' },
      rootMessageId: '10',
      parentMessageId: '20',
    });
    assert.deepEqual(
      (result as Message[]).map((message) => message.messageId),
      msgList.map((raw) => raw.msgId),
    );
  }
});

for (const method of ['getForwardMessages', 'forwardMessages'] as const)
  test(`${method} does not return a late native result after shutdown`, async () => {
    const controller = new AbortController();
    let finish!: (value: unknown) => void,
      started!: () => void,
      calls = 0;
    const began = new Promise<void>((resolve) => {
        started = resolve;
      }),
      delayed = new Promise((resolve) => {
        finish = resolve;
      });
    const native = () => {
      calls++;
      started();
      return delayed;
    };
    const operations = createForwardMessages(
      { getMsgService: () => ({ getMultiMsg: native, forwardMsg: native }) },
      resolvePeer,
      (raw) => ({ messageId: raw.msgId }) as Message,
      controller.signal,
    );
    const payload =
      method === 'getForwardMessages'
        ? { peer: { type: 'group', groupId: '123' }, rootMessageId: '10', parentMessageId: '20' }
        : {
            source: { type: 'group', groupId: '123' },
            destination: { type: 'group', groupId: '456' },
            messageIds: ['10'],
          };
    const pending = operations.invokeOperation(method, payload);
    await began;
    controller.abort();
    finish({ result: 0, msgList: [] });
    await assert.rejects(pending, /abort/i);
    assert.equal(calls, 1);
  });

test('shutdown during source resolution prevents destination lookup and forward mutation', async () => {
  const controller = new AbortController();
  let finish!: (value: Awaited<ReturnType<typeof resolvePeer>>) => void,
    started!: () => void,
    resolutions = 0,
    mutations = 0;
  const began = new Promise<void>((resolve) => {
      started = resolve;
    }),
    delayed = new Promise<Awaited<ReturnType<typeof resolvePeer>>>((resolve) => {
      finish = resolve;
    });
  const operations = createForwardMessages(
    {
      getMsgService: () => ({
        forwardMsg() {
          mutations++;
          return { result: 0 };
        },
      }),
    },
    async () => {
      resolutions++;
      started();
      return delayed;
    },
    () => undefined,
    controller.signal,
  );
  const pending = operations.invokeOperation('forwardMessages', {
    source: { type: 'group', groupId: '123' },
    destination: { type: 'group', groupId: '456' },
    messageIds: ['10'],
  });
  await began;
  controller.abort();
  finish({ chatType: 2, peerUid: '123' });
  await assert.rejects(pending, /abort/i);
  assert.equal(resolutions, 1);
  assert.equal(mutations, 0);
});

for (const stage of ['source', 'destination', 'read', 'forward', 'decode'] as const)
  for (const termination of ['local close', 'parent abort'] as const)
    test(`${termination} promptly ends stalled forward ${stage} without waiting for native settlement or replay`, async () => {
      const controller = new AbortController();
      let began!: () => void,
        rejectLate!: (error: unknown) => void,
        resolutions = 0,
        readCalls = 0,
        forwardCalls = 0,
        decodes = 0;
      const started = new Promise<void>((resolve) => {
          began = resolve;
        }),
        stalled = new Promise<never>((_, reject) => {
          rejectLate = reject;
        });
      const hang = () => {
        began();
        return stalled;
      };
      const operations = createForwardMessages(
        {
          getMsgService: () => ({
            getMultiMsg() {
              readCalls++;
              if (stage === 'read') return hang();
              return { result: 0, msgList: [{ msgId: '1', chatType: 2, elements: [] }] };
            },
            forwardMsg() {
              forwardCalls++;
              return hang();
            },
          }),
        },
        async (peer) => {
          resolutions++;
          if (stage === 'source' || (stage === 'destination' && resolutions === 2)) return hang();
          return resolvePeer(peer);
        },
        () => {
          decodes++;
          return hang();
        },
        controller.signal,
      );
      const reading = stage === 'read' || stage === 'decode';
      const pending = operations.invokeOperation(
        reading ? 'getForwardMessages' : 'forwardMessages',
        reading
          ? { peer: { type: 'group', groupId: '123' }, rootMessageId: '10', parentMessageId: '20' }
          : {
              source: { type: 'group', groupId: '123' },
              destination: { type: 'group', groupId: '456' },
              messageIds: ['10'],
            },
      );
      await started;
      const rejected = assert.rejects(pending, /abort|closed/i);
      if (termination === 'local close') operations.close();
      else controller.abort();
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          rejected,
          new Promise((_, reject) => {
            deadline = setTimeout(
              () => reject(Error('Closed forward caller remained stalled')),
              500,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
        rejectLate(Error('late-native-private-rejection'));
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(forwardCalls, stage === 'forward' ? 1 : 0);
      assert.equal(readCalls, reading ? 1 : 0);
      assert.equal(decodes, stage === 'decode' ? 1 : 0);
      assert.equal(resolutions, stage === 'destination' || stage === 'forward' ? 2 : 1);
    });

test('forward cancellation listeners are removed on success, rejection and synchronous abort', async () => {
  for (const mode of ['success', 'reject-undefined', 'abort-sync'] as const) {
    const controller = new AbortController();
    const operations = createForwardMessages(
      {
        getMsgService: () => ({
          getMultiMsg() {
            if (mode === 'abort-sync') {
              controller.abort();
              return Promise.reject(Error('late rejection'));
            }
            if (mode === 'reject-undefined') return Promise.reject(undefined);
            return { result: 0, msgList: [] };
          },
        }),
      },
      resolvePeer,
      () => undefined,
      controller.signal,
    );
    const pending = operations.invokeOperation('getForwardMessages', {
      peer: { type: 'group', groupId: '123' },
      rootMessageId: '1',
      parentMessageId: '1',
    });
    if (mode === 'success') assert.deepEqual(await pending, []);
    else if (mode === 'abort-sync') await assert.rejects(pending, /abort/i);
    else await assert.rejects(pending, (error) => error === undefined);
    assert.equal(
      getEventListeners(controller.signal, 'abort').length,
      mode === 'abort-sync' ? 0 : 1,
    );
    operations.close();
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

const forwardingPayload = {
  source: { type: 'group', groupId: '123' },
  destination: { type: 'group', groupId: '456' },
  messageIds: ['1'],
};
for (const stage of ['service', 'method', 'result'] as const) {
  test(`forward synchronous retirement at ${stage} cannot dispatch or report success`, async () => {
    let calls = 0,
      reads = 0;
    const service: ForwardMessagePort = {
      get forwardMsg() {
        reads++;
        if (stage === 'method') operations.close();
        return function (this: ForwardMessagePort) {
          assert.equal(this, service);
          calls++;
          return {
            get result() {
              if (stage === 'result') operations.close();
              return 0;
            },
          };
        };
      },
    };
    const operations = createWithContext({
      signal: new AbortController().signal,
      getMessageService() {
        if (stage === 'service') operations.close();
        return service;
      },
      resolvePeer,
      decodeMessage: () => undefined,
      awaitAlive: async (value) => value,
    });
    await assert.rejects(
      operations.invokeOperation('forwardMessages', forwardingPayload),
      /closed/,
    );
    assert.equal(calls, stage === 'result' ? 1 : 0);
    assert.equal(reads, stage === 'service' ? 0 : 1);
  });
}

test('forward identifiers and peer type are captured once before asynchronous resolution', async () => {
  let types = 0,
    ids = 0;
  const calls: unknown[][] = [];
  const operations = createWithContext({
    signal: new AbortController().signal,
    getMessageService: () => ({
      forwardMsg(...args) {
        calls.push(args);
        return { result: 0 };
      },
    }),
    resolvePeer,
    decodeMessage: () => undefined,
    awaitAlive: async (value) => value,
  });
  try {
    await operations.invokeOperation('forwardMessages', {
      source: {
        get type() {
          types++;
          return types === 1 ? 'group' : 'private';
        },
        groupId: '123',
      },
      destination: { type: 'group', groupId: '456' },
      get messageIds() {
        ids++;
        return ids === 1 ? ['1'] : ['2'];
      },
    });
    assert.equal(types, 1);
    assert.equal(ids, 1);
    assert.deepEqual(calls[0][0], ['1']);
  } finally {
    operations.close();
  }
});

test('local close interrupts stalled batch decoder and observes late rejection', async () => {
  let began!: () => void, fail!: (error: unknown) => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const response = new Promise<(Message | undefined)[]>((_, reject) => {
    fail = reject;
  });
  const operations = createWithContext({
    signal: new AbortController().signal,
    getMessageService: () => ({
      getMultiMsg: () => ({ result: 0, msgList: [{ msgId: '1', chatType: 2, elements: [] }] }),
    }),
    resolvePeer,
    decodeMessage: () => undefined,
    decodeMessages() {
      began();
      return response;
    },
    awaitAlive: async (value) => value,
  });
  const pending = operations.invokeOperation('getForwardMessages', {
    peer: { type: 'group', groupId: '123' },
    rootMessageId: '1',
    parentMessageId: '1',
  });
  await started;
  operations.close();
  await assert.rejects(pending, /closed/);
  fail(new Error('late decoder failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('synchronous decoder retirement stops remaining single-message decodes', async () => {
  let decoded = 0;
  const operations = createWithContext({
    signal: new AbortController().signal,
    getMessageService: () => ({
      getMultiMsg: () => ({
        result: 0,
        msgList: [
          { msgId: '1', chatType: 2, elements: [] },
          { msgId: '2', chatType: 2, elements: [] },
        ],
      }),
    }),
    resolvePeer,
    decodeMessage() {
      decoded++;
      operations.close();
      return undefined;
    },
    awaitAlive: async (value) => value,
  });
  await assert.rejects(
    operations.invokeOperation('getForwardMessages', {
      peer: { type: 'group', groupId: '123' },
      rootMessageId: '1',
      parentMessageId: '1',
    }),
    /closed/,
  );
  assert.equal(decoded, 1);
});

test('already-started decoder rejection is observed if a later decoder retires synchronously', async () => {
  let decoded = 0;
  const operations = createWithContext({
    signal: new AbortController().signal,
    getMessageService: () => ({
      getMultiMsg: () => ({
        result: 0,
        msgList: [
          { msgId: '1', chatType: 2, elements: [] },
          { msgId: '2', chatType: 2, elements: [] },
          { msgId: '3', chatType: 2, elements: [] },
        ],
      }),
    }),
    resolvePeer,
    decodeMessage() {
      decoded++;
      if (decoded === 1) return Promise.reject(new Error('earlier decode rejection'));
      operations.close();
      return undefined;
    },
    awaitAlive: async (value) => value,
  });
  await assert.rejects(
    operations.invokeOperation('getForwardMessages', {
      peer: { type: 'group', groupId: '123' },
      rootMessageId: '1',
      parentMessageId: '1',
    }),
    /closed/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(decoded, 2);
});
