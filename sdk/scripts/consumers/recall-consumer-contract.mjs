/** @typedef {{'cli.js':typeof import('../../src/cli.ts'),
'features/messages/recall-events.js':typeof import('../../src/features/messages/recall-events.ts'),
'features/messages/recall-operation.js':typeof import('../../src/features/messages/recall-operation.ts'),
'index.js':typeof import('../../src/index.ts'),
'native-services.js':typeof import('../../src/native-services.ts'),
'runtime/native-event-channel.js':typeof import('../../src/runtime/native-event-channel.ts')}} InstalledModules */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChildProcess } from 'node:child_process';

// Installed compiled modules with synthetic callbacks only. Never creates a native client.
/** @param {string} packagePath */
export async function verifyRecallConsumer(packagePath) {
  /** @template {keyof InstalledModules} Name @param {Name} name @returns {Promise<InstalledModules[Name]>} */
  const load = (name) => import(pathToFileURL(join(packagePath, 'dist', name)).href);
  const { createRecallEvents, createMessageUpdateEvents } = await load(
    'features/messages/recall-events.js',
  );
  const { createNativeServices } = await load('native-services.js');
  const { observeWatchEvents } = await load('cli.js');
  /** @type {[string, unknown][]} */
  const events = [];
  const listener = createRecallEvents((event, payload) => events.push([event, payload]));
  const raw = {
    chatType: 2,
    peerUid: '123',
    msgId: '900719925474099312345',
    msgSeq: '900719925474099312346',
    recallTime: '000900719925474099312347',
    private: 'must-not-leak',
  };
  /** @type {import('../../src/types.ts').MessageRecall} */
  const projected = {
    peer: { type: 'group', groupId: '123' },
    messageId: raw.msgId,
    sequence: raw.msgSeq,
    recallTime: raw.recallTime,
  };
  listener.onMessageUpdate(raw);
  assert.deepEqual(events, [['message.recalled', projected]]);
  listener.onMessageUpdate({ ...raw });
  assert.equal(events.length, 1);
  listener.onMessageUpdate({ ...raw, chatType: 1, peerUid: 'u_other', peerUin: '456' });
  assert.deepEqual(events[1], [
    'message.recalled',
    { ...projected, peer: { type: 'private', userId: '456' } },
  ]);
  for (const recallTime of [undefined, '0', '00'])
    listener.onMessageUpdate({ ...raw, msgId: '2', recallTime });
  assert.equal(events.length, 2);
  for (const change of [
    { msgId: 12 },
    { msgId: undefined },
    { msgSeq: 12 },
    { msgSeq: undefined },
    { recallTime: 12 },
    { recallTime: '-1' },
    { recallTime: '1.5' },
    { peerUid: 'invalid' },
    { chatType: 99 },
    { chatType: 1, peerUid: '', peerUin: '456' },
    { chatType: 1, peerUid: 'u_other', peerUin: '0' },
    { chatType: 1, peerUid: 'u_other', peerUin: 456 },
  ]) {
    /** @type {number} */
    const before = events.length;
    listener.onMessageUpdate({ ...raw, msgId: '3', ...change });
    assert.equal(events.length, before + 1);
    /** @type {[string,unknown]|undefined} */
    const last = events.at(-1);
    assert.ok(last);
    /** @type {string} */
    const event = last[0];
    /** @type {unknown} */
    const payload = last[1];
    assertRecord(payload);
    assert.equal(event, 'diagnostic');
    assert.equal(typeof payload.stage, 'string');
    assert.deepEqual(Object.keys(payload), ['stage']);
  }
  assert.ok(!JSON.stringify(events).includes('must-not-leak'));
  listener.close();
  const count = events.length;
  listener.onMessageUpdate({ ...raw, msgId: '4' });
  assert.equal(events.length, count);

  /** @type {[string, unknown][]} */
  const ingressEvents = [];
  const ingress = createMessageUpdateEvents({
    isClosed: () => false,
    emit: (event, payload) => ingressEvents.push([event, payload]),
    dispatchUpdates: (rows) => {
      assert.equal(rows[0], raw);
      ingressEvents.push(['correlation', rows]);
    },
  });
  ingress.onMessageUpdates([raw, null]);
  ingress.onMessageUpdates([raw]);
  assert.deepEqual(
    ingressEvents.map(([name]) => name),
    [
      'diagnostic',
      'correlation',
      'message.recalled',
      'message-recalled',
      'correlation',
      'message-recalled',
    ],
  );
  assert.equal(ingressEvents[3][1], raw);
  assert.equal(ingressEvents[5][1], raw);
  ingress.close();
  ingress.onMessageUpdates([raw]);
  ingress.onMessageUpdates(null);
  assert.equal(ingressEvents.length, 6);

  // Exercise actual Session callback integration and stop delivery after close.
  /** @type {{onMsgInfoListUpdate(value: unknown):void}|undefined} */
  let callback;
  /** @type {[string, unknown][]} */
  const delivered = [];
  const services = createNativeServices({
    session: {
      getMsgService: () => ({
        /** @param {{onMsgInfoListUpdate(value:unknown):void}} value */
        addKernelMsgListener(value) {
          callback = value;
        },
      }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
    },
    version: '7.0.2-53644',
    events: { emit: (event, payload) => delivered.push([event, payload]) },
  });
  try {
    assert.ok(callback);
    callback.onMsgInfoListUpdate([raw]);
    assert.deepEqual(
      delivered.filter(([event]) => event === 'message.recalled'),
      [['message.recalled', projected]],
    );
    assert.ok(
      delivered.some(([event]) => event === 'message-recalled'),
      'legacy raw recall remains available',
    );
    services.close();
    const before = delivered.length;
    assert.ok(callback);
    callback.onMsgInfoListUpdate([{ ...raw, msgId: '5' }]);
    assert.equal(delivered.length, before);
  } finally {
    services.close();
  }

  const { QQClient } = await load('index.js');
  const watchWorker = controlledCloseWorker();
  const client = new QQClient(watchWorker, 500);
  /** @type {unknown[]} */
  const lines = [];
  const cleanup = observeWatchEvents(client, 'normalized', (line) => lines.push(JSON.parse(line)));
  try {
    const normalized = [
      'message',
      'message.recalled',
      'request.friend',
      'request.group',
      'group-list-updated',
      'group-members-updated',
      'friend-list-updated',
    ];
    for (const event of normalized) Reflect.apply(client.emit, client, [event, { fixture: event }]);
    client.emit('message-recalled', { raw: 'must-not-leak' });
    Reflect.apply(client.emit, client, ['authenticated', {}]);
    Reflect.apply(client.emit, client, ['msf-status', {}]);
    assert.deepEqual(
      lines,
      normalized.map((event) => ({ event, payload: { fixture: event } })),
    );
    cleanup();
    client.emit('message.recalled', projected);
    assert.equal(lines.length, 7);
    /** @type {unknown[]} */
    const plain = [];
    const unwatch = observeWatchEvents(client, undefined, (line) => plain.push(JSON.parse(line)));
    try {
      client.emit('message.recalled', projected);
      Reflect.apply(client.emit, client, ['message', { fixture: true }]);
      assert.deepEqual(plain, [{ fixture: true }]);
    } finally {
      unwatch();
    }
  } finally {
    cleanup();
    await client.close();
  }
  return {
    ...(await verifyRecallOperationOwner(load)),
    normalizedRecallContract: true,
    messageUpdateIngressInstalledContract: true,
    nativeRecallObserved: false,
    accountUsed: false,
  };
}

/** Installed request owner and public facade; native callbacks and IPC are fixtures.
 * @param {<N extends keyof InstalledModules>(name:N)=>Promise<InstalledModules[N]>} load */
async function verifyRecallOperationOwner(load) {
  const { createMessageRecalls } = await load('features/messages/recall-operation.js');
  const { createNativeEventChannel } = await load('runtime/native-event-channel.js');
  const { createNativeServices } = await load('native-services.js');
  const { QQClient } = await load('index.js');
  const account = new AbortController(),
    channel = createNativeEventChannel(account.signal);
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  /** @template T @param {T|PromiseLike<T>} value @param {AbortSignal} signal @returns {Promise<T>} */
  const awaitAlive = (value, signal) =>
    new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      Promise.resolve(value).then(
        (v) => {
          signal.removeEventListener('abort', abort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener('abort', abort);
          reject(e);
        },
      );
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  /** @type {(value:import('../../src/native/message-contracts.ts').NativePeer)=>void} */
  let release = () => assert.fail('UID wait not started');
  let uidCalls = 0,
    acquisitions = 0,
    dispatches = 0,
    getters = 0;
  const owner = createMessageRecalls({
    signal: account.signal,
    resolvePeer(peer) {
      uidCalls++;
      assert.deepEqual(peer, { type: 'private', userId: '456' });
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    awaitAlive,
    getMessageService() {
      acquisitions++;
      return {
        recallMsg() {
          dispatches++;
        },
      };
    },
    eventCall: channel.call,
  });
  try {
    await assert.rejects(
      owner.recall({
        peer: { type: 'private', userId: '456' },
        get messageId() {
          getters++;
          return '42';
        },
      }),
    );
    assert.equal(getters, 0);
    assert.equal(uidCalls, 0);
    const other = channel.call(
      'fixture/other',
      (value) => value,
      () => ({ result: 0 }),
      1000,
    );
    const payload = { peer: { type: 'private', userId: '456' }, messageId: '42' },
      pending = owner.recall(payload),
      rejected = assert.rejects(pending, /closed|abort/i);
    owner.close();
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let timer;
    try {
      await Promise.race([
        rejected,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('Recall owner close stalled')), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    release({ chatType: 1, peerUid: 'u_456' });
    await tick();
    assert.equal(acquisitions, 0);
    assert.equal(dispatches, 0);
    assert.equal(account.signal.aborted, false);
    channel.dispatch('fixture/other', ['available']);
    assert.equal(await other, 'available');
  } finally {
    owner.close();
    channel.close();
  }
  for (const result of [0, 8]) {
    /** @type {{onMsgInfoListUpdate(value:unknown):void}|undefined} */
    let listener;
    /** @type {(value:unknown)=>void} */
    let finish = () => assert.fail('UID wait not started');
    let calls = 0,
      lookups = 0;
    const buddy = { addKernelBuddyListener() {} };
    const msg = {
      /** @param {{onMsgInfoListUpdate(value:unknown):void}} value */
      addKernelMsgListener(value) {
        listener = value;
      },
      /** @param {import('../../src/native/message-contracts.ts').NativePeer} peer @param {string[]} ids */
      recallMsg(peer, ids) {
        assert.equal(this, msg);
        calls++;
        assert.deepEqual(peer, { chatType: 1, peerUid: 'u_456' });
        assert.deepEqual(ids, ['42']);
        assert.ok(listener);
        listener.onMsgInfoListUpdate([
          { chatType: 1, peerUid: 'u_456', msgId: '42', recallTime: '101' },
        ]);
        return { result, credential: 'private fixture' };
      },
    };
    const services = createNativeServices({
      session: {
        getMsgService: () => msg,
        getBuddyService: () => buddy,
        getGroupService: () => ({ addKernelGroupListener() {} }),
        getUixConvertService: () => ({
          /** @param {string[]} ids */
          getUid(ids) {
            lookups++;
            assert.deepEqual(ids, ['456']);
            return new Promise((resolve) => {
              finish = resolve;
            });
          },
        }),
      },
      version: '7.0.2-53644',
      events: { emit() {} },
    });
    try {
      const payload = { peer: { type: 'private', userId: '456' }, messageId: '42' };
      const pending = services.invokeOperation('recallMessage', payload);
      const checked =
        result === 0
          ? pending
          : assert.rejects(
              pending,
              (error) =>
                error instanceof Error &&
                'code' in error &&
                error.code === 8 &&
                !error.message.includes('private fixture'),
            );
      payload.peer.userId = '999';
      payload.messageId = '99';
      await tick();
      finish({ uidInfo: new Map([['456', 'u_456']]) });
      await checked;
      assert.equal(calls, 1);
      assert.equal(lookups, 1);
    } finally {
      services.close();
    }
  }
  const worker = new ChildProcess();
  /** @type {Record<string,unknown>[]} */
  const requests = [];
  Object.assign(worker, {
    connected: true,
    exitCode: null,
    /** @param {unknown} value @param {(error:Error|null)=>void} callback */
    send(value, callback) {
      assertRecord(value);
      requests.push(value);
      callback(null);
      queueMicrotask(() => worker.emit('message', { id: value.id, result: undefined }));
    },
  });
  const client = new QQClient(worker, 500);
  try {
    worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'fixture' } });
    for (const action of [
      () => client.recallMessage({ type: 'group', groupId: '123' }, 'bad'),
      () =>
        client.recallMessage(
          {
            get type() {
              getters++;
              return /** @type {const} */ ('group');
            },
            groupId: '123',
          },
          '42',
        ),
    ])
      await assert.rejects(Promise.resolve().then(action));
    assert.equal(requests.length, 0);
    assert.equal(getters, 0);
    /** @type {Extract<import('../../src/types.ts').Peer,{type:'private'}>} */
    const peer = { type: 'private', userId: '456' };
    const pending = client.recallMessage(peer, '42');
    peer.userId = '999';
    await pending;
    assert.deepEqual(requests[0].peer, { type: 'private', userId: '456' });
    assert.equal(requests[0].messageId, '42');
    assert.equal(requests[0].method, 'recallMessage');
    return {
      recallIntentCaptureContract: true,
      recallOwnerCloseContract: true,
      recallOwnerSiblingContract: true,
      recallCompositionAckContract: true,
      recallPublicPreflightContract: true,
      nativeRecallAttempted: false,
    };
  } finally {
    Object.assign(worker, { connected: false, exitCode: 0 });
    worker.emit('exit', 0, null);
    await client.close();
  }
}

/** @param {unknown} value @returns {asserts value is Record<string,unknown>} */
function assertRecord(value) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
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
