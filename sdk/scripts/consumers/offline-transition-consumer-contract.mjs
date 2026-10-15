import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ClientWorkerFixture } from './client-worker-fixture.mjs';

/** Verify public offline observers against the installed package. All worker
 * traffic is controlled; this never starts a process or accesses an account.
 * @param {string} packageRoot */
export async function verifyOfflineTransitionConsumer(packageRoot) {
  const api = await /** @type {Promise<typeof import('../../src/index.ts')>} */ (
    import(pathToFileURL(join(packageRoot, 'dist/index.js')).href)
  );
  return verifyOfflineTransitionClient(api);
}

/** @param {Pick<typeof import('../../src/index.ts'), 'QQClient'>} api */
export async function verifyOfflineTransitionClient(api) {
  for (const kind of /** @type {const} */ (['transport', 'forced']))
    for (const independentDisconnect of [false, true])
      await verifyTransition(api, kind, independentDisconnect);
  return {
    installedOfflineObserverRetirement: true,
    installedOfflineTransitionLogin: true,
    installedIndependentOfflineCancellation: true,
  };
}

/** Same-transition notifications carry a worker-owned envelope sequence, while
 * their public payloads remain unchanged. Replies run in the fixture microtask,
 * leaving the new login pending throughout the synchronous notification batch.
 * @param {Pick<typeof import('../../src/index.ts'), 'QQClient'>} api
 * @param {'transport' | 'forced'} kind
 * @param {boolean} independentDisconnect */
async function verifyTransition({ QQClient }, kind, independentDisconnect) {
  const worker = new ClientWorkerFixture();
  const client = new QQClient(worker, 500);
  const account = { uin: '123', uid: 'u_self' };
  worker.respond = ({ method }) => (method === 'login' ? account : undefined);
  /** @type {Promise<void>[]} */
  const rejectedActions = [];
  /** @type {Promise<{account: import('../../src/types.ts').Account} | {error: unknown}> | undefined} */
  let newLogin;
  /** @type {string[]} */
  const notifications = [];
  /** @type {import('../../src/types.ts').MessageEvent | undefined} */
  let message;
  try {
    worker.emit('message', { event: 'ready', payload: account });
    const friend = client.pickFriend('456');
    const group = client.pickGroup('789');
    client.once('message', (event) => {
      message = event;
    });
    worker.emit('message', {
      event: 'message',
      payload: {
        messageId: '99',
        sequence: '1',
        time: 1,
        peer: { type: 'group', groupId: '789' },
        sender: { userId: '456', uid: 'u_friend', nickname: 'friend' },
        elements: [{ type: 'text', text: 'fixture' }],
        raw: {},
      },
    });
    assert.ok(message);
    const received = message;
    for (const event of /** @type {const} */ (['offline', 'disconnected', 'kicked']))
      client.on(
        event,
        (/** @type {import('../../src/types.ts').OfflineInfo | undefined} */ info) => {
          assert.ok(info);
          assert.equal(Object.hasOwn(info, 'offlineTransition'), false);
          notifications.push(event);
        },
      );
    client.once('offline', () => {
      assert.equal(client.state, 'disconnected', 'retirement precedes the offline observer');
      assert.equal(client.account, undefined);
      assert.throws(() => client.pickFriend('456'), /session|inactive/);
      for (const pending of [
        friend.getProfile(),
        group.files.count(),
        group.notices.list(),
        group.essence.list(),
        received.reply('must not dispatch'),
      ])
        rejectedActions.push(assert.rejects(pending, /session|inactive/));
      assert.equal(worker.requests.length, 0, 'old capabilities cannot dispatch in the observer');
      newLogin = client.login({ method: 'quick', uin: account.uin }).then(
        (value) => ({ account: value }),
        (error) => ({ error }),
      );
    });
    const payload = {
      source: kind === 'forced' ? 'kicked' : 'login',
      kind,
      retryable: false,
      args: [],
    };
    const firstEvents =
      kind === 'forced' ? ['offline', 'disconnected', 'kicked'] : ['offline', 'disconnected'];
    for (const event of firstEvents)
      worker.emit('message', { event, offlineTransition: 1, payload: { ...payload } });
    assert.ok(newLogin);
    assert.equal(client.state, 'connecting', 'later notifications must preserve the new login');
    assert.equal(client.account, undefined);
    assert.deepEqual(notifications, firstEvents);
    assert.deepEqual(
      worker.requests.map(({ id: _id, ...command }) => command),
      [{ method: 'login', login: { method: 'quick', uin: account.uin } }],
    );

    if (independentDisconnect) {
      for (const event of ['offline', 'disconnected'])
        worker.emit('message', {
          event,
          offlineTransition: 2,
          payload: { source: 'login', kind: 'transport', retryable: false, args: [] },
        });
      const outcome = await newLogin;
      assert.ok('error' in outcome, 'a separate transition must cancel the pending login');
      assert.match(String(outcome.error), /offline/);
      assert.equal(client.state, 'disconnected');
      assert.equal(client.account, undefined);
      assert.deepEqual(notifications, [...firstEvents, 'offline', 'disconnected']);
    } else {
      const outcome = await newLogin;
      assert.ok('account' in outcome, 'same-transition aliases must not cancel the new login');
      assert.deepEqual(outcome.account, account);
      worker.emit('message', { event: 'ready', payload: account });
      assert.equal(client.state, 'online');
      assert.deepEqual(client.account, account);
      await assert.rejects(friend.getProfile(), /session|inactive/);
      await assert.rejects(received.reply('still retired'), /session|inactive/);
    }
    await Promise.all(rejectedActions);
    assert.equal(worker.requests.length, 1, 'retirement must not dispatch or retry operations');
  } finally {
    await Promise.allSettled(rejectedActions);
    await client.close();
    await newLogin;
  }
}
