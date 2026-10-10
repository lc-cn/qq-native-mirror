import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { QQClient } from '../src/index.ts';
import {
  parse,
  validateCommandFlags,
  prepareCommand,
  normalizeMessage,
} from '../src/cli/command-plan.ts';
test('parse consumes the original argument array including duplicate failure', () => {
  const args = ['send', '--text', 'fixture', '--help'];
  assert.deepEqual(parse(args), { command: 'send', flags: { text: 'fixture', help: 'true' } });
  assert.deepEqual(args, []);
  const bad = ['send', '--text', 'one', '--text', 'two'];
  assert.throws(() => parse(bad), /Duplicate option: --text/);
  assert.deepEqual(bad, []);
});
test('allowed flags reject before planning I/O and preserve command-specific errors', async () => {
  assert.throws(
    () => validateCommandFlags('send', { config: 'fixture', unknown: '1' }),
    /Unknown option for send: --unknown/,
  );
  assert.throws(() => validateCommandFlags('unknown', {}), /Unknown command: unknown/);
  validateCommandFlags('watch', { config: 'fixture', events: 'all' });
  await assert.rejects(
    prepareCommand('download', { kind: 'private', target: '123' }),
    /--message-id is required/,
  );
});
test('prepared mutation action performs no dispatch until called and snapshots flags including empty clear', async () => {
  const flags = { target: '123', remark: '' };
  const action = await prepareCommand('friend-remark', flags);
  flags.target = '456';
  flags.remark = 'changed';
  const calls: unknown[][] = [];
  const client = {
    setFriendRemark(...args: unknown[]) {
      calls.push(args);
      return Promise.resolve();
    },
  } as unknown as QQClient;
  assert.deepEqual(calls, []);
  await action(client);
  assert.deepEqual(calls, [['123', '']]);
});
test('batch query action preserves missing result as null and requested order', async () => {
  const action = await prepareCommand('messages', {
    kind: 'private',
    target: '123',
    'message-ids': '2,1',
  });
  const calls: unknown[][] = [];
  const client = {
    getMessages(...args: unknown[]) {
      calls.push(args);
      return Promise.resolve([undefined, { messageId: '1' }]);
    },
  } as unknown as QQClient;
  assert.deepEqual(await action(client), [null, { messageId: '1' }]);
  assert.deepEqual(calls, [[{ type: 'private', userId: '123' }, ['2', '1']]]);
  await assert.rejects(
    prepareCommand('messages', { kind: 'private', target: '123', 'message-ids': '1,1' }),
    /duplicate IDs/,
  );
});
test('message file is read during planning and remains independent of later file changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qq-command-plan-'));
  try {
    const file = join(dir, 'message.json');
    await writeFile(file, JSON.stringify([{ type: 'text', text: 'fixture' }]));
    const action = await prepareCommand('send', {
      kind: 'group',
      target: '123',
      'message-file': file,
    });
    await writeFile(file, 'malformed');
    let received: unknown;
    const client = {
      sendGroupMessage(_id: string, value: unknown) {
        received = value;
        return Promise.resolve({ messageId: '1' });
      },
    } as unknown as QQClient;
    await action(client);
    assert.deepEqual(received, [{ type: 'text', text: 'fixture' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('normalization preserves file resolution and rejects unsupported input before action', () => {
  assert.deepEqual(normalizeMessage([{ type: 'image', file: 'fixture.png' }]), [
    { type: 'image', file: resolve('fixture.png') },
  ]);
  assert.throws(() => normalizeMessage([{ type: 'unknown' }]), /Unsupported send element: unknown/);
  assert.throws(() => normalizeMessage(''), /must not be empty/);
});
