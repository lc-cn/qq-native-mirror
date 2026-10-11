/** @typedef {{'cli.js':typeof import('../../src/cli.ts'),
'features/messages/message-queries.js':typeof import('../../src/features/messages/message-queries.ts'),
'index.js':typeof import('../../src/index.ts'),
'native-services.js':typeof import('../../src/native-services.ts'),
'runtime/native-service-lifetime.js':typeof import('../../src/runtime/native-service-lifetime.ts')}} InstalledModules */
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Compiled installed-package contracts only: no native loading/account use. */
/** @param {string} packageRoot */
export async function verifyMessageBatchConsumer(packageRoot) {
  /** @template {keyof InstalledModules} Name @param {Name} file @returns {Promise<InstalledModules[Name]>} */
  const load = (file) => import(pathToFileURL(join(packageRoot, 'dist', file)).href);
  const { QQClient } = await load('index.js');
  const { createNativeServices } = await load('native-services.js');
  const { prepareCommand } = await load('cli.js');
  assert.equal(typeof QQClient.prototype.getMessages, 'function');
  const id = '900719925474099312345';
  const raw = (/** @type {string} */ msgId) => ({
    msgId,
    msgSeq: '9',
    msgTime: '100',
    chatType: 2,
    peerUid: '123',
    peerUin: '123',
    senderUin: '456',
    senderUid: 'u_fixture',
    sendNickName: 'fixture',
    elements: [],
  });
  let calls = 0,
    response = { result: 0, msgList: [raw('2'), raw(id)] };
  const services = createNativeServices({
    session: {
      getMsgService: () => ({
        addKernelMsgListener() {},
        getMsgsByMsgId(/** @type {unknown} */ peer, /** @type {unknown} */ ids) {
          calls++;
          assert.deepEqual(peer, { chatType: 2, peerUid: '123' });
          assert.deepEqual(ids, [id, '3', '2']);
          return response;
        },
      }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
    },
    version: '7.0.2-53644',
    events: { emit: () => {} },
  });
  const payload = { peer: { type: 'group', groupId: '123' }, messageIds: [id, '3', '2'] };
  try {
    const values = await services.invokeOperation('getMessages', payload);
    assert.ok(Array.isArray(values));
    assert.deepEqual(
      values.map((/** @type {unknown} */ message) => {
        if (message === undefined) return undefined;
        assertMessage(message);
        return message.messageId;
      }),
      [id, undefined, '2'],
    );
    assert.equal(calls, 1);
    for (const msgList of [
      [raw(id), raw(id)],
      [raw('other')],
      Array(1),
      [{ ...raw(id), peerUid: 'other' }],
    ]) {
      response = { result: 0, msgList };
      await assert.rejects(
        services.invokeOperation('getMessages', payload),
        /invalid|unexpected|duplicate|mismatched/,
      );
    }
    response = { result: 23, msgList: [] };
    await assert.rejects(services.invokeOperation('getMessages', payload), { code: 23 });
    assert.equal(calls, 6);
    for (const ids of [[], [id, id], Array(1)])
      await assert.rejects(
        services.invokeOperation('getMessages', { ...payload, messageIds: ids }),
        /messageIds/,
      );
    assert.equal(calls, 6);
  } finally {
    services.close();
  }
  await assert.rejects(services.invokeOperation('getMessages', payload), /closed/);
  assert.equal(calls, 6);
  const action = await prepareCommand('messages', {
    kind: 'group',
    target: '123',
    'message-ids': `${id},3,2`,
  });
  let cliCalls = 0;
  const worker = controlledCloseWorker();
  const client = new QQClient(worker, 500);
  client.getMessages = async (peer, ids) => {
    cliCalls++;
    assert.deepEqual(peer, payload.peer);
    assert.deepEqual(ids, payload.messageIds);
    return [fixtureMessage(id), undefined, fixtureMessage('2')];
  };
  try {
    assert.deepEqual(await action(client), [fixtureMessage(id), null, fixtureMessage('2')]);
  } finally {
    await client.close();
  }
  assert.equal(cliCalls, 1);
  await assert.rejects(
    prepareCommand('messages', { kind: 'group', target: '123', 'message-ids': '1,1' }),
    /duplicate/,
  );
  const ownerChecks = await verifyQueryOrchestration(load, raw);
  return {
    ...ownerChecks,
    messageBatchQueryContract: true,
    messageBatchCliContract: true,
    nativeMessageBatchQueryAttempted: false,
  };
}

/** @param {<N extends keyof InstalledModules>(name:N)=>Promise<InstalledModules[N]>} load
 * @param {(id:string)=>Record<string,unknown>} raw */
async function verifyQueryOrchestration(load, raw) {
  const [{ createMessageQueries }, { NativeServiceLifetime }] = await Promise.all([
    load('features/messages/message-queries.js'),
    load('runtime/native-service-lifetime.js'),
  ]);
  /** @type {Extract<import('../../src/contracts/messages.ts').Peer,{type:'group'}>} */
  const peer = { type: 'group', groupId: '123' };
  /** @type {import('../../src/native/message-contracts.ts').NativePeer} */
  const nativePeer = { chatType: 2, peerUid: '123' };
  const deferred = () => {
    /** @type {(value?:unknown)=>void} */ let resolve = () => assert.fail('resolver missing');
    /** @type {(reason:unknown)=>void} */ let reject = () => assert.fail('rejector missing');
    const promise = new Promise((a, b) => {
      resolve = a;
      reject = b;
    });
    return { promise, resolve, reject };
  };
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  /** @template T @param {Promise<T>} promise */
  const bounded = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('Query settlement deadline exceeded')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  /** @param {ReturnType<InstalledModules['features/messages/message-queries.js']['createMessageQueries']>} owner
   * @param {'getHistory'|'getMessages'|'getMessage'} method @returns {Promise<unknown>} */
  const invoke = (owner, method) =>
    method === 'getHistory'
      ? owner.getHistory(peer, { before: '42', limit: 2 })
      : method === 'getMessages'
        ? owner.getMessages(peer, ['9'])
        : owner.getMessage(peer, '9');
  for (const method of /** @type {const} */ (['getMessage', 'getMessages', 'getHistory'])) {
    const fixture = () => {
      const lifetime = new NativeServiceLifetime();
      /** @type {string[]} */ const order = [];
      let nativeCalls = 0;
      /** @type {import('../../src/features/messages/message-query.ts').MessageQueryPort} */
      const service = {
        getMsgsByMsgId(/** @type {unknown} */ p, /** @type {unknown} */ ids) {
          assert.equal(this, service);
          assert.deepEqual(p, nativePeer);
          assert.deepEqual(ids, ['9']);
          order.push('native');
          nativeCalls++;
          return { result: 0, msgList: [raw('9')] };
        },
        getMsgsIncludeSelf(/** @type {unknown[]} */ ...args) {
          assert.equal(this, service);
          assert.deepEqual(args, [nativePeer, '42', 2, false]);
          order.push('native');
          nativeCalls++;
          return { result: 0, msgList: [raw('9')] };
        },
      };
      /** @type {import('../../src/features/messages/message-queries.ts').MessageQueriesContext} */
      const context = {
        signal: lifetime.signal,
        awaitAlive: (value) => lifetime.awaitAlive(value),
        getMessageService() {
          order.push('service');
          return service;
        },
        resolvePeer: async () => {
          order.push('peer');
          return nativePeer;
        },
        decode: async (rows) => {
          order.push('decode');
          return rows.map((row) => {
            assert.equal(typeof row.msgId, 'string');
            assert.ok(typeof row.msgId === 'string');
            return fixtureMessage(row.msgId);
          });
        },
      };
      return { lifetime, context, service, order, calls: () => nativeCalls };
    };
    const normal = fixture();
    try {
      await invoke(createMessageQueries(normal.context), method);
      assert.deepEqual(
        normal.order,
        method === 'getHistory'
          ? ['peer', 'service', 'native', 'decode']
          : ['service', 'peer', 'native', 'decode'],
      );
      assert.equal(normal.calls(), 1);
    } finally {
      normal.lifetime.close();
    }
    for (const stage of ['service', 'method']) {
      const f = fixture();
      let getterReads = 0;
      if (stage === 'service')
        f.context.getMessageService = () => {
          f.lifetime.close();
          return f.service;
        };
      else
        Object.defineProperty(
          f.service,
          method === 'getHistory' ? 'getMsgsIncludeSelf' : 'getMsgsByMsgId',
          {
            get() {
              getterReads++;
              f.lifetime.close();
              return () => {
                throw Error('Unexpected dispatch');
              };
            },
          },
        );
      try {
        await assert.rejects(
          bounded(invoke(createMessageQueries(f.context), method)),
          /closed|abort/i,
        );
        assert.equal(f.calls(), 0);
        assert.equal(getterReads, stage === 'method' ? 1 : 0);
      } finally {
        f.lifetime.close();
      }
    }
    for (const stage of ['resolver', 'native', 'decode']) {
      const f = fixture(),
        started = deferred(),
        response = deferred();
      const stalled = () => {
        started.resolve();
        return response.promise;
      };
      if (stage === 'resolver')
        f.context.resolvePeer = async () => {
          await stalled();
          throw Error('Unexpected late resolver completion');
        };
      if (stage === 'native')
        f.service[method === 'getHistory' ? 'getMsgsIncludeSelf' : 'getMsgsByMsgId'] = stalled;
      if (stage === 'decode')
        f.context.decode = async () => {
          await stalled();
          throw Error('Unexpected late decode completion');
        };
      const pending = invoke(createMessageQueries(f.context), method);
      // Observe failures even if readiness/deadline assertions fail; still assert
      // the original promise below, so observation cannot turn rejection into pass.
      pending.catch(() => {});
      try {
        await bounded(started.promise);
        f.lifetime.close();
        await assert.rejects(bounded(pending), /closed|abort/i);
        response.reject(Error('Late synthetic query rejection'));
        await turn();
        if (stage === 'resolver') assert.equal(f.calls(), 0);
      } finally {
        f.lifetime.close();
      }
    }
    const accessor = fixture();
    accessor.context.decode = async (rows) => {
      const decoded = rows.map((row) => {
        assert.equal(typeof row.msgId, 'string');
        assert.ok(typeof row.msgId === 'string');
        return fixtureMessage(row.msgId);
      });
      // Promise adoption touches this accessor; retirement must win over publication.
      Object.defineProperty(decoded, 'then', {
        get() {
          accessor.lifetime.close();
          return undefined;
        },
      });
      return decoded;
    };
    try {
      await assert.rejects(
        bounded(invoke(createMessageQueries(accessor.context), method)),
        /closed|abort/i,
      );
    } finally {
      accessor.lifetime.close();
    }
    if (method !== 'getHistory') {
      const index = fixture();
      index.context.decode = async () =>
        Object.defineProperty([], 0, {
          get() {
            index.lifetime.close();
            return { messageId: '9' };
          },
        });
      try {
        await assert.rejects(
          bounded(invoke(createMessageQueries(index.context), method)),
          /closed|abort/i,
        );
      } finally {
        index.lifetime.close();
      }
    }
  }
  return {
    messageQueryCancellationContract: true,
    messageQueryGetterAbortContract: true,
    messageQueryReceiverAndOrderContract: true,
    messageQueryDecodeAccessorAbortContract: true,
    messageQueryLateFailureObserved: true,
    nativeMessageQueryOrchestrationAttempted: false,
  };
}

/** @param {string} messageId @returns {import('../../src/contracts/messages.ts').Message} */
function fixtureMessage(messageId) {
  return {
    messageId,
    sequence: '9',
    time: 100,
    peer: { type: 'group', groupId: '123' },
    sender: { userId: '456', uid: 'u_fixture', nickname: 'fixture' },
    elements: [],
    raw: undefined,
  };
}

/** @param {unknown} value @returns {asserts value is import('../../src/types.ts').Message} */
function assertMessage(value) {
  assert.ok(value !== null && typeof value === 'object');
  assert.ok('messageId' in value && typeof value.messageId === 'string');
  assert.ok('elements' in value && Array.isArray(value.elements));
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
