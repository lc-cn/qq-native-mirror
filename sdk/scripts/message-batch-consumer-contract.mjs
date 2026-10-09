import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Compiled installed-package contracts only: no native loading/account use. */
export async function verifyMessageBatchConsumer(packageRoot) {
  const load = file => import(pathToFileURL(join(packageRoot, 'dist', file)).href);
  const { QQClient } = await load('index.js');
  const { createNativeServices } = await load('native-services.js');
  const { prepareCommand } = await load('cli.js');
  assert.equal(typeof QQClient.prototype.getMessages, 'function');
  const id = '900719925474099312345';
  const raw = msgId => ({ msgId, msgSeq: '9', msgTime: '100', chatType: 2, peerUid: '123', peerUin: '123', senderUin: '456', senderUid: 'u_fixture', sendNickName: 'fixture', elements: [] });
  let calls = 0, response = { result: 0, msgList: [raw('2'), raw(id)] };
  const services = createNativeServices({
    getMsgService: () => ({ addKernelMsgListener() {}, getMsgsByMsgId(peer, ids) {
      calls++; assert.deepEqual(peer, { chatType: 2, peerUid: '123' }); assert.deepEqual(ids, [id, '3', '2']); return response;
    } }),
    getBuddyService: () => ({ addKernelBuddyListener() {} }),
    getGroupService: () => ({ addKernelGroupListener() {} }),
  }, '7.0.2-53644', () => {});
  const payload = { peer: { type: 'group', groupId: '123' }, messageIds: [id, '3', '2'] };
  try {
    const values = await services.invokeOperation('getMessages', payload);
    assert.deepEqual(values.map(message => message?.messageId), [id, undefined, '2']); assert.equal(calls, 1);
    for (const msgList of [[raw(id), raw(id)], [raw('other')], Array(1), [{ ...raw(id), peerUid: 'other' }]]) {
      response = { result: 0, msgList };
      await assert.rejects(services.invokeOperation('getMessages', payload), /invalid|unexpected|duplicate|mismatched/);
    }
    response = { result: 23, msgList: [] };
    await assert.rejects(services.invokeOperation('getMessages', payload), { code: 23 }); assert.equal(calls, 6);
    for (const ids of [[], [id, id], Array(1)]) await assert.rejects(services.invokeOperation('getMessages', { ...payload, messageIds: ids }), /messageIds/);
    assert.equal(calls, 6);
  } finally { services.close(); }
  await assert.rejects(services.invokeOperation('getMessages', payload), /closed/); assert.equal(calls, 6);
  const action = await prepareCommand('messages', { kind: 'group', target: '123', 'message-ids': `${id},3,2` });
  let cliCalls = 0;
  assert.deepEqual(await action({ getMessages: async (peer, ids) => {
    cliCalls++; assert.deepEqual(peer, payload.peer); assert.deepEqual(ids, payload.messageIds); return [{ messageId: id }, undefined, { messageId: '2' }];
  } }), [{ messageId: id }, null, { messageId: '2' }]); assert.equal(cliCalls, 1);
  await assert.rejects(prepareCommand('messages', { kind: 'group', target: '123', 'message-ids': '1,1' }), /duplicate/);
  return { messageBatchQueryContract: true, messageBatchCliContract: true, nativeMessageBatchQueryAttempted: false };
}
