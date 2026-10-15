import assert from 'node:assert/strict';
import test from 'node:test';
import { QQClient } from '../src/index.ts';
import { prepareCommand, validateCommandFlags } from '../src/cli/command-plan.ts';
import { ClientWorkerFixture } from '../scripts/consumers/client-worker-fixture.mjs';

test('profile-uid captures its selector and queries the public client only when executed', async (t) => {
  const worker = new ClientWorkerFixture();
  const client = new QQClient(worker, 500);
  t.after(() => client.close());
  worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_self' } });
  const profile = {
    userId: '0009007199254740993123',
    uid: 'opaque-uid',
    nickname: 'Applicant',
    remark: '',
    raw: {},
  };
  worker.respond = () => profile;
  const flags = { uid: 'opaque-uid' };
  validateCommandFlags('profile-uid', flags);
  const action = await prepareCommand('profile-uid', flags);
  flags.uid = 'u_changed';
  assert.equal(worker.requests.length, 0);
  assert.deepEqual(await action(client), profile);
  assert.deepEqual(
    worker.requests.map(({ id: _id, ...request }) => request),
    [{ method: 'getUserProfileByUid', uid: 'opaque-uid' }],
  );
});

test('profile-uid rejects missing or invalid UID and unrelated flags before execution', async () => {
  for (const uid of ['', '   ', ' u_user', 'u_user ', 'u_***'])
    await assert.rejects(prepareCommand('profile-uid', { uid }));
  await assert.rejects(prepareCommand('profile-uid', {}), /uid/);
  assert.throws(
    () => validateCommandFlags('profile-uid', { uid: 'u_user', target: '123' }),
    /Unknown option/,
  );
});
