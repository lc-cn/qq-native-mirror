import assert from 'node:assert/strict';
import test from 'node:test';
import { QQClient, type UserProfile } from '../src/index.ts';
import { isServiceOperation } from '../src/runtime/operations.ts';
import { ClientWorkerFixture } from '../scripts/consumers/client-worker-fixture.mjs';

const account = { uin: '123', uid: 'u_self' };
const profile: UserProfile = {
  userId: '0009007199254740993',
  uid: 'opaque-uid',
  nickname: 'name',
  remark: '',
  raw: { coreInfo: { uid: 'opaque-uid', uin: '0009007199254740993' } },
};
function fixture(online = true) {
  const worker = new ClientWorkerFixture();
  const client = new QQClient(worker, 500, { method: 'quick', uin: account.uin }, undefined, false);
  worker.respond = (command) => (command.method === 'getUserProfileByUid' ? profile : undefined);
  const ready = (value = account) => worker.emit('message', { event: 'ready', payload: value });
  const offline = () =>
    worker.emit('message', {
      event: 'disconnected',
      payload: { kind: 'transport', retryable: false },
    });
  if (online) ready();
  return { client, worker, ready, offline };
}

test('public UID profile query uses its explicit operation and preserves the profile DTO', async (t) => {
  const f = fixture();
  t.after(() => f.client.close());
  const result: UserProfile = await f.client.getUserProfileByUid(profile.uid);
  assert.deepEqual(result, profile);
  assert.equal(isServiceOperation('getUserProfileByUid'), true);
  assert.deepEqual(
    f.worker.requests.map(({ id: _id, ...command }) => command),
    [{ method: 'getUserProfileByUid', uid: 'opaque-uid' }],
  );
});

test('UID profile preflight rejects invalid or offline inputs without coercion or IPC', async (t) => {
  const f = fixture(false);
  t.after(() => f.client.close());
  await assert.rejects(f.client.getUserProfileByUid(profile.uid), /session|inactive/);
  f.ready();
  for (const uid of ['', ' ', ' u_user', 'u_user ', 'u_masked*'])
    await assert.rejects(f.client.getUserProfileByUid(uid), /uid/);
  await assert.rejects(
    Reflect.apply(f.client.getUserProfileByUid, f.client, [
      {
        toString: () => assert.fail('UID was coerced'),
      },
    ]),
  );
  assert.equal(f.worker.requests.length, 0);
});

test('duplicate ready preserves pending profile reads in the same authorization', async (t) => {
  const f = fixture();
  t.after(() => f.client.close());
  const pending = f.client.getUserProfileByUid(profile.uid);
  f.ready({ ...account });
  assert.deepEqual(await pending, profile);
  assert.equal(f.worker.requests.length, 1);
});

test('a resolved worker profile cannot escape retirement before its public continuation', async (t) => {
  for (const retirement of ['offline', 'replacement', 'close'] as const) {
    const f = fixture();
    t.after(() => f.client.close());
    let closed: Promise<void> | undefined;
    f.worker.respond = (command) => {
      if (command.method !== 'getUserProfileByUid') return undefined;
      // The fixture emits the successful reply immediately after respond returns.
      // This retirement then runs before the awaiting public method can publish it.
      queueMicrotask(() => {
        if (retirement === 'close') closed = f.client.close();
        else {
          f.offline();
          if (retirement === 'replacement') f.ready({ uin: '456', uid: 'u_next' });
        }
      });
      return profile;
    };
    await assert.rejects(f.client.getUserProfileByUid(profile.uid), /inactive or replaced/);
    await closed;
    assert.equal(
      f.worker.requests.filter((command) => command.method === 'getUserProfileByUid').length,
      1,
    );
  }
});

test('profile failures retain the original worker error code and are not retried', async (t) => {
  const f = fixture();
  t.after(() => f.client.close());
  f.worker.failure = { message: 'Native profile unavailable', code: 17 };
  await assert.rejects(f.client.getUserProfileByUid(profile.uid), {
    message: 'Native profile unavailable',
    code: 17,
  });
  f.worker.failure = undefined;
  assert.equal(f.worker.requests.length, 1);
  f.offline();
  f.ready({ uin: '456', uid: 'u_next' });
  assert.deepEqual(await f.client.getUserProfileByUid(profile.uid), profile);
  assert.equal(
    f.worker.requests.length,
    2,
    'Passive UIDs may be explicitly queried in a new session',
  );
});
