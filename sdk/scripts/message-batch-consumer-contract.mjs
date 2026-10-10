import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Compiled installed-package contracts only: no native loading/account use. */
export async function verifyMessageBatchConsumer(packageRoot) {
  const load = (file) => import(pathToFileURL(join(packageRoot, 'dist', file)).href);
  const { QQClient } = await load('index.js');
  const { createNativeServices } = await load('native-services.js');
  const { prepareCommand } = await load('cli.js');
  assert.equal(typeof QQClient.prototype.getMessages, 'function');
  const id = '900719925474099312345';
  const raw = (msgId) => ({
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
        getMsgsByMsgId(peer, ids) {
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
    assert.deepEqual(
      values.map((message) => message?.messageId),
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
  assert.deepEqual(
    await action({
      getMessages: async (peer, ids) => {
        cliCalls++;
        assert.deepEqual(peer, payload.peer);
        assert.deepEqual(ids, payload.messageIds);
        return [{ messageId: id }, undefined, { messageId: '2' }];
      },
    }),
    [{ messageId: id }, null, { messageId: '2' }],
  );
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

async function verifyQueryOrchestration(load, raw) {
  const [{ createMessageQueries }, { NativeServiceLifetime }] = await Promise.all([
    load('features/messages/message-queries.js'),
    load('runtime/native-service-lifetime.js'),
  ]);
  const peer = { type: 'group', groupId: '123' },
    nativePeer = { chatType: 2, peerUid: '123' };
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a, b) => {
      resolve = a;
      reject = b;
    });
    return { promise, resolve, reject };
  };
  const turn = () => new Promise((resolve) => setImmediate(resolve));
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
  const invoke = (owner, method) =>
    method === 'getHistory'
      ? owner.getHistory(peer, { before: '42', limit: 2 })
      : method === 'getMessages'
        ? owner.getMessages(peer, ['9'])
        : owner.getMessage(peer, '9');
  for (const method of ['getMessage', 'getMessages', 'getHistory']) {
    const fixture = () => {
      const lifetime = new NativeServiceLifetime(),
        order = [];
      let nativeCalls = 0;
      const service = {
        getMsgsByMsgId(p, ids) {
          assert.equal(this, service);
          assert.deepEqual(p, nativePeer);
          assert.deepEqual(ids, ['9']);
          order.push('native');
          nativeCalls++;
          return { result: 0, msgList: [raw('9')] };
        },
        getMsgsIncludeSelf(...args) {
          assert.equal(this, service);
          assert.deepEqual(args, [nativePeer, '42', 2, false]);
          order.push('native');
          nativeCalls++;
          return { result: 0, msgList: [raw('9')] };
        },
      };
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
          return rows.map((row) => ({ messageId: row.msgId }));
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
      if (stage === 'resolver') f.context.resolvePeer = stalled;
      if (stage === 'native')
        f.service[method === 'getHistory' ? 'getMsgsIncludeSelf' : 'getMsgsByMsgId'] = stalled;
      if (stage === 'decode') f.context.decode = stalled;
      const pending = invoke(createMessageQueries(f.context), method);
      // Observe failures even if readiness/deadline assertions fail; still assert
      // the original promise below, so observation cannot turn rejection into pass.
      void pending.catch(() => {});
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
      const decoded = rows.map((row) => ({ messageId: row.msgId }));
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
