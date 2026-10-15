import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClientWorkerFixture } from './client-worker-fixture.mjs';

/** Exercise resource objects through the installed public entry point. Controlled
 * IPC proves SDK routing and lifetime, without native execution or account access.
 * @param {string} packageRoot */
export async function verifyContactResourcesConsumer(packageRoot) {
  const api = await /** @type {Promise<typeof import('../../src/index.ts')>} */ (
    import(pathToFileURL(join(packageRoot, 'dist/index.js')).href)
  );
  return verifyContactResourcesClient(api);
}

/** The same contract can run against source before the package is built.
 * @param {Pick<typeof import('../../src/index.ts'), 'QQClient' | 'GroupFiles' | 'GroupNotices' | 'GroupEssence'>} api */
export async function verifyContactResourcesClient({
  QQClient,
  GroupFiles,
  GroupNotices,
  GroupEssence,
}) {
  const worker = new ClientWorkerFixture();
  const client = new QQClient(worker, 500);
  const account = { uin: '123', uid: 'u_self' };
  const groupId = '000789';
  const messageId = '000900719925474099312345';
  const destination = resolve('consumer-attachment.bin');
  const filePage = {
    groupId,
    startIndex: 0,
    fileCount: 2,
    items: [],
    isEnd: true,
    nextIndex: 0,
    allFileCount: 0,
  };
  const folder = { groupId, folderId: '/created', parentFolderId: '/', name: ' folder ' };
  const essencePage = {
    groupId,
    pageStart: 0,
    pageLimit: 2,
    messages: [],
    isEnd: true,
    groupRole: 1,
  };
  const noticePage = { notices: [], raw: {} };
  const mergedReceipt = { messageId: '99', sequence: '1', time: 100, resourceId: 'resource' };
  const attachment = { file: destination };
  /** @type {import('../../src/types.ts').Message[]} */
  const forwarded = [];
  /** @type {unknown[]} */
  const emptyList = [];
  worker.respond = ({ method }) => {
    switch (method) {
      case 'getGroupFileCount':
        return 4;
      case 'getGroupFilePage':
        return filePage;
      case 'createGroupFolder':
        return folder;
      case 'getGroupEssencePage':
        return essencePage;
      case 'listGroupNotices':
        return noticePage;
      case 'listGroupFiles':
      case 'listGroupEssenceMessages':
      case 'listGroupMutedMembers':
        return emptyList;
      case 'getForwardMessages':
        return forwarded;
      case 'sendMergedForward':
        return mergedReceipt;
      case 'downloadAttachment':
        return attachment;
      default:
        return undefined;
    }
  };
  const commands = () => worker.requests.map(({ id: _id, ...command }) => command);
  try {
    worker.emit('message', { event: 'ready', payload: account });
    const group = client.pickGroup(groupId);
    const friend = client.pickFriend('000456');
    assert.ok(group.files instanceof GroupFiles);
    assert.ok(group.notices instanceof GroupNotices);
    assert.ok(group.essence instanceof GroupEssence);
    for (const key of /** @type {const} */ (['files', 'notices', 'essence'])) {
      assert.equal(Object.isFrozen(group[key]), true);
      assert.equal(group[key].groupId, groupId);
      assert.equal(Reflect.set(group[key], 'groupId', '999'), false);
      assert.equal(Reflect.set(group, key, {}), false);
    }
    assert.equal(Reflect.set(group.peer, 'groupId', '999'), false);
    assert.equal(Reflect.set(friend.peer, 'userId', '999'), false);
    assert.equal(worker.requests.length, 0, 'selecting resource objects must stay local');

    assert.equal(await group.files.count(), 4);
    assert.strictEqual(await group.files.getPage({ folderId: '/folder', fileCount: 2 }), filePage);
    assert.strictEqual(await group.files.list(), emptyList);
    assert.strictEqual(await group.files.createFolder(' folder '), folder);
    await group.files.deleteFolder('/folder');
    await group.files.deleteFile('opaque:file/001');
    assert.strictEqual(await group.essence.getPage({ pageLimit: 2 }), essencePage);
    assert.strictEqual(await group.essence.list({ maxPages: 3 }), emptyList);
    await group.essence.set(messageId, false);
    assert.strictEqual(await group.notices.list(), noticePage);
    const noticeOptions = { pinned: true, confirmRequired: false };
    const publication = group.notices.publish('notice', noticeOptions);
    noticeOptions.pinned = false;
    await publication;
    await group.notices.delete('opaque-notice-id');
    assert.strictEqual(await group.listMutedMembers(), emptyList);
    assert.deepEqual(commands(), [
      { method: 'getGroupFileCount', groupId },
      {
        method: 'getGroupFilePage',
        groupId,
        options: {
          folderId: '/folder',
          sortType: 1,
          fileCount: 2,
          startIndex: 0,
          sortOrder: 2,
          showOnlinedocFolder: 0,
        },
      },
      {
        method: 'listGroupFiles',
        groupId,
        options: {
          sortType: 1,
          fileCount: 50,
          sortOrder: 2,
          showOnlinedocFolder: 0,
          maxPages: 20,
        },
      },
      { method: 'createGroupFolder', groupId, name: ' folder ' },
      { method: 'deleteGroupFolder', groupId, folderId: '/folder' },
      { method: 'deleteGroupFile', groupId, fileId: 'opaque:file/001' },
      { method: 'getGroupEssencePage', groupId, options: { pageStart: 0, pageLimit: 2 } },
      { method: 'listGroupEssenceMessages', groupId, options: { maxPages: 3 } },
      { method: 'setGroupEssenceMessage', groupId, messageId, enabled: false },
      { method: 'listGroupNotices', groupId },
      {
        method: 'publishGroupNotice',
        groupId,
        text: 'notice',
        options: { pinned: true, confirmRequired: false },
      },
      { method: 'deleteGroupNotice', groupId, noticeId: 'opaque-notice-id' },
      { method: 'listGroupMutedMembers', groupId },
    ]);

    for (const contact of [friend, group]) {
      /** @type {number} */
      const before = worker.requests.length;
      assert.strictEqual(await contact.getForwardMessages(messageId), forwarded);
      assert.strictEqual(await contact.getForwardMessages(messageId, '0002'), forwarded);
      /** @type {import('../../src/types.ts').Peer} */
      const target = { type: 'private', userId: '000987' };
      const messageIds = [messageId, messageId, '0002'];
      const forwarding = contact.forwardMessages(target, messageIds);
      target.userId = '999';
      messageIds[0] = '999';
      await forwarding;
      const nodes = Object.freeze([
        Object.freeze({ userId: '456', nickname: 'fixture', time: 100, text: 'record' }),
      ]);
      const cardOptions = Object.freeze({ title: 'title', summary: 'summary', prompt: 'prompt' });
      assert.strictEqual(await contact.sendMergedForward(nodes, cardOptions), mergedReceipt);
      assert.strictEqual(
        await contact.downloadAttachment(messageId, '0008', destination),
        attachment,
      );
      assert.deepEqual(commands().slice(before), [
        {
          method: 'getForwardMessages',
          peer: contact.peer,
          rootMessageId: messageId,
          parentMessageId: messageId,
        },
        {
          method: 'getForwardMessages',
          peer: contact.peer,
          rootMessageId: messageId,
          parentMessageId: '0002',
        },
        {
          method: 'forwardMessages',
          source: contact.peer,
          destination: { type: 'private', userId: '000987' },
          messageIds: [messageId, messageId, '0002'],
        },
        { method: 'sendMergedForward', peer: contact.peer, nodes, options: cardOptions },
        {
          method: 'downloadAttachment',
          peer: contact.peer,
          messageId,
          elementId: '0008',
          destination,
        },
      ]);
    }

    const beforeInvalid = worker.requests.length;
    await assert.rejects(group.files.getPage({ fileCount: 0 }));
    await assert.rejects(group.essence.getPage({ pageLimit: 51 }));
    await assert.rejects(group.notices.delete(''));
    await assert.rejects(friend.getForwardMessages('resource-id'));
    await assert.rejects(group.forwardMessages(friend.peer, []));
    await assert.rejects(friend.sendMergedForward([]));
    await assert.rejects(group.downloadAttachment(messageId, '8', 'relative.bin'));
    assert.equal(worker.requests.length, beforeInvalid);

    worker.failure = { message: 'controlled resource effect unknown', code: 73 };
    for (const invoke of [
      () => group.files.deleteFile('opaque-file'),
      () => group.essence.set(messageId, true),
      () => group.notices.publish('notice'),
      () => friend.forwardMessages(group.peer, [messageId]),
      () =>
        group.sendMergedForward([
          { userId: '456', nickname: 'fixture', time: 100, text: 'record' },
        ]),
    ]) {
      /** @type {number} */
      const beforeFailure = worker.requests.length;
      await assert.rejects(invoke(), { message: 'controlled resource effect unknown', code: 73 });
      assert.equal(worker.requests.length, beforeFailure + 1, 'mutations must not be replayed');
    }
    worker.failure = undefined;

    worker.emit('message', { event: 'disconnected', payload: { retryable: false } });
    worker.emit('message', { event: 'ready', payload: account });
    const beforeRetired = worker.requests.length;
    for (const invoke of [
      () => group.files.count(),
      () => group.essence.list(),
      () => group.notices.list(),
      () => group.listMutedMembers(),
      () => friend.getForwardMessages(messageId),
      () => group.forwardMessages(friend.peer, [messageId]),
      () =>
        friend.sendMergedForward([
          { userId: '456', nickname: 'fixture', time: 100, text: 'record' },
        ]),
      () => group.downloadAttachment(messageId, '8', destination),
    ])
      await assert.rejects(invoke(), /session|inactive/);
    assert.equal(worker.requests.length, beforeRetired);

    const activeGroup = client.pickGroup(groupId);
    const changedAccount = { uin: '321', uid: 'u_other' };
    const reentrantOptions = new Proxy(
      { fileCount: 2 },
      {
        getOwnPropertyDescriptor(target, key) {
          worker.emit('message', { event: 'ready', payload: changedAccount });
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    await assert.rejects(activeGroup.files.getPage(reentrantOptions), /session|inactive/);
    await assert.rejects(activeGroup.notices.list(), /session|inactive/);
    await assert.rejects(activeGroup.essence.list(), /session|inactive/);
    assert.equal(worker.requests.length, beforeRetired);

    const currentGroup = client.pickGroup(groupId);
    const currentFriend = client.pickFriend('000456');
    assert.equal(await currentGroup.files.count(), 4);
    assert.strictEqual(await currentFriend.getForwardMessages(messageId), forwarded);
    await client.close();
    const afterClose = worker.requests.length;
    await assert.rejects(currentGroup.files.count(), /session|inactive/);
    await assert.rejects(currentGroup.essence.list(), /session|inactive/);
    await assert.rejects(currentGroup.notices.list(), /session|inactive/);
    await assert.rejects(
      currentFriend.downloadAttachment(messageId, '8', destination),
      /session|inactive/,
    );
    assert.equal(worker.requests.length, afterClose);
  } finally {
    worker.failure = undefined;
    await client.close();
  }
  return {
    installedGroupResources: true,
    installedConversationResources: true,
    installedResourceLifetime: true,
  };
}
