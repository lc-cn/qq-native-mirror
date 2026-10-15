import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClientWorkerFixture } from './client-worker-fixture.mjs';

/** Verify ergonomic bot APIs through the installed public client. The worker is
 * controlled: assertions prove SDK routing and lifetime, not remote QQ effects.
 * @param {string} packageRoot */
export async function verifyBotApiConsumer(packageRoot) {
  const api = await /** @type {Promise<typeof import('../../src/index.ts')>} */ (
    import(pathToFileURL(join(packageRoot, 'dist/index.js')).href)
  );
  return verifyBotApiClient(api);
}

/** The same observable contract runs against source and the installed archive.
 * @param {Pick<typeof import('../../src/index.ts'), 'QQClient' | 'segment'>} api */
export async function verifyBotApiClient({ QQClient, segment }) {
  const worker = new ClientWorkerFixture();
  const receipt = { messageId: '99', sequence: '1', time: 1 };
  const memberInfo = {
    userId: '456',
    uid: 'u_friend',
    nickname: 'friend',
    card: 'project admin',
    role: 'admin',
  };
  worker.respond = (command) =>
    command.method === 'handleFriendRequest' ||
    command.method === 'handleGroupRequest' ||
    command.method === 'setGroupMemberCard'
      ? undefined
      : command.method === 'getGroupMember'
        ? { ...memberInfo }
        : receipt;
  const client = new QQClient(worker, 500);
  const account = { uin: '123', uid: 'u_self' };
  try {
    worker.emit('message', { event: 'ready', payload: account });
    await client.sendPrivateMessage('456', segment.text('direct'));
    await client.pickGroup('789').sendMessage(Object.freeze([segment.at('456'), ' hello']));
    /** @type {import('../../src/types.ts').MessageEvent | undefined} */
    let message;
    /** @type {unknown[]} */
    const aliases = [];
    /** @type {import('../../src/types.ts').GroupMessageEvent | undefined} */
    let groupMessage;
    /** @type {import('../../src/types.ts').PrivateMessageEvent | undefined} */
    let privateMessage;
    client.on('message', (event) => {
      message = event;
      assert.equal(Reflect.set(event, 'peer', { type: 'private', userId: '999' }), false);
      assert.equal(Reflect.set(event.peer, 'type', 'private'), false);
      assert.equal(Reflect.deleteProperty(event, 'peer'), false);
    });
    client.on('message.group', (event) => {
      assert.equal(event.peer.groupId, '789');
      aliases.push(event);
      groupMessage = event;
    });
    client.on('message.private', (event) => {
      privateMessage = event;
    });
    /** @type {import('../../src/types.ts').Message} */
    const raw = {
      messageId: '42',
      sequence: '1',
      time: 1,
      peer: { type: 'group', groupId: '789' },
      sender: { userId: '456', uid: 'u_friend', nickname: 'friend' },
      elements: [segment.text(' ping'), segment.at('123'), segment.text(' pong ')],
      raw: { retained: true },
    };
    worker.emit('message', { event: 'message', payload: raw });
    assert.ok(message);
    assert.ok(groupMessage);
    assert.equal(message.text, ' ping pong ');
    assert.strictEqual(message.conversation, groupMessage.group);
    assert.equal(groupMessage.member.userId, '456');
    assert.equal(groupMessage.member.groupId, '789');
    for (const key of ['text', 'conversation', 'group', 'member']) {
      assert.equal(Reflect.set(message, key, 'altered'), false);
      assert.equal(Reflect.deleteProperty(message, key), false);
    }
    assert.equal(Object.getOwnPropertyDescriptor(message, 'text')?.enumerable, true);
    for (const key of ['conversation', 'group', 'member'])
      assert.equal(Object.getOwnPropertyDescriptor(message, key)?.enumerable, false);
    assert.equal(Object.hasOwn(message, 'friend'), false);
    raw.sender.userId = '999';
    raw.elements.splice(0, raw.elements.length, segment.text('altered'));
    assert.equal(message.text, ' ping pong ');
    assert.equal(groupMessage.member.userId, '456');
    assert.strictEqual(aliases[0], message);
    assert.notStrictEqual(message.peer, raw.peer);
    raw.peer = { type: 'private', userId: '999' };
    assert.deepEqual(message.peer, { type: 'group', groupId: '789' });
    assert.equal(Object.hasOwn(raw, 'reply'), false);
    assert.deepEqual(await message.reply(['reply ', segment.face(14)], true), receipt);
    assert.deepEqual(
      worker.requests.map(({ id: _id, ...command }) => command),
      [
        {
          method: 'sendPrivateMessage',
          userId: '456',
          message: [{ type: 'text', text: 'direct' }],
        },
        {
          method: 'sendGroupMessage',
          groupId: '789',
          message: [
            { type: 'at', userId: '456' },
            { type: 'text', text: ' hello' },
          ],
        },
        {
          method: 'sendGroupMessage',
          groupId: '789',
          message: [
            { type: 'reply', messageId: '42' },
            { type: 'text', text: 'reply ' },
            { type: 'face', id: 14 },
          ],
        },
      ],
    );
    const groupReply = message;
    const beforeContacts = worker.requests.length;
    assert.deepEqual(await groupMessage.member.getInfo({ refresh: true }), memberInfo);
    await groupMessage.group.sendMessage('group action');
    await groupMessage.member.setCard('member action');
    const privateDto = {
      ...raw,
      peer: { type: 'private', userId: '654' },
      elements: [segment.text('private')],
    };
    worker.emit('message', { event: 'message', payload: privateDto });
    assert.ok(privateMessage);
    assert.strictEqual(privateMessage.conversation, privateMessage.friend);
    assert.equal(privateMessage.friend.userId, '654');
    assert.equal(privateMessage.text, 'private');
    assert.equal(Object.hasOwn(privateMessage, 'group'), false);
    assert.equal(Object.hasOwn(privateMessage, 'member'), false);
    privateDto.peer.userId = '999';
    await privateMessage.friend.sendMessage('private action');
    assert.deepEqual(
      worker.requests.slice(beforeContacts).map(({ id: _id, ...command }) => command),
      [
        { method: 'getGroupMember', groupId: '789', userId: '456', refresh: true },
        { method: 'sendGroupMessage', groupId: '789', message: [segment.text('group action')] },
        { method: 'setGroupMemberCard', groupId: '789', userId: '456', card: 'member action' },
        { method: 'sendPrivateMessage', userId: '654', message: [segment.text('private action')] },
      ],
    );
    const beforeInvalid = worker.requests.length;
    await assert.rejects(client.sendPrivateMessage('456', [segment.at('456'), 'invalid']));
    await assert.rejects(message.reply(segment.image('https://example.invalid/image.png')));
    assert.equal(worker.requests.length, beforeInvalid);
    /** @type {import('../../src/types.ts').DiagnosticInfo[]} */
    const diagnostics = [];
    client.on('diagnostic', (event) => diagnostics.push(event));
    worker.emit('message', {
      event: 'message',
      payload: { peer: { type: 'channel', secret: 'omit' } },
    });
    assert.deepEqual(diagnostics, [{ stage: 'invalid-worker-message-peer' }]);
    assert.equal(aliases.length, 1);

    /** @type {import('../../src/types.ts').FriendRequestEvent | undefined} */
    let friendRequest;
    /** @type {import('../../src/types.ts').GroupRequestEvent | undefined} */
    let groupRequest;
    client.once('request.friend', (event) => {
      friendRequest = event;
    });
    client.once('request.group', (event) => {
      groupRequest = event;
    });
    const friendDto = {
      uid: 'u_friend',
      time: '0007',
      nickname: 'friend',
      message: 'hi',
      decided: false,
      unread: true,
      initiator: false,
      raw: {},
    };
    const groupDto = {
      groupId: '789',
      sequence: '0008',
      type: 7,
      kind: 'join',
      doubt: false,
      status: 0,
      message: 'hi',
      raw: {},
    };
    worker.emit('message', { event: 'request.friend', payload: friendDto });
    worker.emit('message', { event: 'request.group', payload: groupDto });
    assert.ok(friendRequest);
    assert.ok(groupRequest);
    assert.equal(Object.hasOwn(friendDto, 'approve'), false);
    assert.equal(Object.hasOwn(groupDto, 'approve'), false);
    assert.equal(Object.getOwnPropertyDescriptor(friendRequest, 'approve')?.enumerable, false);
    assert.equal(
      Reflect.set(groupRequest, 'approve', () => {}),
      false,
    );
    friendRequest.uid = 'u_edited';
    groupRequest.groupId = '999';
    friendDto.time = '999';
    groupDto.sequence = '999';
    const beforeApproval = worker.requests.length;
    await friendRequest.approve();
    await groupRequest.approve(false, 'declined');
    assert.deepEqual(
      worker.requests.slice(beforeApproval).map(({ id: _id, ...command }) => command),
      [
        { method: 'handleFriendRequest', request: { uid: 'u_friend', time: '0007' }, accept: true },
        {
          method: 'handleGroupRequest',
          request: { groupId: '789', sequence: '0008', type: 7, doubt: false },
          accept: false,
          reason: 'declined',
        },
      ],
    );
    const beforeFailure = worker.requests.length;
    worker.failure = { message: 'controlled decision failure', code: 73 };
    await assert.rejects(friendRequest.approve(false), {
      message: 'controlled decision failure',
      code: 73,
    });
    assert.equal(worker.requests.length, beforeFailure + 1);
    worker.failure = undefined;
    for (const event of ['request.friend', 'request.group'])
      worker.emit('message', { event, payload: { raw: 'must not appear in diagnostics' } });
    assert.deepEqual(diagnostics.slice(1), [
      { stage: 'invalid-worker-friend-request' },
      { stage: 'invalid-worker-group-request' },
    ]);
    worker.emit('message', { event: 'disconnected', payload: { retryable: false } });
    worker.emit('message', { event: 'ready', payload: account });
    const beforeStale = worker.requests.length;
    await assert.rejects(friendRequest.approve(), /session|inactive/);
    await assert.rejects(groupRequest.approve(), /session|inactive/);
    await assert.rejects(groupReply.reply('stale'), /session|inactive/);
    await assert.rejects(groupMessage.group.sendMessage('stale'), /session|inactive/);
    await assert.rejects(groupMessage.member.setCard('stale'), /session|inactive/);
    await assert.rejects(groupMessage.member.getInfo(), /session|inactive/);
    await assert.rejects(privateMessage.friend.sendMessage('stale'), /session|inactive/);
    assert.equal(worker.requests.length, beforeStale);
    client.once('request.friend', (event) => {
      friendRequest = event;
    });
    worker.emit('message', { event: 'request.friend', payload: friendDto });
    const afterRestore = friendRequest;
    await client.close();
    await assert.rejects(afterRestore.approve(), /session|inactive/);
  } finally {
    worker.failure = undefined;
    await client.close();
  }
  return {
    installedMessageComposition: true,
    installedImmutableMessageRouting: true,
    installedRequestApprovalLifetime: true,
    installedMessageContacts: true,
    installedMessageMemberInfo: true,
    installedCapturedMessageText: true,
    ...(await verifyGroupAvatarClient(QQClient)),
  };
}

/** Exercise the same facade contract against source and packed implementations.
 * File validation in this layer captures a path; the controlled worker performs
 * no filesystem/native work and cannot prove profile support or remote effects.
 * @param {typeof import('../../src/index.ts').QQClient} QQClient */
async function verifyGroupAvatarClient(QQClient) {
  const worker = new ClientWorkerFixture();
  const client = new QQClient(worker, 500);
  const account = { uin: '123', uid: 'u_self' };
  const groupId = '00018446744073709551615';
  const file = join(tmpdir(), 'qq-native-avatar-consumer.png');
  try {
    worker.emit('message', { event: 'ready', payload: account });
    const group = client.pickGroup(groupId);
    assert.equal(Reflect.set(group, 'groupId', '999'), false);
    assert.equal(worker.requests.length, 0);
    assert.equal(await client.setGroupAvatar(groupId, file), undefined);
    assert.equal(await group.setAvatar(file), undefined);
    const command = { method: 'setGroupAvatar', groupId, file };
    assert.deepEqual(
      worker.requests.map(({ id: _id, ...request }) => request),
      [command, command],
    );

    const beforeInvalid = worker.requests.length;
    for (const invalidId of [
      '0',
      '-1',
      '1e3',
      ' 789',
      'u_group',
      '18446744073709551616',
      789,
      null,
      { toString: () => '789' },
    ]) {
      await assert.rejects(async () =>
        Reflect.apply(client.setGroupAvatar, client, [invalidId, file]),
      );
    }
    for (const invalidFile of [
      '',
      'relative.png',
      'https://example.invalid/avatar.png',
      `${file}\0suffix`,
      null,
      { toString: () => file },
    ]) {
      await assert.rejects(async () =>
        Reflect.apply(client.setGroupAvatar, client, [groupId, invalidFile]),
      );
      await assert.rejects(async () => Reflect.apply(group.setAvatar, group, [invalidFile]));
    }
    assert.equal(worker.requests.length, beforeInvalid);

    worker.failure = { message: 'controlled avatar failure', code: 73 };
    const beforeFailure = worker.requests.length;
    await assert.rejects(client.setGroupAvatar(groupId, file), {
      operation: 'setGroupAvatar',
      message: 'controlled avatar failure',
      code: 73,
    });
    await assert.rejects(group.setAvatar(file), {
      operation: 'setGroupAvatar',
      message: 'controlled avatar failure',
      code: 73,
    });
    assert.equal(worker.requests.length, beforeFailure + 2);
    worker.failure = undefined;

    worker.emit('message', { event: 'disconnected', payload: { retryable: false } });
    const beforeOffline = worker.requests.length;
    await assert.rejects(group.setAvatar(file), /session|inactive/);
    assert.equal(worker.requests.length, beforeOffline);
    worker.emit('message', { event: 'ready', payload: account });
    await assert.rejects(group.setAvatar(file), /session|inactive/);
    assert.equal(worker.requests.length, beforeOffline);
    const restoredGroup = client.pickGroup(groupId);
    await restoredGroup.setAvatar(file);
    assert.deepEqual(
      worker.requests.slice(beforeOffline).map(({ id: _id, ...request }) => request),
      [command],
    );
    await client.close();
    const afterClose = worker.requests.length;
    await assert.rejects(restoredGroup.setAvatar(file), /session|inactive|closed/);
    assert.equal(worker.requests.length, afterClose);
  } finally {
    worker.failure = undefined;
    await client.close();
  }
  return {
    installedGroupAvatarRouting: true,
    installedGroupAvatarValidation: true,
    installedGroupAvatarLifetime: true,
  };
}
