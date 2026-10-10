import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only installed compiled code and synthetic services; never initialize a native client.
export async function verifyForwardConsumer(packageRoot) {
  const load = (name) => import(pathToFileURL(join(packageRoot, 'dist', name)).href);
  const { createForwardMessages } = await load('features/forward/forward-messages.js');
  const { createNativeServices } = await load('native-services.js');
  const { prepareCommand } = await load('cli.js');
  const peer = { type: 'group', groupId: '123' },
    destination = { type: 'private', userId: '456' };
  const resolvePeer = async (value) =>
    value.type === 'group'
      ? { chatType: 2, peerUid: value.groupId }
      : { chatType: 1, peerUid: 'u_destination' };
  const payload = { peer, rootMessageId: '10', parentMessageId: '20' },
    longId = '900719925474099312345';
  let calls = 0;
  const invalidIds = createForwardMessages(
    {
      getMsgService() {
        calls++;
        return {};
      },
    },
    async (value) => {
      calls++;
      return resolvePeer(value);
    },
    () => undefined,
  );
  for (const messageIds of [Array(1), [longId, undefined]])
    await assert.rejects(
      invalidIds.invokeOperation('forwardMessages', { source: peer, destination, messageIds }),
    );
  assert.equal(calls, 0);
  const raw = {
    msgId: longId,
    msgSeq: '9',
    msgTime: '100',
    chatType: 2,
    peerUid: '123',
    senderUid: 'u_fixture',
    senderUin: '456',
    elements: [],
  };
  for (const msgList of [
    Array(1),
    [raw, { ...raw, msgId: 1 }],
    [raw, { ...raw, elements: Array(1) }],
    [raw, { ...raw, elements: [[]] }],
    [raw, { ...raw, elements: undefined }],
  ]) {
    let decoded = 0;
    const operation = createForwardMessages(
      { getMsgService: () => ({ getMultiMsg: () => ({ result: 0, msgList }) }) },
      resolvePeer,
      (message) => {
        decoded++;
        return { messageId: message.msgId };
      },
    );
    await assert.rejects(operation.invokeOperation('getForwardMessages', payload));
    assert.equal(decoded, 0);
  }
  for (const msgList of [[], [raw, { ...raw, msgId: '2', chatType: 1, peerUid: 'u_other' }]]) {
    const operation = createForwardMessages(
      { getMsgService: () => ({ getMultiMsg: () => ({ result: 0, msgList }) }) },
      resolvePeer,
      (message) => ({ messageId: message.msgId }),
    );
    assert.deepEqual(
      (await operation.invokeOperation('getForwardMessages', payload)).map(
        (message) => message.messageId,
      ),
      msgList.map((message) => message.msgId),
    );
  }
  for (const result of [-1, 23, 'denied', undefined, NaN]) {
    const operation = createForwardMessages(
      {
        getMsgService: () => ({
          getMultiMsg: () => ({ result, msgList: [], errMsg: 'fixture-private-field' }),
        }),
      },
      resolvePeer,
      () => undefined,
    );
    await assert.rejects(operation.invokeOperation('getForwardMessages', payload), (error) => {
      assert.equal(
        error.code,
        (typeof result === 'number' && !Number.isFinite(result)) || result === undefined
          ? 'invalid-result'
          : result,
      );
      assert.ok(!error.message.includes('fixture-private-field'));
      return true;
    });
  }
  const args = [];
  const forwarding = createForwardMessages(
    {
      getMsgService: () => ({
        forwardMsg(...values) {
          args.push(values);
          return { result: 0 };
        },
      }),
    },
    resolvePeer,
    () => undefined,
  );
  const action = await prepareCommand('forward', {
    'source-kind': 'group',
    'source-target': '123',
    kind: 'private',
    target: '456',
    'message-ids': `${longId},2`,
  });
  await action({
    forwardMessages: (source, dest, messageIds) =>
      forwarding.invokeOperation('forwardMessages', { source, destination: dest, messageIds }),
  });
  assert.deepEqual(args, [
    [
      [longId, '2'],
      { chatType: 2, peerUid: '123' },
      [{ chatType: 1, peerUid: 'u_destination' }],
      new Map(),
    ],
  ]);
  for (const method of ['getForwardMessages', 'forwardMessages']) {
    let finish,
      begin,
      nativeCalls = 0;
    const started = new Promise((resolve) => {
        begin = resolve;
      }),
      result = new Promise((resolve) => {
        finish = resolve;
      });
    const invoke = () => {
      nativeCalls++;
      begin();
      return result;
    };
    const services = createNativeServices({
      session: {
        getMsgService: () => ({
          addKernelMsgListener() {},
          getMultiMsg: invoke,
          forwardMsg: invoke,
        }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
      },
      version: '7.0.2-53644',
      events: { emit: () => {} },
    });
    const input =
      method === 'getForwardMessages'
        ? payload
        : { source: peer, destination: peer, messageIds: [longId] };
    try {
      const pending = services.invokeOperation(method, input);
      await started;
      services.close();
      let deadline;
      try {
        await Promise.race([
          assert.rejects(pending, /abort|closed/i),
          new Promise((_, reject) => {
            deadline = setTimeout(() => reject(Error('Forward caller stalled after close')), 500);
          }),
        ]);
      } finally {
        clearTimeout(deadline);
        finish({ result: 0, msgList: [] });
      }
      assert.equal(nativeCalls, 1);
    } finally {
      services.close();
    }
  }
  const { QQClient } = await load('index.js'),
    { EventEmitter } = await import('node:events');
  class Worker extends EventEmitter {
    connected = true;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    requests = [];
    send(request, callback) {
      this.requests.push(request);
      callback(null);
      queueMicrotask(() =>
        this.emit('message', { id: request.id, result: request.method === 'close' ? null : [] }),
      );
    }
    kill() {
      this.connected = false;
      queueMicrotask(() => this.emit('exit', 0, null));
      return true;
    }
  }
  const worker = new Worker(),
    client = new QQClient(worker, 500);
  try {
    worker.emit('message', { event: 'ready', payload: { uin: '456', uid: 'u_self' } });
    await assert.rejects(client.getForwardMessages(peer, 'invalid-resource'), /numeric string/);
    assert.equal(worker.requests.length, 0);
    await client.getForwardMessages(peer, longId);
    assert.deepEqual(
      worker.requests.map((r) => [r.method, r.peer, r.rootMessageId, r.parentMessageId]),
      [['getForwardMessages', peer, longId, longId]],
    );
    await client.getForwardMessages(peer, longId, '0002');
    assert.equal(worker.requests[1].parentMessageId, '0002');
    assert.equal(worker.requests[1].rootMessageId, longId);
    const first = await prepareCommand('forward-history', {
      kind: 'group',
      target: '123',
      'root-message-id': longId,
    });
    let values;
    await first({
      getForwardMessages: async (...args) => {
        values = args;
      },
    });
    assert.deepEqual(values, [peer, longId, longId]);
  } finally {
    await client.close();
  }
  return {
    forwardMessageContract: true,
    nativeForwardQueryAttempted: false,
    forwardSubmissionAttempted: false,
  };
}
