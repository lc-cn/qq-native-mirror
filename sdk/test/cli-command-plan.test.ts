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
test('inherited object names are neither commands nor duplicate options', async () => {
  for (const command of ['constructor', 'toString', '__proto__']) {
    assert.throws(() => validateCommandFlags(command, {}), /Unknown command/);
    await assert.rejects(prepareCommand(command, {}), /Unknown command/);
  }
  for (const flag of ['constructor', 'toString', '__proto__']) {
    const { flags } = parse(['contacts', `--${flag}`, 'fixture']);
    assert.equal(Object.getPrototypeOf(flags), Object.prototype);
    assert.equal(Object.hasOwn(flags, flag), true);
    assert.equal(flags[flag], 'fixture');
    assert.throws(() => validateCommandFlags('contacts', flags), /Unknown option for contacts/);
    assert.throws(
      () => parse(['contacts', `--${flag}`, 'one', `--${flag}`, 'two']),
      /Duplicate option/,
    );
  }
});
test('group request captures optional reason before execution', async () => {
  const flags = {
    'group-id': '123',
    sequence: '456',
    type: '1',
    accept: 'false',
    reason: 'original reason',
  };
  const action = await prepareCommand('group-request', flags);
  flags.reason = 'later change';
  const calls: unknown[][] = [];
  await action({
    handleGroupRequest(...args: unknown[]) {
      calls.push(args);
      return Promise.resolve();
    },
  } as unknown as QQClient);
  assert.deepEqual(calls, [
    [{ groupId: '123', sequence: '456', type: 1, doubt: false }, false, 'original reason'],
  ]);
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

test('group-search prepares uint64 identity before client and keeps original spelling', async () => {
  validateCommandFlags('group-search', { config: 'fixture', 'group-id': '00123' });
  await assert.rejects(
    prepareCommand('group-search', { 'group-id': '18446744073709551616' }),
    /uint64/,
  );
  const flags = { 'group-id': '00123' };
  const action = await prepareCommand('group-search', flags);
  flags['group-id'] = '999';
  let captured = '';
  assert.equal(
    await action({
      searchGroup: async (id: string) => {
        captured = id;
        return undefined;
      },
    } as QQClient),
    undefined,
  );
  assert.equal(captured, '00123');
});

test('folder creation captures its name and rejects invalid intent before client creation', async () => {
  validateCommandFlags('group-folder-create', {
    config: 'fixture',
    'group-id': '123',
    name: 'folder',
  });
  await assert.rejects(
    prepareCommand('group-folder-create', { 'group-id': '123', name: '  ' }),
    /nonblank/,
  );
  const flags = { 'group-id': '00123', name: ' 文件夹 ' };
  const action = await prepareCommand('group-folder-create', flags);
  flags.name = 'changed';
  const expected = { groupId: '123', folderId: 'native-id', parentFolderId: '', name: ' 文件夹 ' };
  const result = await action({
    createGroupFolder: async (groupId: string, name: string) => {
      assert.equal(groupId, '00123');
      assert.equal(name, ' 文件夹 ');
      return expected;
    },
  } as unknown as QQClient);
  assert.deepEqual(result, expected);
});

test('category assignment captures target and uint32 before client acquisition', async () => {
  validateCommandFlags('friend-category-set', {
    config: 'fixture',
    uin: '321',
    target: '00123',
    'category-id': '7',
  });
  for (const target of ['0', 'all', '*', ' 123'])
    await assert.rejects(prepareCommand('friend-category-set', { target, 'category-id': '7' }));
  for (const id of ['-1', '1.2', '1e2', '4294967296'])
    await assert.rejects(
      prepareCommand('friend-category-set', { target: '123', 'category-id': id }),
    );
  const flags = { target: '00123', 'category-id': '7' };
  const action = await prepareCommand('friend-category-set', flags);
  flags.target = '999';
  flags['category-id'] = '8';
  const calls: unknown[][] = [];
  await action({
    setFriendCategory: async (...args: unknown[]) => {
      calls.push(args);
    },
  } as unknown as QQClient);
  assert.deepEqual(calls, [['00123', 7]]);
});

test('group avatar CLI snapshots exact local-file intent before account acquisition', async () => {
  const file = resolve('avatar image.png');
  const flags = { 'group-id': '00123', file };
  const action = await prepareCommand('group-avatar', flags);
  flags['group-id'] = '999';
  flags.file = resolve('changed.png');
  const calls: unknown[][] = [];
  await action({
    setGroupAvatar: async (...args: unknown[]) => {
      calls.push(args);
    },
  } as unknown as QQClient);
  assert.deepEqual(calls, [['00123', file]]);
  await assert.rejects(prepareCommand('group-avatar', { 'group-id': '123' }), /--file is required/);
  await assert.rejects(
    prepareCommand('group-avatar', { 'group-id': '123', file: 'relative.png' }),
    /absolute/,
  );
  await assert.rejects(
    prepareCommand('group-avatar', { 'group-id': '18446744073709551616', file }),
    /uint64/,
  );
});
