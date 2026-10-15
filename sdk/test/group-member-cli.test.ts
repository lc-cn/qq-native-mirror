import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QQClient } from '../src/index.ts';
import { prepareCommand, validateCommandFlags } from '../src/cli/command-plan.ts';
import { runClientCommand } from '../src/cli/client-command.ts';
import { ClientWorkerFixture } from '../scripts/consumers/client-worker-fixture.mjs';
import { verifyGroupMemberCliClient } from '../scripts/consumers/contact-objects-consumer-contract.mjs';

test('member CLI plans capture identities and explicit refresh through the public client', async (t) => {
  const worker = new ClientWorkerFixture();
  const client = new QQClient(worker, 500);
  t.after(() => client.close());
  worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_self' } });
  const member = { userId: '456', uid: 'u_member', nickname: 'member', card: '', role: 'member' };
  worker.respond = (command) => (command.method === 'getGroupMember' ? member : [member]);
  const flags = { 'group-id': '000789', 'user-id': '000456', refresh: 'true' };
  validateCommandFlags('member-info', flags);
  const action = await prepareCommand('member-info', flags);
  flags['group-id'] = '999';
  flags.refresh = 'false';
  assert.deepEqual(await action(client), member);
  for (const refresh of [undefined, 'false', 'true']) {
    const flags = { 'group-id': '000789', ...(refresh === undefined ? {} : { refresh }) };
    validateCommandFlags('members', flags);
    assert.deepEqual(await (await prepareCommand('members', flags))(client), [member]);
  }
  assert.deepEqual(
    worker.requests.map(({ id: _id, ...command }) => command),
    [
      { method: 'getGroupMember', groupId: '000789', userId: '000456', refresh: true },
      { method: 'getGroupMembers', groupId: '000789' },
      { method: 'getGroupMembers', groupId: '000789', refresh: false },
      { method: 'getGroupMembers', groupId: '000789', refresh: true },
    ],
  );
});

test('member CLI rejects invalid selectors and refresh while preparing the plan', async () => {
  for (const command of ['members', 'member-info']) {
    const flags = { 'group-id': '123', ...(command === 'member-info' ? { 'user-id': '456' } : {}) };
    await assert.rejects(prepareCommand(command, { ...flags, refresh: '1' }), /refresh/);
    await assert.rejects(prepareCommand(command, { ...flags, 'group-id': '000' }), /identifier/);
  }
  for (const userId of ['', '0', 'u_member', ' 456', '4e2'])
    await assert.rejects(prepareCommand('member-info', { 'group-id': '123', 'user-id': userId }));
});

test('missing member CLI prints null and closes; read failures do not print success', async () => {
  assert.deepEqual(
    await verifyGroupMemberCliClient({ QQClient, prepareCommand, runClientCommand }),
    {
      installedGroupMemberCliMissing: true,
    },
  );
});
