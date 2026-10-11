/** @typedef {{'cli.js':typeof import('../../src/cli.ts'),
'features/forward/forward-messages.js':typeof import('../../src/features/forward/forward-messages.ts'),
'index.js':typeof import('../../src/index.ts'),
'native-services.js':typeof import('../../src/native-services.ts')}} InstalledModules */
import { ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Only installed compiled code and synthetic services; never initialize a native client.
/** @param {string} packageRoot */
export async function verifyForwardConsumer(packageRoot) {
  /** @template {keyof InstalledModules} Name @param {Name} name @returns {Promise<InstalledModules[Name]>} */
  const load = (name) => import(pathToFileURL(join(packageRoot, 'dist', name)).href);
  const { createForwardMessages: createInstalledForwardMessages } = await load(
    'features/forward/forward-messages.js',
  );
  /** @type {ReturnType<InstalledModules['features/forward/forward-messages.js']['createForwardMessages']>[]} */
  const owners = [];
  /** @type {InstalledModules['features/forward/forward-messages.js']['createForwardMessages']} */
  const createForwardMessages = (context) => {
    const owner = createInstalledForwardMessages(context);
    owners.push(owner);
    return owner;
  };
  try {
    const { createNativeServices } = await load('native-services.js');
    const { prepareCommand } = await load('cli.js');
    /** @type {Extract<import('../../src/types.ts').Peer,{type:'group'}>} */
    const peer = { type: 'group', groupId: '123' };
    /** @type {Extract<import('../../src/types.ts').Peer,{type:'private'}>} */
    const destination = { type: 'private', userId: '456' };
    /** @param {import('../../src/types.ts').Peer} value @returns {Promise<import('../../src/native/message-contracts.ts').NativePeer>} */
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
    let idReads = 0,
      iteratorCalls = 0;
    const accessorIds = Object.defineProperty(new Array(1), '0', {
      get() {
        idReads++;
        return longId;
      },
    });
    const hiddenIds = [longId, null];
    Object.defineProperty(hiddenIds, Symbol.iterator, {
      value() {
        iteratorCalls++;
        return [longId][Symbol.iterator]();
      },
    });
    for (const messageIds of [Array(1), [longId, undefined], accessorIds, hiddenIds])
      await assert.rejects(
        invalidIds.invokeOperation('forwardMessages', { source: peer, destination, messageIds }),
      );
    assert.equal(calls, 0);
    assert.equal(idReads, 0);
    assert.equal(iteratorCalls, 0);
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
    for (const key of ['result', 'msgList', 'msgId', 'chatType', 'elements']) {
      let reads = 0,
        decodes = 0;
      const record = { ...raw },
        response = { result: 0, msgList: [record] };
      Object.defineProperty(key === 'result' || key === 'msgList' ? response : record, key, {
        get() {
          reads++;
          throw Error('Unexpected selected getter');
        },
      });
      const operation = createForwardMessages({
        getMessageService: () => ({ getMultiMsg: () => response }),
        resolvePeer,
        decodeMessage() {
          decodes++;
          return undefined;
        },
        signal: new AbortController().signal,
        awaitAlive: async (value) => value,
      });
      await assert.rejects(operation.invokeOperation('getForwardMessages', payload));
      assert.equal(reads, 0);
      assert.equal(decodes, 0);
    }
    const forwardedRaw = { ...raw, msgId: '00042', elements: [{}] },
      mixedRaw = { ...raw, chatType: 1, peerUid: 'u_other', peerUin: '789' };
    const snapshots = createForwardMessages({
      getMessageService: () => ({
        getMultiMsg: () => ({ result: 0, msgList: [forwardedRaw, mixedRaw] }),
      }),
      resolvePeer,
      decodeMessage: () => undefined,
      decodeMessages: async (messages, originals) => {
        assert.equal(originals[0], forwardedRaw);
        assert.equal(originals[1], mixedRaw);
        assert.notEqual(messages[0], forwardedRaw);
        forwardedRaw.msgId = '99';
        forwardedRaw.elements.length = 0;
        assert.equal(messages[0].msgId, '00042');
        assert.deepEqual(messages[0].elements, [{}]);
        return messages.map((message, index) => ({
          ...decodedMessage(message),
          raw: originals[index],
        }));
      },
      signal: new AbortController().signal,
      awaitAlive: async (value) => value,
    });
    const decodedSnapshots = await snapshots.invokeOperation('getForwardMessages', payload);
    assert.ok(Array.isArray(decodedSnapshots));
    assert.deepEqual(
      decodedSnapshots.map((value) => value.messageId),
      ['00042', longId],
    );
    assert.equal(decodedSnapshots[0].raw, forwardedRaw);
    // Exercise actual compiled composition/projector wiring, not a decoder fixture.
    const composed = createNativeServices({
      session: {
        getMsgService: () => ({
          addKernelMsgListener() {},
          getMultiMsg: () => ({ result: 0, msgList: [raw, mixedRaw] }),
        }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
      },
      version: '7.0.2-53644',
      events: { emit: () => {} },
    });
    try {
      const messages = await composed.invokeOperation('getForwardMessages', payload);
      assert.ok(Array.isArray(messages));
      assert.deepEqual(
        messages.map((value) => value.messageId),
        [longId, longId],
      );
      assert.deepEqual(
        messages.map((value) => value.peer.type),
        ['group', 'private'],
      );
      assert.equal(messages[0].raw, raw);
      assert.equal(messages[1].raw, mixedRaw);
    } finally {
      composed.close();
    }
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
          return decodedMessage(message);
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
        decodeMessage: decodedMessage,
        signal: new AbortController().signal,
        awaitAlive: async (value) => value,
      });
      const messages = await operation.invokeOperation('getForwardMessages', payload);
      assert.ok(Array.isArray(messages));
      assert.deepEqual(
        messages.map((message) => message.messageId),
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
        assert.ok(error instanceof Error && 'code' in error);
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
    /** @type {unknown[][]} */
    const args = [];
    const forwarding = createForwardMessages({
      getMessageService: () => ({
        /** @param {unknown[]} values */
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
    const { QQClient } = await load('index.js');
    const cliWorker = controlledCloseWorker();
    const cliClient = new QQClient(cliWorker, 500);
    cliClient.forwardMessages = async (source, dest, messageIds) => {
      await forwarding.invokeOperation('forwardMessages', {
        source,
        destination: dest,
        messageIds,
      });
    };
    try {
      await action(cliClient);
    } finally {
      await cliClient.close();
    }
    assert.deepEqual(args, [
      [
        [longId, '2'],
        { chatType: 2, peerUid: '123' },
        [{ chatType: 1, peerUid: 'u_destination' }],
        new Map(),
      ],
    ]);
    for (const method of /** @type {const} */ (['getForwardMessages', 'forwardMessages'])) {
      /** @type {(value:unknown)=>void} */
      let finish = () => assert.fail('Native wait not started');
      /** @type {()=>void} */
      let begin = () => assert.fail('Native wait not started');
      let nativeCalls = 0;
      const started = /** @type {Promise<void>} */ (
          new Promise((resolve) => {
            begin = resolve;
          })
        ),
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
        /** @type {ReturnType<typeof setTimeout>|undefined} */
        /** @type {ReturnType<typeof setTimeout>|undefined} */
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
      /** @type {(value?:unknown)=>void} */
      let resolve = () => assert.fail('Wait not started');
      /** @type {(reason:unknown)=>void} */
      let reject = () => assert.fail('Wait not started');
      const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
      });
      return { promise, resolve, reject };
    };
    /** @template T @param {Promise<T>} promise @returns {Promise<T>} */
    const settleWithin = async (promise) => {
      /** @type {ReturnType<typeof setTimeout>|undefined} */
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
    for (const method of /** @type {const} */ (['getForwardMessages', 'forwardMessages'])) {
      for (const stage of ['service', 'method', 'ack']) {
        let nativeCalls = 0,
          getterReads = 0;
        const nativeName = method === 'getForwardMessages' ? 'getMultiMsg' : 'forwardMsg';
        const service = {};
        Object.defineProperty(service, nativeName, {
          get() {
            getterReads++;
            if (stage === 'method') owner.close();
            return /** @this {object} */ function () {
              assert.equal(this, service);
              nativeCalls++;
              if (method === 'getForwardMessages')
                return new Proxy(
                  { result: 0, msgList: [] },
                  {
                    getOwnPropertyDescriptor(target, key) {
                      // Reads now capture own data descriptors. Retirement at
                      // that boundary must still prevent decoding and success.
                      if (stage === 'ack' && key === 'result') owner.close();
                      return Reflect.getOwnPropertyDescriptor(target, key);
                    },
                  },
                );
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
            return pendingPeer.promise.then(() => {
              throw Error('Unexpected peer completion');
            });
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
          return decoding.promise.then(() => {
            throw Error('Unexpected decoder completion');
          });
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
    class Worker extends ChildProcess {
      /** @type {Record<string,unknown>[]} */
      requests = [];
      constructor() {
        super();
        Object.defineProperties(this, {
          connected: { value: true, configurable: true },
          exitCode: { value: null, configurable: true },
          send: {
            value: (
              /** @type {unknown} */ request,
              /** @type {(error:Error|null)=>void} */ callback,
            ) => {
              assertRecord(request);
              this.requests.push(request);
              callback(null);
              queueMicrotask(() => {
                this.emit('message', {
                  id: request.id,
                  result:
                    request.method === 'close'
                      ? null
                      : request.method === 'forwardMessages'
                        ? undefined
                        : request.method === 'sendMergedForward'
                          ? { messageId: '42', sequence: '9', time: 100, resourceId: 'r' }
                          : [],
                });
                if (request.method === 'close')
                  setImmediate(() => {
                    Object.defineProperties(this, {
                      connected: { value: false, configurable: true },
                      exitCode: { value: 0, configurable: true },
                    });
                    this.emit('exit', 0, null);
                  });
              });
            },
            configurable: true,
          },
        });
      }
      kill() {
        Object.defineProperty(this, 'connected', { value: false, configurable: true });
        queueMicrotask(() => this.emit('exit', 0, null));
        return true;
      }
    }
    const inputWorker = new Worker(),
      inputClient = new QQClient(inputWorker, 500);
    inputWorker.emit('message', { event: 'ready', payload: { uin: '456', uid: 'u_self' } });
    try {
      for (const messageIds of [accessorIds, hiddenIds])
        await assert.rejects(
          Reflect.apply(inputClient.forwardMessages, inputClient, [peer, destination, messageIds]),
        );
      await assert.rejects(
        Reflect.apply(inputClient.forwardMessages, inputClient, [
          { type: 'group', groupId: 42 },
          destination,
          ['42'],
        ]),
      );
      assert.equal(inputWorker.requests.length, 0);
      assert.equal(idReads, 0);
      assert.equal(iteratorCalls, 0);
      let peerReads = 0;
      const source = {
        get type() {
          peerReads++;
          return 'group';
        },
        groupId: '000123',
      };
      const ids = Array.from({ length: 101 }, () => '00042');
      Object.defineProperty(ids, Symbol.iterator, {
        value() {
          iteratorCalls++;
          return ['99'][Symbol.iterator]();
        },
      });
      const pending = Reflect.apply(inputClient.forwardMessages, inputClient, [
        source,
        destination,
        ids,
      ]);
      source.groupId = '999';
      ids[0] = '99';
      assert.equal(await pending, undefined);
      assert.equal(peerReads, 1);
      assert.equal(iteratorCalls, 0);
      const request = inputWorker.requests[0];
      assert.equal(request.method, 'forwardMessages');
      assert.deepEqual(request.source, { type: 'group', groupId: '000123' });
      assert.deepEqual(
        request.messageIds,
        Array.from({ length: 101 }, () => '00042'),
      );
    } finally {
      await inputClient.close();
    }
    const worker = new Worker(),
      client = new QQClient(worker, 500);
    try {
      worker.emit('message', { event: 'ready', payload: { uin: '456', uid: 'u_self' } });
      let preparation = 0;
      const merged = createNativeServices({
        session: {
          getMsgService: () => ({
            addKernelMsgListener() {},
            sendSsoCmdReqByContend() {
              preparation++;
              throw Error('Unexpected upload');
            },
          }),
          getGroupService: () => ({ addKernelGroupListener() {} }),
          getBuddyService: () => ({ addKernelBuddyListener() {} }),
          getUixConvertService: () => ({
            getUid() {
              preparation++;
              throw Error('Unexpected UID');
            },
          }),
        },
        version: '7.0.2-53644',
        identity: { userId: '456', uid: 'u_self' },
        events: { emit: () => {} },
      });
      try {
        for (const boundary of mergedInputCases()) {
          await assert.rejects(
            Promise.resolve().then(() =>
              Reflect.apply(client.sendMergedForward, client, [destination, boundary.nodes, {}]),
            ),
          );
          await assert.rejects(
            merged.invokeOperation('sendMergedForward', {
              peer: destination,
              nodes: boundary.nodes,
            }),
          );
          assert.equal(boundary.reads(), 0);
          assert.equal(worker.requests.length, 0);
          assert.equal(preparation, 0);
        }
      } finally {
        merged.close();
      }
      let ordinaryReads = 0,
        iterations = 0;
      const originalNode = { userId: '456', nickname: 'fixture', time: 100, text: 'originalNode' };
      /** @template {object} T @param {T} value @returns {T} */
      const descriptorInput = (value) =>
        new Proxy(value, {
          get() {
            ordinaryReads++;
            throw Error('Do not re-read caller fields');
          },
        });
      const mergedNodes = [descriptorInput(originalNode)];
      Object.defineProperty(mergedNodes, Symbol.iterator, {
        value() {
          iterations++;
          return [{ ...originalNode, text: 'replacement' }][Symbol.iterator]();
        },
      });
      assert.deepEqual(
        await client.sendMergedForward(
          descriptorInput(destination),
          mergedNodes,
          descriptorInput({ title: 'title' }),
        ),
        { messageId: '42', sequence: '9', time: 100, resourceId: 'r' },
      );
      assert.equal(ordinaryReads, 0);
      assert.equal(iterations, 0);
      assert.equal(worker.requests.length, 1);
      assert.deepEqual(worker.requests[0].nodes, [originalNode]);
      assert.deepEqual(worker.requests[0].options, { title: 'title' });
      worker.requests.length = 0;
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
      /** @type {Parameters<typeof client.getForwardMessages>|undefined} */
      let values;
      const original = client.getForwardMessages;
      client.getForwardMessages = async (...args) => {
        values = args;
        return [];
      };
      try {
        await first(client);
      } finally {
        client.getForwardMessages = original;
      }
      assert.deepEqual(values, [peer, longId, longId]);
    } finally {
      await client.close();
    }
    return {
      forwardInputSnapshotContract: true,
      forwardInputBeforeIpcContract: true,
      forwardMessageContract: true,
      mergedForwardOwnedInputContract: true,
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

/** @param {unknown} value @returns {asserts value is Record<string,unknown>} */
function assertRecord(value) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
}
/** @param {Record<string,unknown>} raw @returns {import('../../src/types.ts').Message} */
function decodedMessage(raw) {
  assert.equal(typeof raw.msgId, 'string');
  assert.ok(typeof raw.msgId === 'string');
  return {
    messageId: raw.msgId,
    sequence: '9',
    time: 100,
    peer: { type: 'group', groupId: '123' },
    sender: { userId: '456', uid: 'u_fixture', nickname: 'fixture' },
    elements: [],
    raw,
  };
}

/** Genuine ChildProcess with synthetic close ACK/exit only; never spawns a process. */
function controlledCloseWorker() {
  const worker = new ChildProcess();
  Object.defineProperty(worker, 'connected', { value: true, configurable: true });
  Object.defineProperty(worker, 'send', {
    value(/** @type {unknown} */ value, /** @type {(error:Error|null)=>void} */ callback) {
      assert.ok(value !== null && typeof value === 'object' && 'id' in value && 'method' in value);
      assert.equal(value.method, 'close');
      callback(null);
      queueMicrotask(() => {
        worker.emit('message', { id: value.id, result: null });
        setImmediate(() => {
          Object.defineProperties(worker, {
            connected: { value: false, configurable: true },
            exitCode: { value: 0, configurable: true },
          });
          worker.emit('exit', 0, null);
        });
      });
      return true;
    },
  });
  return worker;
}

/** Malformed later slots cannot be hidden by a caller iterator.
 * @returns {{nodes:unknown[],reads:()=>number}[]} */
function mergedInputCases() {
  const node = { userId: '456', nickname: 'fixture', time: 100, text: 'text' };
  let iteratorReads = 0,
    slotReads = 0,
    fieldReads = 0;
  const hidden = [node, { ...node, text: 42 }];
  Object.defineProperty(hidden, Symbol.iterator, {
    value() {
      iteratorReads++;
      return [node][Symbol.iterator]();
    },
  });
  const slot = Object.defineProperty(new Array(1), '0', {
    get() {
      slotReads++;
      return node;
    },
  });
  const field = Object.defineProperty({ ...node }, 'text', {
    get() {
      fieldReads++;
      return 'text';
    },
  });
  return [
    { nodes: hidden, reads: () => iteratorReads },
    { nodes: slot, reads: () => slotReads },
    { nodes: [field], reads: () => fieldReads },
    { nodes: Array(1), reads: () => 0 },
  ];
}
