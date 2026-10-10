import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only installed compiled code and synthetic services; never initialize a native client.
export async function verifyForwardConsumer(packageRoot) {
  const load = (name) => import(pathToFileURL(join(packageRoot, 'dist', name)).href);
  const { createForwardMessages: createInstalledForwardMessages } = await load(
    'features/forward/forward-messages.js',
  );
  const owners = [];
  const createForwardMessages = (context) => {
    const owner = createInstalledForwardMessages(context);
    owners.push(owner);
    return owner;
  };
  try {
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
    const invalidIds = createForwardMessages({
      getMessageService() {
        calls++;
        return {};
      },
      resolvePeer: async (value) => {
        calls++;
        return resolvePeer(value);
      },
      decodeMessage: () => undefined,
      signal: new AbortController().signal,
      awaitAlive: async (value) => value,
    });
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
      const operation = createForwardMessages({
        getMessageService: () => ({ getMultiMsg: () => ({ result: 0, msgList }) }),
        resolvePeer: resolvePeer,
        decodeMessage: (message) => {
          decoded++;
          return { messageId: message.msgId };
        },
        signal: new AbortController().signal,
        awaitAlive: async (value) => value,
      });
      await assert.rejects(operation.invokeOperation('getForwardMessages', payload));
      assert.equal(decoded, 0);
    }
    for (const msgList of [[], [raw, { ...raw, msgId: '2', chatType: 1, peerUid: 'u_other' }]]) {
      const operation = createForwardMessages({
        getMessageService: () => ({ getMultiMsg: () => ({ result: 0, msgList }) }),
        resolvePeer: resolvePeer,
        decodeMessage: (message) => ({ messageId: message.msgId }),
        signal: new AbortController().signal,
        awaitAlive: async (value) => value,
      });
      assert.deepEqual(
        (await operation.invokeOperation('getForwardMessages', payload)).map(
          (message) => message.messageId,
        ),
        msgList.map((message) => message.msgId),
      );
    }
    for (const result of [-1, 23, 'denied', undefined, NaN]) {
      const operation = createForwardMessages({
        getMessageService: () => ({
          getMultiMsg: () => ({ result, msgList: [], errMsg: 'fixture-private-field' }),
        }),
        resolvePeer: resolvePeer,
        decodeMessage: () => undefined,
        signal: new AbortController().signal,
        awaitAlive: async (value) => value,
      });
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
    const forwarding = createForwardMessages({
      getMessageService: () => ({
        forwardMsg(...values) {
          args.push(values);
          return { result: 0 };
        },
      }),
      resolvePeer: resolvePeer,
      decodeMessage: () => undefined,
      signal: new AbortController().signal,
      awaitAlive: async (value) => value,
    });
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
              deadline = setTimeout(
                () => reject(Error('Forward settlement deadline exceeded')),
                5000,
              );
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
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    const deferred = () => {
      let resolve, reject;
      const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      });
      return { promise, resolve, reject };
    };
    const settleWithin = async (promise) => {
      let deadline;
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            deadline = setTimeout(
              () => reject(Error('Forward settlement deadline exceeded')),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(deadline);
      }
    };
    const forwardInput = { source: peer, destination, messageIds: [longId] };
    for (const method of ['getForwardMessages', 'forwardMessages']) {
      for (const stage of ['service', 'method', 'ack']) {
        let nativeCalls = 0,
          getterReads = 0;
        const nativeName = method === 'getForwardMessages' ? 'getMultiMsg' : 'forwardMsg';
        const service = {};
        Object.defineProperty(service, nativeName, {
          get() {
            getterReads++;
            if (stage === 'method') owner.close();
            return function () {
              assert.equal(this, service);
              nativeCalls++;
              return {
                get result() {
                  if (stage === 'ack') owner.close();
                  return 0;
                },
                msgList: [],
              };
            };
          },
        });
        const owner = createForwardMessages({
          getMessageService() {
            if (stage === 'service') owner.close();
            return service;
          },
          resolvePeer,
          decodeMessage: () => undefined,
          signal: new AbortController().signal,
          awaitAlive: async (value) => value,
        });
        await assert.rejects(
          settleWithin(
            owner.invokeOperation(method, method === 'getForwardMessages' ? payload : forwardInput),
          ),
          /abort|closed/i,
        );
        assert.equal(nativeCalls, stage === 'ack' ? 1 : 0);
        assert.equal(getterReads, stage === 'service' ? 0 : 1);
      }
    }
    for (const stage of ['source', 'destination']) {
      const pendingPeer = deferred(),
        began = deferred();
      let resolutions = 0,
        nativeCalls = 0;
      const owner = createForwardMessages({
        getMessageService: () => ({
          forwardMsg() {
            nativeCalls++;
            return { result: 0 };
          },
        }),
        resolvePeer(value) {
          resolutions++;
          if (resolutions === (stage === 'source' ? 1 : 2)) {
            began.resolve();
            return pendingPeer.promise;
          }
          return resolvePeer(value);
        },
        decodeMessage: () => undefined,
        signal: new AbortController().signal,
        awaitAlive: async (value) => value,
      });
      const pending = owner.invokeOperation('forwardMessages', forwardInput);
      await settleWithin(began.promise);
      owner.close();
      await assert.rejects(settleWithin(pending), /abort|closed/i);
      pendingPeer.reject(Error('Late synthetic peer failure'));
      await turn();
      assert.equal(nativeCalls, 0);
      assert.equal(resolutions, stage === 'source' ? 1 : 2);
    }
    for (const localClose of [true, false]) {
      const decoding = deferred(),
        began = deferred(),
        controller = new AbortController();
      let batches = 0;
      const owner = createForwardMessages({
        getMessageService: () => ({ getMultiMsg: () => ({ result: 0, msgList: [raw] }) }),
        resolvePeer,
        decodeMessage: () => {
          throw Error('Unexpected individual decoder');
        },
        decodeMessages(records) {
          assert.equal(records.length, 1);
          batches++;
          began.resolve();
          return decoding.promise;
        },
        signal: controller.signal,
        awaitAlive: async (value) => value,
      });
      const pending = owner.invokeOperation('getForwardMessages', payload);
      await settleWithin(began.promise);
      if (localClose) owner.close();
      else controller.abort(Error('Synthetic closed decoder'));
      await assert.rejects(settleWithin(pending), /abort|closed/i);
      decoding.reject(Error('Late synthetic decoder failure'));
      await turn();
      assert.equal(batches, 1);
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
      forwardNamedPortsContract: true,
      forwardReentrantCloseContract: true,
      forwardPendingPeerCloseContract: true,
      forwardBatchDecodeCloseContract: true,
      forwardLateFailureObserved: true,
      nativeForwardQueryAttempted: false,
      forwardSubmissionAttempted: false,
    };
  } finally {
    for (const owner of owners) owner.close();
  }
}
