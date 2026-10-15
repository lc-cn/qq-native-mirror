import assert from 'node:assert/strict';
import { ChildProcess, type Serializable } from 'node:child_process';
import test from 'node:test';
import { QQClient } from '../src/index.ts';
import { createMessageEvent } from '../src/client/message-event.ts';
import type { Message, MessageEvent, MessageInput } from '../src/types.ts';
import type { ContactContext } from '../src/client/contacts/contact-context.ts';
import type { OperationCall } from '../src/runtime/operation-contracts.ts';
import { FriendContact } from '../src/client/contacts/friend-contact.ts';
import { GroupContact } from '../src/client/contacts/group-contact.ts';
import { GroupMemberContact } from '../src/client/contacts/group-member-contact.ts';

function context(
  invoke: (...command: OperationCall) => Promise<unknown>,
  assertActive: () => void = () => {},
): ContactContext {
  return { invoke: invoke as ContactContext['invoke'], assertActive };
}
const receipt = { messageId: '99', sequence: '1', time: 1 };
function raw(group = false): Message {
  return {
    messageId: '00042',
    sequence: '1',
    time: 1,
    peer: group ? { type: 'group', groupId: '456' } : { type: 'private', userId: '789' },
    sender: { userId: '789', uid: 'other', nickname: 'fixture' },
    elements: [],
    raw: { opaque: true },
  };
}
test('reply captures routing and quote ID, detached closure is readonly/nonenumerable', async () => {
  for (const group of [false, true]) {
    const message = raw(group),
      calls: { id: string; input: MessageInput }[] = [];
    const event = createMessageEvent(
      message,
      context(async (...command) => {
        const [method, payload] = command;
        if (method === 'sendGroupMessage')
          calls.push({ id: payload.groupId, input: payload.message });
        else if (method === 'sendPrivateMessage')
          calls.push({ id: payload.userId, input: payload.message });
        else assert.fail('Unexpected operation');
        return receipt;
      }),
    );
    assert.ok(event);
    const descriptor = Object.getOwnPropertyDescriptor(event, 'reply');
    assert.equal(descriptor?.enumerable, false);
    assert.equal(descriptor?.writable, false);
    assert.equal(Object.hasOwn(message, 'reply'), false);
    assert.equal(event.raw, message.raw);
    assert.equal(event.elements, message.elements);
    assert.equal(event.sender, message.sender);
    const reply = event.reply;
    const sourcePeer = message.peer;
    const capturedPeer = { ...sourcePeer };
    assert.notEqual(event.peer, sourcePeer);
    assert.equal(Object.isFrozen(event.peer), true);
    assert.equal(Object.isFrozen(sourcePeer), false);
    assert.equal(Reflect.set(event, 'peer', { type: 'private', userId: '000' }), false);
    assert.equal(Reflect.defineProperty(event, 'peer', { value: sourcePeer }), false);
    assert.equal(Reflect.deleteProperty(event, 'peer'), false);
    assert.equal(Reflect.set(event.peer, 'type', group ? 'private' : 'group'), false);
    assert.equal(Reflect.set(event.peer, group ? 'groupId' : 'userId', '000'), false);
    assert.equal(Reflect.defineProperty(event.peer, 'type', { value: 'invalid' }), false);
    assert.equal(Reflect.deleteProperty(event.peer, 'type'), false);
    message.messageId = '999';
    Reflect.set(sourcePeer, group ? 'groupId' : 'userId', '999');
    message.peer = { type: 'private', userId: '999' };
    assert.deepEqual(event.peer, capturedPeer);
    assert.equal(await reply('pong'), receipt);
    await reply('quoted', true);
    assert.deepEqual(calls, [
      { id: group ? '456' : '789', input: [{ type: 'text', text: 'pong' }] },
      {
        id: group ? '456' : '789',
        input: [
          { type: 'reply', messageId: '00042' },
          { type: 'text', text: 'quoted' },
        ],
      },
    ]);
  }
});
test('invalid input and stale lifetime reject without sending; original send error survives', async () => {
  let active = true,
    calls = 0;
  const original = new Error('send');
  const event = createMessageEvent(
    raw(),
    context(
      async () => {
        calls++;
        throw original;
      },
      () => {
        if (!active) throw Error('stale');
      },
    ),
  );
  assert.ok(event);
  await assert.rejects(Reflect.apply(event.reply, undefined, [[{ type: 'text', text: 42 }]]));
  assert.equal(calls, 0);
  await assert.rejects(event.reply('pong'), (error) => error === original);
  assert.equal(calls, 1);
  active = false;
  await assert.rejects(event.reply('pong'), /stale/);
  assert.equal(calls, 1);
});
class Worker extends ChildProcess {
  requests: Record<string, unknown>[] = [];
  constructor() {
    super();
    Object.defineProperty(this, 'connected', { value: true, configurable: true });
  }
  override send(message: Serializable, ...args: unknown[]): boolean {
    const callback = args.find((value) => typeof value === 'function');
    if (typeof callback === 'function') Reflect.apply(callback, undefined, [null]);
    if (!message || typeof message !== 'object') throw Error('bad fixture');
    const request = message as Record<string, unknown>;
    this.requests.push(request);
    queueMicrotask(() => {
      this.emit('message', {
        id: request.id,
        result:
          request.method === 'init'
            ? { exports: [] }
            : request.method === 'login'
              ? { uin: '123', uid: 'self' }
              : receipt,
      });
      if (request.method === 'close') this.exit();
    });
    return true;
  }
  exit() {
    Object.defineProperty(this, 'connected', { value: false, configurable: true });
    Object.defineProperty(this, 'exitCode', { value: 0, configurable: true });
    this.emit('exit', 0, null);
  }
  override kill() {
    this.exit();
    return true;
  }
}
test('actual QQClient emits one shared event with reply; old event retires on offline/close/reconnect', async () => {
  const first = new Worker(),
    second = new Worker();
  const client = new QQClient(
    first,
    500,
    { method: 'quick', uin: '123' },
    { spawn: () => second, payload: {} },
    false,
  );
  try {
    first.emit('message', { event: 'ready', payload: { uin: '123', uid: 'self' } });
    let event: MessageEvent | undefined, alias: MessageEvent | undefined;
    client.on('message', (value) => {
      event = value;
    });
    client.on('message.private', (value) => {
      alias = value;
    });
    first.emit('message', { event: 'message', payload: raw() });
    assert.ok(event);
    assert.equal(alias, event);
    assert.ok(event.conversation instanceof FriendContact);
    assert.equal(event.conversation.userId, '789');
    await event.reply('pong', true);
    assert.equal(first.requests.at(-1)?.method, 'sendPrivateMessage');
    const previous = event;
    first.emit('message', {
      event: 'disconnected',
      payload: { source: 'login', kind: 'transport', retryable: false, args: [] },
    });
    await assert.rejects(previous.reply('stale'));
    await assert.rejects(previous.conversation.sendMessage('stale'));
    await client.reconnect({ method: 'quick', uin: '123' });
    await assert.rejects(previous.reply('stale'));
    second.emit('message', { event: 'ready', payload: { uin: '123', uid: 'self' } });
    second.emit('message', { event: 'message', payload: raw(true) });
    assert.ok(event);
    assert.ok(event.conversation instanceof GroupContact);
    assert.ok('member' in event && event.member instanceof GroupMemberContact);
    await event.member.setCard('fixture');
    assert.deepEqual(second.requests.at(-1), {
      id: second.requests.at(-1)?.id,
      method: 'setGroupMemberCard',
      groupId: '456',
      userId: '789',
      card: 'fixture',
    });
    await event.reply('group');
    assert.equal(second.requests.at(-1)?.method, 'sendGroupMessage');
    await client.close();
    await assert.rejects(event.reply('closed'));
    await assert.rejects(event.conversation.files.count());
    await assert.rejects(event.member.setCard('closed'));
  } finally {
    await client.close();
  }
});

test('input descriptor reentrancy retires before dispatch and caller elements stay unchanged', async () => {
  let active = true,
    calls = 0;
  const event = createMessageEvent(
    raw(),
    context(
      async () => {
        calls++;
        return receipt;
      },
      () => {
        if (!active) throw Error('retired');
      },
    ),
  );
  assert.ok(event);
  const element = new Proxy(
    { type: 'text' as const, text: 'pong' },
    {
      getOwnPropertyDescriptor(target, key) {
        active = false;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  await assert.rejects(event.reply([element]), /retired/);
  assert.equal(calls, 0);
  active = true;
  const content: MessageInput = [{ type: 'text', text: 'pong' }];
  await event.reply(content, true);
  assert.deepEqual(content, [{ type: 'text', text: 'pong' }]);
  assert.equal(calls, 1);
});
test('invalid routing and quote flags cannot dispatch', async () => {
  let calls = 0;
  const commands = context(async () => {
    calls++;
    return receipt;
  });
  const message = raw();
  Object.defineProperty(message, 'peer', { value: { type: 'other', userId: '789' } });
  assert.equal(createMessageEvent(message, commands), undefined);
  const event = createMessageEvent(raw(), commands);
  assert.ok(event);
  await assert.rejects(Reflect.apply(event.reply, undefined, ['pong', 'true']), /boolean/);
  assert.equal(calls, 0);
});

test('invalid peer shapes and accessors produce diagnostics without typed message delivery', async () => {
  const worker = new Worker();
  const client = new QQClient(worker, 500);
  let accessorReads = 0;
  const getter = () => {
    accessorReads++;
    throw new Error('PRIVATE_NATIVE_ROUTING');
  };
  const invalid: unknown[] = [
    undefined,
    null,
    [],
    false,
    'opaque',
    ...[
      undefined,
      null,
      [],
      {},
      { type: 'unknown', userId: '789' },
      { type: 'private' },
      { type: 'private', userId: 789 },
      { type: 'private', userId: '' },
      { type: 'private', userId: '0' },
      { type: 'private', userId: 'all' },
      { type: 'private', userId: 'u_only' },
      { type: 'group', groupId: 'u_fixture' },
      { type: 'group', groupId: '0' },
      Object.create({ type: 'private', userId: '789' }),
      Object.defineProperty({ userId: '789' }, 'type', { get: getter }),
      Object.defineProperty({ type: 'private' }, 'userId', { get: getter }),
      Object.defineProperty({ type: 'group' }, 'groupId', { get: getter }),
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw new Error('PRIVATE_NATIVE_ROUTING');
          },
        },
      ),
    ].map((peer) => ({ ...raw(), peer })),
    { ...raw(true), sender: { userId: 'u_only', uid: 'u_only', nickname: 'fixture' } },
    Object.defineProperty(raw(true), 'sender', { get: getter }),
    Object.create(raw()),
    Object.defineProperty(raw(), 'peer', { get: getter }),
  ];
  const diagnostics: unknown[] = [];
  const delivered: unknown[] = [];
  client.on('diagnostic', (value) => diagnostics.push(value));
  client.on('message', (value) => delivered.push(value));
  client.on('message.private', (value) => delivered.push(value));
  client.on('message.group', (value) => delivered.push(value));
  try {
    worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'self' } });
    for (const payload of invalid) worker.emit('message', { event: 'message', payload });
    assert.equal(accessorReads, 0);
    assert.deepEqual(delivered, []);
    assert.deepEqual(
      diagnostics,
      invalid.map(() => ({ stage: 'invalid-worker-message-peer' })),
    );
    assert.deepEqual(worker.requests, []);
  } finally {
    await client.close();
  }
});

for (const trap of ['ownKeys', 'messageId'] as const) {
  test(`message snapshot ${trap} failure rejects a valid peer without dispatch`, () => {
    const payload = new Proxy(raw(), {
      ownKeys(target) {
        if (trap === 'ownKeys') throw new Error('PRIVATE_NATIVE_SNAPSHOT');
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        if (trap === 'messageId' && key === 'messageId') throw new Error('PRIVATE_NATIVE_SNAPSHOT');
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const event = createMessageEvent(
      payload,
      context(
        async () => {
          assert.fail('snapshot must not send');
        },
        () => assert.fail('snapshot must not start an operation'),
      ),
    );
    assert.equal(event, undefined);
  });
}

test('text snapshots ordered own text fields without trimming, media placeholders, getters or iterators', () => {
  const message = raw();
  let reads = 0;
  const getter = () => {
    reads++;
    throw Error('input getter');
  };
  const elements = [
    { type: 'text', text: '  first\n' },
    { type: 'image', file: '/fixture/image.png' },
    { type: 'text', text: '' },
    { type: 'at', userId: '123', text: '@someone' },
    { type: 'text', text: 'last  ' },
    Object.defineProperty({ type: 'text' }, 'text', { get: getter }),
    Object.defineProperty({ text: 'hidden' }, 'type', { get: getter }),
  ];
  Object.defineProperty(elements, Symbol.iterator, { get: getter });
  Object.defineProperty(elements, '7', { get: getter });
  Object.defineProperty(message, 'elements', { value: elements, writable: true });
  const event = createMessageEvent(
    message,
    context(async () => assert.fail('no operation')),
  );
  assert.ok(event);
  assert.equal(event.text, '  first\nlast  ');
  assert.equal(event.elements, elements);
  Reflect.set(elements[0]!, 'text', 'mutated');
  message.elements = [];
  assert.equal(event.text, '  first\nlast  ');
  assert.equal(reads, 0);
  assert.deepEqual(Object.getOwnPropertyDescriptor(event, 'text'), {
    value: '  first\nlast  ',
    enumerable: true,
    writable: false,
    configurable: false,
  });
  assert.equal(Reflect.set(event, 'text', 'replacement'), false);
  assert.equal(Reflect.deleteProperty(event, 'text'), false);
  assert.equal(Reflect.defineProperty(event, 'text', { value: 'replacement' }), false);
});

for (const group of [false, true]) {
  test(`${group ? 'group/member' : 'friend'} handles retain the original route and session without serializing actions`, async () => {
    const message = raw(group);
    for (const name of ['text', 'reply', 'conversation', 'friend', 'group', 'member'])
      Object.defineProperty(message, name, {
        enumerable: true,
        configurable: false,
        get: () => assert.fail('worker data must not supply live capabilities'),
      });
    const calls: OperationCall[] = [];
    let active = true;
    const event = createMessageEvent(
      message,
      context(
        async (...command) => {
          calls.push(command);
          return receipt;
        },
        () => {
          if (!active) throw Error('retired event');
        },
      ),
    );
    assert.ok(event);
    assert.equal(event.text, '');
    const names = group ? ['conversation', 'group', 'member'] : ['conversation', 'friend'];
    for (const name of names) {
      assert.deepEqual(Object.getOwnPropertyDescriptor(event, name), {
        value: Reflect.get(event, name),
        enumerable: false,
        writable: false,
        configurable: false,
      });
      assert.equal(Reflect.set(event, name, {}), false);
      assert.equal(Reflect.defineProperty(event, name, { value: {} }), false);
      assert.equal(Reflect.deleteProperty(event, name), false);
    }
    for (const name of group ? ['friend'] : ['group', 'member'])
      assert.equal(Object.hasOwn(event, name), false);
    const serialized = JSON.parse(JSON.stringify(event));
    assert.equal(serialized.text, '');
    for (const name of ['conversation', 'friend', 'group', 'member', 'reply'])
      assert.equal(Object.hasOwn(serialized, name), false);
    message.sender.userId = '999';
    Reflect.set(message.peer, group ? 'groupId' : 'userId', '999');
    message.sender = { userId: '888', uid: 'replacement', nickname: 'replacement' };
    message.peer = { type: 'private', userId: '888' };
    if (group) {
      assert.ok('group' in event && event.group instanceof GroupContact);
      assert.ok('member' in event && event.member instanceof GroupMemberContact);
      assert.equal(event.conversation, event.group);
      assert.equal(event.group.groupId, '456');
      assert.equal(event.member.groupId, '456');
      assert.equal(event.member.userId, '789');
      await event.group.getInfo();
      await event.member.setCard('member card');
      await event.group.files.count();
      assert.deepEqual(calls, [
        ['getGroupInfo', { groupId: '456' }],
        ['setGroupMemberCard', { groupId: '456', userId: '789', card: 'member card' }],
        ['getGroupFileCount', { groupId: '456' }],
      ]);
      active = false;
      await assert.rejects(event.group.getInfo(), /retired event/);
      await assert.rejects(event.group.files.count(), /retired event/);
      await assert.rejects(event.member.setCard('stale'), /retired event/);
    } else {
      assert.ok('friend' in event && event.friend instanceof FriendContact);
      assert.equal(event.conversation, event.friend);
      assert.equal(event.friend.userId, '789');
      await event.friend.getProfile();
      assert.deepEqual(calls, [['getUserProfile', { userId: '789' }]]);
      active = false;
      await assert.rejects(event.friend.getProfile(), /retired event/);
    }
    const submitted = calls.length;
    await assert.rejects(event.conversation.sendMessage('stale'), /retired event/);
    await assert.rejects(event.reply('stale'), /retired event/);
    assert.equal(calls.length, submitted);
  });
}

test('nondecimal private peers and unaddressable group senders reject without UID inference or accessors', () => {
  let reads = 0;
  const getter = () => {
    reads++;
    return '789';
  };
  const invalid: unknown[] = [
    { ...raw(), peer: { type: 'private', userId: 'u_only' } },
    ...[
      undefined,
      null,
      [],
      {},
      { userId: 789 },
      { userId: '' },
      { userId: '0' },
      { userId: 'u_only' },
      Object.create({ userId: '789' }),
      Object.defineProperty({}, 'userId', { get: getter }),
    ].map((sender) => ({ ...raw(true), sender })),
    Object.defineProperty(raw(true), 'sender', { get: getter }),
    {
      ...raw(true),
      sender: new Proxy(
        { userId: '789' },
        {
          ownKeys() {
            throw Error('opaque sender');
          },
        },
      ),
    },
    {
      ...raw(),
      elements: new Proxy([], {
        ownKeys() {
          throw Error('opaque text');
        },
      }),
    },
  ];
  const commands = context(
    async () => assert.fail('malformed event cannot send'),
    () => assert.fail('construction cannot act'),
  );
  for (const value of invalid) assert.equal(createMessageEvent(value, commands), undefined);
  assert.equal(reads, 0);
});

test('sender descriptor reentrancy cannot bind received actions to a replacement account', async () => {
  const worker = new Worker(),
    client = new QQClient(worker, 500);
  let event: MessageEvent | undefined;
  try {
    worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'old_session' } });
    client.on('message', (value) => {
      event = value;
    });
    const source = raw(true);
    source.sender = new Proxy(source.sender, {
      getOwnPropertyDescriptor(target, key) {
        if (key === 'userId')
          worker.emit('message', {
            event: 'ready',
            payload: { uin: '234', uid: 'new_session' },
          });
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    worker.emit('message', { event: 'message', payload: source });
    assert.ok(event);
    assert.deepEqual(client.account, { uin: '234', uid: 'new_session' });
    assert.ok(event.conversation instanceof GroupContact);
    assert.ok('member' in event && event.member instanceof GroupMemberContact);
    await assert.rejects(event.reply('stale'), /inactive or replaced/);
    await assert.rejects(event.conversation.sendMessage('stale'), /inactive or replaced/);
    await assert.rejects(event.conversation.files.count(), /inactive or replaced/);
    await assert.rejects(event.member.setCard('stale'), /inactive or replaced/);
    assert.equal(worker.requests.length, 0);
  } finally {
    await client.close();
  }
});
