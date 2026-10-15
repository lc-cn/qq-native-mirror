import assert from 'node:assert/strict';
import { ClientWorkerFixture } from './client-worker-fixture.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';

const account = { uin: '123', uid: 'u_self' };
const receipt = { messageId: '99', sequence: '1', time: 1 };
const memberInfo = {
  userId: '456',
  uid: 'u_member',
  nickname: 'member',
  card: 'project admin',
  role: 'admin',
};

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
        : command.method === 'getGroupMember'
          ? command.userId === '999'
            ? undefined
            : { ...memberInfo }
          : command.method === 'getGroupMembers'
            ? [{ ...memberInfo }]
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
    const beforeMembers = worker.requests.length;
    const options = { refresh: true };
    const pendingMember = member.getInfo(options);
    options.refresh = false;
    assert.deepEqual(await pendingMember, memberInfo);
    assert.deepEqual(await client.getGroupMember('000789', '000456'), memberInfo);
    assert.equal(await client.getGroupMember('000789', '999'), undefined);
    assert.deepEqual(await group.getMembers({ refresh: true }), [memberInfo]);
    assert.deepEqual(await client.getGroupMembers('000789', { refresh: false }), [memberInfo]);
    assert.deepEqual(
      worker.requests.slice(beforeMembers).map(({ id: _id, ...command }) => command),
      [
        { method: 'getGroupMember', groupId: '000789', userId: '000456', refresh: true },
        { method: 'getGroupMember', groupId: '000789', userId: '000456' },
        { method: 'getGroupMember', groupId: '000789', userId: '999' },
        { method: 'getGroupMembers', groupId: '000789', refresh: true },
        { method: 'getGroupMembers', groupId: '000789', refresh: false },
      ],
    );
    const beforeInvalidMember = worker.requests.length;
    let refreshReads = 0;
    await assert.rejects(
      member.getInfo({
        get refresh() {
          refreshReads++;
          return true;
        },
      }),
    );
    await assert.rejects(client.getGroupMember('000789', 'u_member'));
    assert.equal(refreshReads, 0);
    assert.equal(worker.requests.length, beforeInvalidMember);
    worker.failure = { message: 'controlled contact failure', code: 73 };
    const beforeFailure = worker.requests.length;
    await assert.rejects(friend.setRemark('remark'), {
      message: 'controlled contact failure',
      code: 73,
    });
    assert.equal(worker.requests.length, beforeFailure + 1, 'failed mutations are not replayed');
    await assert.rejects(member.getInfo(), { message: 'controlled contact failure', code: 73 });
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
    await assert.rejects(member.getInfo(), /session|inactive/);
    await assert.rejects(group.getMembers({ refresh: true }), /session|inactive/);
    assert.equal(worker.requests.length, beforeRetired);
    const fresh = client.pickFriend('000456');
    assert.deepEqual(await fresh.sendMessage('fresh'), receipt);
    await client.close();
    await assert.rejects(fresh.getProfile(), /session|inactive/);
  } finally {
    await client.close();
  }
  const { prepareCommand } = await /** @type {Promise<typeof import('../../src/cli.ts')>} */ (
    import(pathToFileURL(join(packageRoot, 'dist/cli.js')).href)
  );
  const { runClientCommand } =
    await /** @type {Promise<typeof import('../../src/cli/client-command.ts')>} */ (
      import(pathToFileURL(join(packageRoot, 'dist/cli/client-command.js')).href)
    );
  return {
    installedContactObjects: true,
    installedContactReadiness: true,
    installedContactSessionLifetime: true,
    installedGroupMemberInfo: true,
    installedGroupMemberRefresh: true,
    ...(await verifyGroupMemberCliClient({ QQClient, prepareCommand, runClientCommand })),
  };
}

/** Exercise actual CLI rendering and shutdown with controlled authentication.
 * @param {{ QQClient: typeof import('../../src/index.ts').QQClient,
 * prepareCommand: typeof import('../../src/cli.ts').prepareCommand,
 * runClientCommand: typeof import('../../src/cli/client-command.ts').runClientCommand }} api
 */
export async function verifyGroupMemberCliClient({ QQClient, prepareCommand, runClientCommand }) {
  for (const fails of [false, true]) {
    const worker = new ClientWorkerFixture();
    const client = new QQClient(worker, 500);
    const signals = new EventEmitter();
    /** @type {string[]} */
    const output = [];
    try {
      worker.emit('message', { event: 'ready', payload: account });
      client.login = async () => account;
      const action = await prepareCommand('member-info', { 'group-id': '789', 'user-id': '456' });
      const pending = runClientCommand({
        client,
        command: 'member-info',
        action: async (client) => {
          if (fails) worker.failure = { code: 71, message: 'controlled member query failure' };
          try {
            return await action(client);
          } finally {
            worker.failure = undefined;
          }
        },
        login: { method: 'restore' },
        autoReconnect: false,
        qrPath: 'unused.png',
        writeQr: async () => assert.fail('No QR image is expected'),
        output: (line) => output.push(line),
        report: (line) => assert.fail(`Unexpected CLI report: ${line}`),
        signals,
        setExitCode: () => assert.fail('No signal is expected'),
      });
      if (fails) await assert.rejects(pending, { code: 71 });
      else await pending;
      assert.deepEqual(output, fails ? [] : ['null']);
      assert.equal(client.state, 'closed');
      assert.equal(worker.requests.filter((request) => request.method === 'close').length, 1);
      assert.equal(signals.listenerCount('SIGINT'), 0);
      assert.equal(signals.listenerCount('SIGTERM'), 0);
    } finally {
      worker.failure = undefined;
      await client.close();
    }
  }
  return { installedGroupMemberCliMissing: true };
}
