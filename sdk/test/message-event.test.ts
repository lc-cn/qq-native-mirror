import assert from 'node:assert/strict';
import { ChildProcess, type Serializable } from 'node:child_process';
import test from 'node:test';
import { QQClient } from '../src/index.ts';
import { createMessageEvent } from '../src/client/message-event.ts';
import type { Message, MessageEvent, MessageInput } from '../src/types.ts';
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
    const send = async (id: string, input: MessageInput) => {
      calls.push({ id, input });
      return receipt;
    };
    const event = createMessageEvent(message, {
      assertActive() {},
      sendPrivateMessage: send,
      sendGroupMessage: send,
    });
    const descriptor = Object.getOwnPropertyDescriptor(event, 'reply');
    assert.equal(descriptor?.enumerable, false);
    assert.equal(descriptor?.writable, false);
    assert.equal(Object.hasOwn(message, 'reply'), false);
    assert.equal(event.raw, message.raw);
    const reply = event.reply;
    message.messageId = '999';
    message.peer = { type: 'private', userId: '999' };
    event.peer = { type: 'private', userId: '000' };
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
  const event = createMessageEvent(raw(), {
    assertActive() {
      if (!active) throw Error('stale');
    },
    async sendPrivateMessage() {
      calls++;
      throw original;
    },
    async sendGroupMessage() {
      calls++;
      throw original;
    },
  });
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
    await event.reply('pong', true);
    assert.equal(first.requests.at(-1)?.method, 'sendPrivateMessage');
    const previous = event;
    first.emit('message', {
      event: 'disconnected',
      payload: { source: 'login', kind: 'transport', retryable: false, args: [] },
    });
    await assert.rejects(previous.reply('stale'));
    await client.reconnect({ method: 'quick', uin: '123' });
    await assert.rejects(previous.reply('stale'));
    second.emit('message', { event: 'ready', payload: { uin: '123', uid: 'self' } });
    second.emit('message', { event: 'message', payload: raw(true) });
    assert.ok(event);
    await event.reply('group');
    assert.equal(second.requests.at(-1)?.method, 'sendGroupMessage');
    await client.close();
    await assert.rejects(event.reply('closed'));
  } finally {
    await client.close();
  }
});

test('input descriptor reentrancy retires before dispatch and caller elements stay unchanged', async () => {
  let active = true,
    calls = 0;
  const event = createMessageEvent(raw(), {
    assertActive() {
      if (!active) throw Error('retired');
    },
    async sendPrivateMessage() {
      calls++;
      return receipt;
    },
    async sendGroupMessage() {
      calls++;
      return receipt;
    },
  });
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
  const context = {
    assertActive() {},
    async sendPrivateMessage() {
      calls++;
      return receipt;
    },
    async sendGroupMessage() {
      calls++;
      return receipt;
    },
  };
  const message = raw();
  Object.defineProperty(message, 'peer', { value: { type: 'other', userId: '789' } });
  await assert.rejects(createMessageEvent(message, context).reply('pong'), /conversation/);
  const event = createMessageEvent(raw(), context);
  await assert.rejects(Reflect.apply(event.reply, undefined, ['pong', 'true']), /boolean/);
  assert.equal(calls, 0);
});
