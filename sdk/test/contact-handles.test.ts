import assert from 'node:assert/strict';
import { ChildProcess, type Serializable } from 'node:child_process';
import test from 'node:test';
import { FriendContact, GroupContact, GroupMemberContact, QQClient } from '../src/index.ts';
import type { Message, MessageInput } from '../src/types.ts';

const account = { uin: '123', uid: 'u_self' };
const receipt = { messageId: '99', sequence: '1', time: 1 };

class Worker extends ChildProcess {
  readonly requests: Record<string, unknown>[] = [];
  result: unknown = receipt;
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

function fixture(online = true) {
  const worker = new Worker();
  const next = new Worker();
  const client = new QQClient(
    worker,
    500,
    { method: 'quick', uin: account.uin },
    { spawn: () => next, payload: {} },
    false,
  );
  if (online) worker.ready();
  return { client, worker, next };
}

function commands(worker: Worker) {
  return worker.requests.map(({ id: _id, ...command }) => command);
}

test('selection is local, validates positive decimal identities, and preserves immutable routing', async (t) => {
  const { client, worker } = fixture();
  t.after(() => client.close());
  const friend = client.pickFriend('000456');
  const group = client.pickGroup('000789');
  const member = group.pickMember('000456');
  assert.ok(friend instanceof FriendContact);
  assert.ok(group instanceof GroupContact);
  assert.ok(member instanceof GroupMemberContact);
  assert.equal(friend.peer.userId, '000456');
  assert.equal(group.peer.groupId, '000789');
  assert.equal(member.groupId, group.groupId);
  assert.equal(member.userId, friend.userId);
  assert.deepEqual(worker.requests, []);
  assert.equal(Reflect.set(friend, 'userId', '999'), false);
  assert.equal(Reflect.set(group, 'groupId', '999'), false);
  assert.equal(Reflect.set(member, 'userId', '999'), false);
  assert.equal(Reflect.set(member, 'groupId', '999'), false);
  assert.equal(Reflect.set(friend.peer, 'userId', '999'), false);
  assert.equal(Reflect.set(group.peer, 'groupId', '999'), false);
  assert.equal(Reflect.set(friend, 'peer', { type: 'private', userId: '999' }), false);
  for (const value of ['', '0', '000', '-1', '1.2', 'u_uid', ' 123']) {
    assert.throws(() => client.pickFriend(value));
    assert.throws(() => client.pickGroup(value));
    assert.throws(() => client.pickMember('789', value));
    assert.throws(() => client.pickMember(value, '456'));
    assert.throws(() => group.pickMember(value));
  }
  await friend.sendMessage('private');
  await group.sendMessage('group');
  await member.setCard('card');
  assert.deepEqual(commands(worker), [
    {
      method: 'sendPrivateMessage',
      userId: '000456',
      message: [{ type: 'text', text: 'private' }],
    },
    { method: 'sendGroupMessage', groupId: '000789', message: [{ type: 'text', text: 'group' }] },
    { method: 'setGroupMemberCard', groupId: '000789', userId: '000456', card: 'card' },
  ]);
});

test('conversation reads and recall capture the selected peer and preserve results', async (t) => {
  const { client, worker } = fixture();
  t.after(() => client.close());
  const friend = client.pickFriend('456');
  const group = client.pickGroup('789');
  const item: Message = {
    ...receipt,
    peer: { type: 'private', userId: '456' },
    sender: { userId: '456', uid: 'u_friend', nickname: 'friend' },
    elements: [{ type: 'text', text: 'received' }],
    raw: {},
  };
  worker.result = [item];
  assert.deepEqual(await friend.getHistory({ before: '0099', limit: 5 }), [item]);
  worker.result = item;
  assert.equal(await group.getMessage('0099'), item);
  worker.result = [item, undefined];
  assert.deepEqual(await friend.getMessages(['0099', '100']), [item, undefined]);
  worker.result = undefined;
  assert.equal(await group.getMessage('101'), undefined);
  await group.recallMessage('0099');
  assert.deepEqual(commands(worker), [
    {
      method: 'getHistory',
      peer: { type: 'private', userId: '456' },
      options: { before: '0099', limit: 5, reverse: false },
    },
    { method: 'getMessage', peer: { type: 'group', groupId: '789' }, messageId: '0099' },
    {
      method: 'getMessages',
      peer: { type: 'private', userId: '456' },
      messageIds: ['0099', '100'],
    },
    { method: 'getMessage', peer: { type: 'group', groupId: '789' }, messageId: '101' },
    { method: 'recallMessage', peer: { type: 'group', groupId: '789' }, messageId: '0099' },
  ]);
});

test('friend, group and member actions reuse the existing operation payloads and defaults', async (t) => {
  const { client, worker } = fixture();
  t.after(() => client.close());
  const friend = client.pickFriend('456');
  const group = client.pickGroup('789');
  const member = client.pickMember('789', '456');
  await friend.getProfile();
  await friend.setRemark('friend remark');
  await friend.setCategory(5);
  await friend.delete();
  await group.getInfo();
  await group.getMembers();
  await group.setName('group name');
  await group.setRemark('group remark');
  await group.mute(true);
  await group.leave();
  await member.getProfile();
  await member.setCard('member card');
  await member.setAdmin(false);
  await member.mute(0);
  await member.kick();
  assert.deepEqual(commands(worker), [
    { method: 'getUserProfile', userId: '456' },
    { method: 'setFriendRemark', userId: '456', remark: 'friend remark' },
    { method: 'setFriendCategory', userId: '456', categoryId: 5 },
    { method: 'deleteFriend', userId: '456', options: { block: false, both: false } },
    { method: 'getGroupInfo', groupId: '789' },
    { method: 'getGroupMembers', groupId: '789' },
    { method: 'setGroupName', groupId: '789', name: 'group name' },
    { method: 'setGroupRemark', groupId: '789', remark: 'group remark' },
    { method: 'setGroupMute', groupId: '789', enabled: true },
    { method: 'leaveGroup', groupId: '789' },
    { method: 'getUserProfile', userId: '456' },
    { method: 'setGroupMemberCard', groupId: '789', userId: '456', card: 'member card' },
    { method: 'setGroupAdmin', groupId: '789', userId: '456', enabled: false },
    { method: 'setGroupMemberMute', groupId: '789', userId: '456', seconds: 0 },
    {
      method: 'kickGroupMember',
      groupId: '789',
      userId: '456',
      options: { rejectRejoin: false, reason: '' },
    },
  ]);
});

test('selection requires online; handles stay retired after offline, replacement and close', async (t) => {
  const { client, worker, next } = fixture(false);
  t.after(() => client.close());
  assert.throws(() => client.pickFriend('456'), /inactive|session/);
  assert.throws(() => client.pickGroup('789'), /inactive|session/);
  assert.throws(() => client.pickMember('789', '456'), /inactive|session/);
  worker.ready();
  const friend = client.pickFriend('456');
  const group = client.pickGroup('789');
  const member = group.pickMember('456');
  worker.offline();
  await assert.rejects(friend.sendMessage('stale'), /inactive|session/);
  await assert.rejects(group.getInfo(), /inactive|session/);
  await assert.rejects(member.mute(10), /inactive|session/);
  assert.throws(() => group.pickMember('456'), /inactive|session/);
  worker.ready();
  await assert.rejects(friend.getHistory(), /inactive|session/);
  assert.deepEqual(worker.requests, []);
  const beforeReconnect = client.pickGroup('789');
  await client.reconnect({ method: 'quick', uin: account.uin });
  next.ready();
  await assert.rejects(beforeReconnect.sendMessage('stale'), /inactive|session/);
  const current = client.pickFriend('456');
  await current.sendMessage('current');
  const sends = next.requests.filter(({ method }) => method === 'sendPrivateMessage');
  assert.equal(sends.length, 1);
  await client.close();
  await assert.rejects(current.getProfile(), /inactive|session/);
  assert.throws(() => client.pickGroup('789'), /inactive|session/);
});

test('reentrant getters cannot dispatch old contact actions into a replacement authorization', async (t) => {
  const { client, worker } = fixture();
  t.after(() => client.close());
  const friend = client.pickFriend('456');
  const input = {
    get block() {
      worker.offline();
      worker.ready({ uin: '987', uid: 'u_other' });
      return true;
    },
  };
  await assert.rejects(friend.delete(input), /inactive|session/);
  assert.equal(client.state, 'online');
  assert.equal(client.account?.uin, '987');
  assert.deepEqual(worker.requests, []);

  const group = client.pickGroup('789');
  const content: MessageInput = [
    new Proxy({ type: 'text', text: 'never dispatched' } as const, {
      getOwnPropertyDescriptor(target, key) {
        worker.offline();
        worker.ready({ uin: '987', uid: 'u_other' });
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    }),
  ];
  await assert.rejects(group.sendMessage(content), /inactive|session/);
  assert.deepEqual(worker.requests, []);
});

test('invalid captured inputs reject before IPC and original input exceptions propagate', async (t) => {
  const { client, worker } = fixture();
  t.after(() => client.close());
  const friend = client.pickFriend('456');
  const group = client.pickGroup('789');
  const member = group.pickMember('456');
  await assert.rejects(friend.sendMessage([{ type: 'at', userId: '123' }]));
  await assert.rejects(group.getHistory({ limit: 101 }));
  await assert.rejects(friend.getMessages(['1', '1']));
  await assert.rejects(group.recallMessage('bad'));
  await assert.rejects(friend.setCategory(-1));
  await assert.rejects(group.setName(' '));
  await assert.rejects(member.mute(-1));
  const original = Error('original option getter');
  await assert.rejects(
    member.kick({
      get rejectRejoin(): boolean {
        throw original;
      },
    }),
    (error) => error === original,
  );
  assert.deepEqual(worker.requests, []);
});

test('worker operation failures are returned once without contact retries', async (t) => {
  const { client, worker } = fixture();
  t.after(async () => {
    worker.failure = undefined;
    await client.close();
  });
  worker.failure = { message: 'fixture permission denied', code: 403 };
  await assert.rejects(client.pickFriend('456').sendMessage('denied'), /fixture permission denied/);
  assert.equal(worker.requests.length, 1);
  assert.equal(worker.requests[0]?.method, 'sendPrivateMessage');
});
