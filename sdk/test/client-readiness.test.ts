import assert from 'node:assert/strict';
import { ChildProcess, type Serializable } from 'node:child_process';
import test from 'node:test';
import { QQClient } from '../src/index.ts';
import type { Account, ClientState, Message, MessageEvent } from '../src/types.ts';

const account: Account = { uin: '123', uid: 'u_self' };
const receipt = { messageId: '99', sequence: '1', time: 1 };

class Worker extends ChildProcess {
  readonly requests: Record<string, unknown>[] = [];
  constructor() {
    super();
    Object.defineProperty(this, 'connected', { value: true, configurable: true });
  }
  override send(value: Serializable, ...args: unknown[]): boolean {
    assert.ok(value && typeof value === 'object');
    const request = value as Record<string, unknown>;
    this.requests.push(request);
    const callback = args.find((argument) => typeof argument === 'function');
    if (typeof callback === 'function') Reflect.apply(callback, undefined, [null]);
    if (request.method !== 'login')
      queueMicrotask(() => {
        this.emit('message', {
          id: request.id,
          result:
            request.method === 'init'
              ? { exports: [] }
              : request.method === 'listFriends'
                ? []
                : receipt,
        });
        if (request.method === 'close') this.kill();
      });
    return true;
  }
  override kill(): boolean {
    Object.defineProperty(this, 'connected', { value: false, configurable: true });
    Object.defineProperty(this, 'exitCode', { value: 0, configurable: true });
    this.emit('exit', 0, null);
    return true;
  }
  ready(event: 'login' | 'ready', payload: unknown = { ...account }): void {
    this.emit('message', { event, payload });
  }
  received(client: QQClient): MessageEvent {
    let captured: MessageEvent | undefined;
    client.once('message', (message) => {
      captured = message;
    });
    const message: Message = {
      messageId: '42',
      sequence: '1',
      time: 1,
      peer: { type: 'private', userId: '456' },
      sender: { userId: '456', uid: 'u_other', nickname: 'fixture' },
      elements: [],
      raw: {},
    };
    this.emit('message', { event: 'message', payload: message });
    assert.ok(captured);
    return captured;
  }
}

test('login listeners can immediately query friends before the following ready event', async () => {
  const worker = new Worker();
  const client = new QQClient(worker, 500);
  let query: Promise<unknown> | undefined;
  const states: ClientState[] = [];
  client.on('state', (state) => states.push(state));
  client.on('login', (value) => {
    assert.equal(client.state, 'online');
    assert.deepEqual(client.account, account);
    query = client.listFriends();
    value.uid = 'listener mutation';
  });
  try {
    const login = client.login({ method: 'quick', uin: account.uin });
    void login.catch(() => {});
    worker.ready('login');
    assert.ok(query);
    assert.deepEqual(await query, []);
    assert.deepEqual(client.account, account);
    worker.ready('ready');
    worker.emit('message', { id: worker.requests[0]!.id, result: { ...account } });
    assert.deepEqual(await login, account);
    assert.deepEqual(states, ['connecting', 'online']);
  } finally {
    await client.close();
  }
});

test('login followed by duplicate readiness keeps an existing reply bound to this online session', async () => {
  const worker = new Worker();
  const client = new QQClient(worker, 500);
  try {
    worker.ready('login');
    const message = worker.received(client);
    for (const event of ['ready', 'ready', 'login'] as const) worker.ready(event);
    await Promise.resolve();
    assert.equal(await message.reply('pong'), receipt);
    assert.equal(worker.requests.at(-1)?.method, 'sendPrivateMessage');
  } finally {
    await client.close();
  }
});

test('changed exact identity and offline restoration retire replies even on the same worker', async () => {
  const worker = new Worker();
  const client = new QQClient(worker, 500);
  try {
    worker.ready('login');
    let previous = worker.received(client);
    for (const next of [
      { uin: '0123', uid: account.uid },
      { uin: '0123', uid: 'u_replacement' },
    ]) {
      worker.ready('ready', next);
      await assert.rejects(previous.reply('stale'), /inactive or replaced/);
      previous = worker.received(client);
      assert.equal(await previous.reply('current'), receipt);
    }
    worker.emit('message', { event: 'disconnected', payload: { retryable: false } });
    worker.ready('login', { uin: '0123', uid: 'u_replacement' });
    worker.ready('ready', { uin: '0123', uid: 'u_replacement' });
    await assert.rejects(previous.reply('restored session'), /inactive or replaced/);
    const current = worker.received(client);
    assert.equal(await current.reply('new session'), receipt);
    await client.close();
    await assert.rejects(current.reply('closed'), /inactive or replaced/);
  } finally {
    await client.close();
  }
});

test('reconnecting to the same identity never revives a previous reply', async () => {
  const old = new Worker();
  const replacement = new Worker();
  const client = new QQClient(
    old,
    500,
    { method: 'quick', uin: account.uin },
    { spawn: () => replacement, payload: {} },
  );
  try {
    old.ready('login');
    const previous = old.received(client);
    const reconnect = client.reconnect({ method: 'quick', uin: account.uin });
    await new Promise((resolve) => setImmediate(resolve));
    replacement.ready('login');
    replacement.ready('ready');
    const login = replacement.requests.find((request) => request.method === 'login');
    assert.ok(login);
    replacement.emit('message', { id: login.id, result: { ...account } });
    await reconnect;
    old.ready('login');
    await assert.rejects(previous.reply('old worker'), /inactive or replaced/);
    assert.equal(await replacement.received(client).reply('new worker'), receipt);
  } finally {
    await client.close();
  }
});

for (const event of ['login', 'ready'] as const) {
  test(`malformed ${event} does not publish readiness or replace a current identity`, async () => {
    const worker = new Worker();
    const client = new QQClient(worker, 500);
    const stages: string[] = [];
    let deliveries = 0;
    client.on(event, () => deliveries++);
    client.on('diagnostic', ({ stage }) => stages.push(stage));
    const accessor = { uin: account.uin };
    Object.defineProperty(accessor, 'uid', { get: () => assert.fail('identity accessor') });
    const malformed = [null, [], {}, { ...account, uid: ' ' }, { ...account, uin: 123 }, accessor];
    try {
      for (const value of malformed) worker.ready(event, value);
      assert.equal(client.state, 'idle');
      assert.equal(client.account, undefined);
      assert.equal(deliveries, 0);
      worker.ready(event);
      const message = worker.received(client);
      for (const value of malformed) worker.ready(event, value);
      assert.deepEqual(client.account, account);
      assert.equal(deliveries, 1);
      assert.deepEqual(stages, Array(malformed.length * 2).fill(`invalid-worker-${event}-account`));
      assert.equal(await message.reply('still current'), receipt);
    } finally {
      await client.close();
    }
  });

  test(`close from the online state observer suppresses the pending ${event} delivery`, async () => {
    const worker = new Worker();
    const client = new QQClient(worker, 500);
    let close: Promise<void> | undefined;
    let deliveries = 0;
    client.on('state', (state) => {
      if (state === 'online') close = client.close();
    });
    client.on(event, () => deliveries++);
    try {
      worker.ready(event);
      assert.ok(close);
      await close;
      worker.ready('login');
      worker.ready('ready');
      assert.equal(client.state, 'closed');
      assert.equal(client.account, undefined);
      assert.equal(deliveries, 0);
    } finally {
      await client.close();
    }
  });

  test(`an online observer failure keeps ${event} state committed and preserves the original error`, async () => {
    const worker = new Worker();
    const client = new QQClient(worker, 500);
    const failure = new Error('online observer failure');
    client.once('state', (state) => {
      if (state === 'online') throw failure;
    });
    try {
      assert.throws(
        () => worker.ready(event),
        (error) => error === failure,
      );
      assert.equal(client.state, 'online');
      assert.deepEqual(client.account, account);
      const message = worker.received(client);
      worker.ready('ready');
      assert.equal(await message.reply('still current'), receipt);
    } finally {
      await client.close();
    }
  });

  test(`an offline transition from the online observer supersedes the pending ${event} delivery`, async () => {
    const worker = new Worker();
    const client = new QQClient(worker, 500);
    let deliveries = 0;
    client.on('state', (state) => {
      if (state === 'online')
        worker.emit('message', { event: 'disconnected', payload: { retryable: false } });
    });
    client.on(event, () => deliveries++);
    try {
      worker.ready(event);
      assert.equal(client.state, 'disconnected');
      assert.equal(client.account, undefined);
      assert.equal(deliveries, 0);
    } finally {
      await client.close();
    }
  });
}
