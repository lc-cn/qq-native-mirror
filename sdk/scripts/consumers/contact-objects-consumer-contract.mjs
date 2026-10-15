import assert from 'node:assert/strict';
import { ClientWorkerFixture } from './client-worker-fixture.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const account = { uin: '123', uid: 'u_self' };
const receipt = { messageId: '99', sequence: '1', time: 1 };

/** Exercise only public entry exports across installed client, operation and
 * lifecycle modules. Selection is local; actions preserve their original route.
 * @param {string} packageRoot */
export async function verifyContactObjectsConsumer(packageRoot) {
  const { QQClient, FriendContact, GroupContact, GroupMemberContact } =
    await /** @type {Promise<typeof import('../../src/index.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/index.js')).href)
    );
  const worker = new ClientWorkerFixture();
  worker.respond = (command) =>
    command.method === 'listFriends'
      ? []
      : command.method === 'getMessages'
        ? [undefined]
        : receipt;
  const client = new QQClient(worker, 500);
  try {
    assert.throws(() => client.pickFriend('456'), /session|inactive/);
    /** @type {import('../../src/index.ts').FriendContact | undefined} */
    let selectedAtLogin;
    /** @type {Promise<import('../../src/types.ts').Friend[]> | undefined} */
    let readyQuery;
    client.once('login', () => {
      assert.equal(client.state, 'online');
      assert.deepEqual(client.account, account);
      selectedAtLogin = client.pickFriend('000456');
      readyQuery = client.listFriends();
    });
    worker.emit('message', { event: 'login', payload: account });
    worker.emit('message', { event: 'ready', payload: { ...account } });
    assert.ok(selectedAtLogin);
    assert.deepEqual(await readyQuery, []);
    const friend = selectedAtLogin;
    const beforeSelection = worker.requests.length;
    const group = client.pickGroup('000789');
    const member = group.pickMember('000456');
    assert.ok(friend instanceof FriendContact);
    assert.ok(group instanceof GroupContact);
    assert.ok(member instanceof GroupMemberContact);
    assert.equal(worker.requests.length, beforeSelection);
    assert.equal(Reflect.set(friend, 'userId', '999'), false);
    assert.equal(Reflect.set(group.peer, 'groupId', '999'), false);
    assert.equal(Reflect.set(member, 'groupId', '999'), false);
    assert.deepEqual(await friend.sendMessage('private'), receipt);
    assert.deepEqual(await group.sendMessage('group'), receipt);
    await member.setCard('card');
    assert.deepEqual(await friend.getMessages(['99']), [undefined]);
    assert.deepEqual(
      worker.requests.slice(beforeSelection).map(({ id: _id, ...command }) => command),
      [
        {
          method: 'sendPrivateMessage',
          userId: '000456',
          message: [{ type: 'text', text: 'private' }],
        },
        {
          method: 'sendGroupMessage',
          groupId: '000789',
          message: [{ type: 'text', text: 'group' }],
        },
        { method: 'setGroupMemberCard', groupId: '000789', userId: '000456', card: 'card' },
        { method: 'getMessages', peer: { type: 'private', userId: '000456' }, messageIds: ['99'] },
      ],
    );
    worker.failure = { message: 'controlled contact failure', code: 73 };
    const beforeFailure = worker.requests.length;
    await assert.rejects(friend.setRemark('remark'), {
      message: 'controlled contact failure',
      code: 73,
    });
    assert.equal(worker.requests.length, beforeFailure + 1, 'failed mutations are not replayed');
    worker.failure = undefined;

    worker.emit('message', {
      event: 'disconnected',
      payload: { source: 'login', kind: 'transport', retryable: false, args: [] },
    });
    worker.emit('message', { event: 'login', payload: { ...account } });
    const beforeRetired = worker.requests.length;
    await assert.rejects(friend.sendMessage('stale'), /session|inactive/);
    await assert.rejects(group.getHistory(), /session|inactive/);
    await assert.rejects(member.mute(0), /session|inactive/);
    assert.equal(worker.requests.length, beforeRetired);
    const fresh = client.pickFriend('000456');
    assert.deepEqual(await fresh.sendMessage('fresh'), receipt);
    await client.close();
    await assert.rejects(fresh.getProfile(), /session|inactive/);
  } finally {
    await client.close();
  }
  return {
    installedContactObjects: true,
    installedContactReadiness: true,
    installedContactSessionLifetime: true,
  };
}
