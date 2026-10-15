import assert from 'node:assert/strict';
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
  worker.respond = (command) =>
    command.method === 'handleFriendRequest' || command.method === 'handleGroupRequest'
      ? undefined
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
    client.on('message', (event) => {
      message = event;
      assert.equal(Reflect.set(event, 'peer', { type: 'private', userId: '999' }), false);
      assert.equal(Reflect.set(event.peer, 'type', 'private'), false);
      assert.equal(Reflect.deleteProperty(event, 'peer'), false);
    });
    client.on('message.group', (event) => {
      assert.equal(event.peer.groupId, '789');
      aliases.push(event);
    });
    client.on('message.private', () => assert.fail('Unexpected private alias'));
    /** @type {import('../../src/types.ts').Message} */
    const raw = {
      messageId: '42',
      sequence: '1',
      time: 1,
      peer: { type: 'group', groupId: '789' },
      sender: { userId: '456', uid: 'u_friend', nickname: 'friend' },
      elements: [],
      raw: { retained: true },
    };
    worker.emit('message', { event: 'message', payload: raw });
    assert.ok(message);
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
    await assert.rejects(message.reply('stale'), /session|inactive/);
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
  };
}
