import assert from 'node:assert/strict';
import { ChildProcess, type Serializable } from 'node:child_process';
import test from 'node:test';
import { QQClient } from '../src/index.ts';
import { GroupEssence } from '../src/client/contacts/group-essence.ts';
import { GroupFiles } from '../src/client/contacts/group-files.ts';
import type { GroupContact } from '../src/client/contacts/group-contact.ts';
import type { GroupEssencePageOptions, GroupFilePageOptions } from '../src/types.ts';

const account = { uin: '123', uid: 'u_self' };
const groupId = '00018446744073709551615';

class Worker extends ChildProcess {
  readonly requests: Record<string, unknown>[] = [];
  result: unknown;
  failure?: { message: string; code: number };

  constructor() {
    super();
    Object.defineProperty(this, 'connected', { value: true, configurable: true });
  }

  override send(message: Serializable, ...args: unknown[]): boolean {
    if (!message || typeof message !== 'object') throw Error('Invalid fixture command');
    const command = message as Record<string, unknown>;
    this.requests.push(command);
    const callback = args.find((value) => typeof value === 'function');
    if (typeof callback === 'function') Reflect.apply(callback, undefined, [null]);
    queueMicrotask(() => {
      this.emit(
        'message',
        this.failure
          ? { id: command.id, error: this.failure }
          : {
              id: command.id,
              result:
                command.method === 'init'
                  ? { exports: [] }
                  : command.method === 'login'
                    ? account
                    : this.result,
            },
      );
      if (command.method === 'close') this.exit();
    });
    return true;
  }

  ready(value = account): void {
    this.emit('message', { event: 'ready', payload: value });
  }

  offline(): void {
    this.emit('message', {
      event: 'disconnected',
      payload: { source: 'login', kind: 'transport', retryable: false, args: [] },
    });
  }

  exit(): void {
    Object.defineProperty(this, 'connected', { value: false, configurable: true });
    Object.defineProperty(this, 'exitCode', { value: 0, configurable: true });
    this.emit('exit', 0, null);
  }

  override kill(): boolean {
    this.exit();
    return true;
  }
}

function fixture() {
  const worker = new Worker();
  const next = new Worker();
  const client = new QQClient(
    worker,
    500,
    { method: 'quick', uin: account.uin },
    { spawn: () => next, payload: {} },
    false,
  );
  worker.ready();
  return { client, worker, next, group: client.pickGroup(groupId) };
}

function commands(worker: Worker) {
  return worker.requests.map(({ id: _id, ...command }) => command);
}

function actions(group: GroupContact): (() => Promise<unknown>)[] {
  return [
    () => group.files.count(),
    () => group.files.getPage(),
    () => group.files.list(),
    () => group.files.createFolder('folder'),
    () => group.files.deleteFolder('folder-id'),
    () => group.files.deleteFile('file-id'),
    () => group.essence.getPage(),
    () => group.essence.list(),
    () => group.essence.set('99', true),
    () => group.listMutedMembers(),
  ];
}

test('group resource selection is local and retains immutable child objects and routing', async (t) => {
  const { client, worker, group } = fixture();
  t.after(() => client.close());
  assert.ok(group.files instanceof GroupFiles);
  assert.ok(group.essence instanceof GroupEssence);
  assert.equal(group.files.groupId, groupId);
  assert.equal(group.essence.groupId, groupId);
  assert.equal(Object.isFrozen(group.files), true);
  assert.equal(Object.isFrozen(group.essence), true);
  assert.equal(Reflect.set(group, 'files', {}), false);
  assert.equal(Reflect.set(group, 'essence', {}), false);
  assert.equal(Reflect.set(group.files, 'groupId', '999'), false);
  assert.equal(Reflect.set(group.essence, 'groupId', '999'), false);
  assert.equal(
    Reflect.set(group.files, 'count', () => 1),
    false,
  );
  assert.equal(worker.requests.length, 0);
});

test('group file methods capture existing defaults and preserve native results and opaque identities', async (t) => {
  const { client, worker, group } = fixture();
  t.after(() => client.close());
  worker.result = 17;
  assert.equal(await group.files.count(), 17);
  const page = {
    groupId,
    startIndex: 0,
    fileCount: 50,
    items: [],
    isEnd: true,
    nextIndex: 0,
    allFileCount: 0,
  };
  worker.result = page;
  assert.equal(await group.files.getPage(), page);
  const options = {
    folderId: '/opaque-folder',
    sortType: -1,
    fileCount: 3,
    startIndex: 7,
    sortOrder: 4,
    showOnlinedocFolder: 1,
  };
  const pending = group.files.getPage(options);
  options.folderId = '/changed';
  options.startIndex = 999;
  assert.equal(await pending, page);
  const items: unknown[] = [];
  worker.result = items;
  assert.equal(await group.files.list(), items);
  assert.equal(
    await group.files.list({ folderId: '/opaque-folder', fileCount: 2, maxPages: 4 }),
    items,
  );
  const folder = { groupId, folderId: '/created', parentFolderId: '/', name: ' name ' };
  worker.result = folder;
  assert.equal(await group.files.createFolder(' name '), folder);
  worker.result = undefined;
  await group.files.deleteFolder('/opaque-folder');
  await group.files.deleteFile('file:opaque/001');
  assert.deepEqual(commands(worker), [
    { method: 'getGroupFileCount', groupId },
    {
      method: 'getGroupFilePage',
      groupId,
      options: {
        sortType: 1,
        fileCount: 50,
        startIndex: 0,
        sortOrder: 2,
        showOnlinedocFolder: 0,
      },
    },
    {
      method: 'getGroupFilePage',
      groupId,
      options: {
        folderId: '/opaque-folder',
        sortType: -1,
        fileCount: 3,
        startIndex: 7,
        sortOrder: 4,
        showOnlinedocFolder: 1,
      },
    },
    {
      method: 'listGroupFiles',
      groupId,
      options: {
        sortType: 1,
        fileCount: 50,
        sortOrder: 2,
        showOnlinedocFolder: 0,
        maxPages: 20,
      },
    },
    {
      method: 'listGroupFiles',
      groupId,
      options: {
        folderId: '/opaque-folder',
        sortType: 1,
        fileCount: 2,
        sortOrder: 2,
        showOnlinedocFolder: 0,
        maxPages: 4,
      },
    },
    { method: 'createGroupFolder', groupId, name: ' name ' },
    { method: 'deleteGroupFolder', groupId, folderId: '/opaque-folder' },
    { method: 'deleteGroupFile', groupId, fileId: 'file:opaque/001' },
  ]);
});

test('essence and mute reads retain existing DTOs while mutations use the exact kernel message ID', async (t) => {
  const { client, worker, group } = fixture();
  t.after(() => client.close());
  const page = { groupId, pageStart: 0, pageLimit: 50, messages: [], isEnd: true, groupRole: 1 };
  worker.result = page;
  assert.equal(await group.essence.getPage(), page);
  const options = { pageStart: 9, pageLimit: 10 };
  const pending = group.essence.getPage(options);
  options.pageStart = 999;
  assert.equal(await pending, page);
  const messages: unknown[] = [];
  worker.result = messages;
  assert.equal(await group.essence.list(), messages);
  assert.equal(await group.essence.list({ maxPages: 7 }), messages);
  const muted = [
    { uid: 'u_member', userId: '456', nickname: '', card: '', role: 'member', shutUpTime: 42 },
  ];
  worker.result = muted;
  assert.equal(await group.listMutedMembers(), muted);
  worker.result = undefined;
  const messageId = '000900719925474099312345';
  await group.essence.set(messageId, true);
  await group.essence.set(messageId, false);
  assert.deepEqual(commands(worker), [
    { method: 'getGroupEssencePage', groupId, options: { pageStart: 0, pageLimit: 50 } },
    { method: 'getGroupEssencePage', groupId, options: { pageStart: 9, pageLimit: 10 } },
    { method: 'listGroupEssenceMessages', groupId, options: { maxPages: 20 } },
    { method: 'listGroupEssenceMessages', groupId, options: { maxPages: 7 } },
    { method: 'listGroupMutedMembers', groupId },
    { method: 'setGroupEssenceMessage', groupId, messageId, enabled: true },
    { method: 'setGroupEssenceMessage', groupId, messageId, enabled: false },
  ]);
});

test('resource input failures are asynchronous and occur before IPC without evaluating getters', async (t) => {
  const { client, worker, group } = fixture();
  t.after(() => client.close());
  for (const invoke of [
    () => group.files.getPage({ fileCount: 0 }),
    () => group.files.list({ maxPages: 0 }),
    () => group.files.createFolder(' '),
    () => group.files.deleteFolder(''),
    () => group.files.deleteFile(''),
    () => group.essence.getPage({ pageLimit: 51 }),
    () => group.essence.list({ maxPages: 0 }),
    () => group.essence.set('bad', true),
    () => group.essence.set('99', 1 as unknown as boolean),
  ])
    await assert.rejects(invoke());
  let getterReads = 0;
  await assert.rejects(
    group.files.getPage({
      get fileCount() {
        getterReads++;
        return 10;
      },
    }),
  );
  await assert.rejects(
    group.essence.getPage({
      get pageLimit() {
        getterReads++;
        return 10;
      },
    }),
  );
  assert.equal(getterReads, 0);
  const outOfRange = client.pickGroup('18446744073709551616');
  await assert.rejects(outOfRange.files.count(), /uint64/);
  await assert.rejects(outOfRange.essence.set('99', true), /uint64/);
  const original = Error('fixture descriptor failure');
  await assert.rejects(
    group.files.list(
      new Proxy(
        {},
        {
          ownKeys() {
            throw original;
          },
        },
      ),
    ),
    (error) => error === original,
  );
  assert.equal(worker.requests.length, 0);
});

for (const resource of ['file page', 'file list', 'essence page', 'essence list'] as const) {
  test(`${resource} rechecks the captured session after caller descriptor traps`, async (t) => {
    const { client, worker, group } = fixture();
    t.after(() => client.close());
    const options = new Proxy(
      { maxPages: 3, pageLimit: 3, fileCount: 3 },
      {
        ownKeys(target) {
          return Reflect.ownKeys(target).filter(
            (key) => key === 'fileCount' || (key === 'maxPages' && resource === 'file list'),
          );
        },
        getOwnPropertyDescriptor(target, key) {
          worker.offline();
          worker.ready({ uin: '987', uid: 'u_other' });
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const operation =
      resource === 'file page'
        ? group.files.getPage(options)
        : resource === 'file list'
          ? group.files.list(options)
          : resource === 'essence page'
            ? group.essence.getPage(options)
            : group.essence.list(options);
    await assert.rejects(operation, /inactive|session/);
    assert.equal(client.state, 'online');
    assert.equal(client.account?.uin, '987');
    assert.equal(worker.requests.length, 0);
  });
}

test('all group resources retire on offline, account change, replacement and close', async (t) => {
  const { client, worker, next, group } = fixture();
  t.after(() => client.close());
  worker.offline();
  for (const invoke of actions(group)) await assert.rejects(invoke(), /inactive|session/);
  const trap = () =>
    assert.fail('retired resources must check the session before inspecting options');
  await assert.rejects(
    group.files.getPage(new Proxy({} as GroupFilePageOptions, { ownKeys: trap })),
    /inactive|session/,
  );
  await assert.rejects(
    group.essence.getPage(
      new Proxy({} as GroupEssencePageOptions, { getOwnPropertyDescriptor: trap }),
    ),
    /inactive|session/,
  );
  worker.ready();
  for (const invoke of actions(group)) await assert.rejects(invoke(), /inactive|session/);
  const previousAccount = client.pickGroup(groupId);
  worker.ready({ uin: '987', uid: 'u_other' });
  for (const invoke of actions(previousAccount)) await assert.rejects(invoke(), /inactive|session/);
  assert.equal(worker.requests.length, 0);
  const previousWorker = client.pickGroup(groupId);
  await client.reconnect({ method: 'quick', uin: account.uin });
  next.ready();
  const afterReconnect = next.requests.length;
  for (const invoke of actions(previousWorker)) await assert.rejects(invoke(), /inactive|session/);
  assert.equal(next.requests.length, afterReconnect);
  const current = client.pickGroup(groupId);
  await current.files.count();
  await current.essence.list();
  await client.close();
  const afterClose = next.requests.length;
  for (const invoke of actions(current)) await assert.rejects(invoke(), /inactive|session/);
  assert.equal(next.requests.length, afterClose);
});

test('resource failures propagate without replaying mutations or returning fallback reads', async (t) => {
  const { client, worker, group } = fixture();
  t.after(async () => {
    worker.failure = undefined;
    await client.close();
  });
  worker.failure = { message: 'fixture effect unknown', code: 503 };
  for (const invoke of actions(group)) {
    const before = worker.requests.length;
    await assert.rejects(invoke(), /fixture effect unknown/);
    assert.equal(worker.requests.length, before + 1);
  }
});
