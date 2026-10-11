import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
/** @param {string} packageRoot */
export async function verifyHistoryQueryConsumer(packageRoot) {
  /** @type {typeof import('../../src/native-services.ts')} */
  const { createNativeServices } = await import(
    pathToFileURL(join(packageRoot, 'dist/native-services.js')).href
  );
  /** @type {typeof import('../../src/cli.ts')} */
  const { prepareCommand } = await import(pathToFileURL(join(packageRoot, 'dist/cli.js')).href);
  /** @type {typeof import('../../src/features/messages/message-query.ts')} */
  const { queryNativeMessage } = await import(
    pathToFileURL(join(packageRoot, 'dist/features/messages/message-query.js')).href
  );
  /** @type {typeof import('../../src/client/qq-client.ts')} */
  const { QQClient } = await import(
    pathToFileURL(join(packageRoot, 'dist/client/qq-client.js')).href
  );
  /** @type {Parameters<typeof queryNativeMessage>[1]} */
  const peer = { chatType: 2, peerUid: '123' },
    id = '900719925474099312345';
  const raw = {
    msgId: id,
    msgSeq: '9',
    msgTime: '100',
    chatType: 2,
    peerUid: '123',
    peerUin: '123',
    senderUin: '456',
    senderUid: 'u_friend',
    sendNickName: 'fixture',
    elements: [{ elementType: 1, textElement: { content: 'fixture', atType: 0 } }],
  };
  /** @param {unknown} response */
  function fixture(response) {
    let calls = 0;
    const services = createNativeServices({
      session: {
        getMsgService: () => ({
          addKernelMsgListener() {},
          getMsgsIncludeSelf(/** @type {unknown[]} */ ...args) {
            calls++;
            assert.deepEqual(args, [peer, '42', 2, false]);
            return response;
          },
        }),
        getBuddyService: () => ({ addKernelBuddyListener() {} }),
        getGroupService: () => ({ addKernelGroupListener() {} }),
      },
      version: '7.0.2-53644',
      events: { emit: () => {} },
    });
    return { services, calls: () => calls };
  }
  const payload = { peer: { type: 'group', groupId: '123' }, options: { before: '42', limit: 2 } };
  for (const [result, code] of /** @type {[unknown,string|number][]} */ ([
    [-1, -1],
    [73, 73],
    ['denied', 'denied'],
    [undefined, 'invalid-result'],
    [NaN, 'invalid-result'],
  ]))
    for (const msgList of [[], [raw]]) {
      const { services, calls } = fixture({ result, msgList, errMsg: 'must-not-leak' });
      try {
        await assert.rejects(
          services.invokeOperation('getHistory', payload),
          (/** @type {unknown} */ error) => {
            assert.ok(error instanceof Error);
            assert.equal(Reflect.get(error, 'code'), code);
            assert.ok(!error.message.includes('must-not-leak'));
            return true;
          },
        );
        assert.equal(calls(), 1);
      } finally {
        services.close();
      }
    }
  for (const msgList of [
    Array(1),
    [{ ...raw, chatType: 1 }],
    [{ ...raw, chatType: 99 }],
    [{ ...raw, peerUid: '999' }],
    [{ ...raw, msgId: 123 }],
    [{ ...raw, elements: Array(1) }],
  ]) {
    const { services, calls } = fixture({ result: 0, msgList });
    try {
      await assert.rejects(services.invokeOperation('getHistory', payload), /invalid|mismatched/i);
      assert.equal(calls(), 1);
    } finally {
      services.close();
    }
  }
  for (const msgList of [[], [{ ...raw, msgId: '3' }, raw]]) {
    const { services, calls } = fixture({ result: 0, msgList });
    try {
      const action = await prepareCommand('history', {
        kind: 'group',
        target: '123',
        before: '42',
        limit: '2',
      });
      const worker = new ChildProcess();
      Reflect.set(worker, 'connected', true);
      worker.send = (request) => {
        assert.ok(request && typeof request === 'object');
        const requestId = Reflect.get(request, 'id');
        assert.equal(Reflect.get(request, 'method'), 'getHistory');
        const task = services
          .invokeOperation('getHistory', {
            peer: Reflect.get(request, 'peer'),
            options: Reflect.get(request, 'options'),
          })
          .then(
            (data) => {
              worker.emit('message', { id: requestId, result: data });
            },
            (error) => {
              worker.emit('message', { id: requestId, success: false, error: String(error) });
            },
          );
        task.catch((error) => {
          queueMicrotask(() => {
            throw error;
          });
        });
        return true;
      };
      const client = new QQClient(worker, 500);
      worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_fixture' } });
      let records;
      try {
        records = await action(client);
      } finally {
        Reflect.set(worker, 'exitCode', 0);
        worker.emit('exit', 0, null);
        await client.close();
      }
      assert.ok(Array.isArray(records));
      assert.deepEqual(
        records.map((r) => r.messageId),
        msgList.map((r) => r.msgId),
      );
      for (const record of records)
        assert.deepEqual(record.elements, [{ type: 'text', text: 'fixture' }]);
      assert.equal(calls(), 1);
    } finally {
      services.close();
    }
  }
  await assert.rejects(
    queryNativeMessage(
      { getMsgsByMsgId: () => ({ result: 0, msgList: [{ ...raw, elements: Array(1) }] }) },
      peer,
      id,
    ),
    /elements/i,
  );
  /** @type {(value:unknown)=>void} */
  let finish = () => assert.fail('Native wait missing');
  let begin = () => {};
  let calls = 0;
  const began = new Promise(
    /** @type {(resolve:(value:void)=>void)=>void} */ (
      /** @param {()=>void} resolve */ (resolve) => {
        begin = resolve;
      }
    ),
  );
  const delayed = new Promise(
    /** @param {(value:unknown)=>void} resolve */ (resolve) => {
      finish = resolve;
    },
  );
  const closing = createNativeServices({
    session: {
      getMsgService: () => ({
        addKernelMsgListener() {},
        getMsgsIncludeSelf() {
          calls++;
          begin();
          return delayed;
        },
      }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
    },
    version: '7.0.2-53644',
    events: { emit: () => {} },
  });
  const pending = closing.invokeOperation('getHistory', payload);
  await began;
  closing.close();
  finish({ result: 0, msgList: [] });
  await assert.rejects(pending, /abort|closed/i);
  assert.equal(calls, 1);
  return { historyQueryContract: true, nativeHistoryQueryAttempted: false };
}
