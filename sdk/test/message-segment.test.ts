import assert from 'node:assert/strict';
import { ChildProcess, type Serializable } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { QQClient, segment } from '../src/index.ts';
import type { MessageEvent, MessageInput, Peer, SentMessage } from '../src/types.ts';

const userId = '00090071992547409931234567890';
const groupId = '00090071992547409939876543210';
const messageId = '00018446744073709551615';
const receipt = { messageId: '99', sequence: '1', time: 1 };

/** Exercise the public facade and IPC contract without acquiring native code. */
class Worker extends ChildProcess {
  readonly requests: Record<string, unknown>[] = [];

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
      this.emit('message', { id: command.id, result: receipt });
      if (command.method === 'close') this.exit();
    });
    return true;
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
  const client = new QQClient(worker, 500);
  worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_self' } });
  return { client, worker };
}

function receive(client: QQClient, worker: Worker, peer: Peer): MessageEvent {
  let received: MessageEvent | undefined;
  client.once('message', (message) => {
    received = message;
  });
  worker.emit('message', {
    event: 'message',
    payload: {
      ...receipt,
      messageId,
      peer,
      sender: { userId, uid: 'u_friend', nickname: 'friend' },
      elements: [],
      raw: {},
    },
  });
  assert.ok(received);
  return received;
}

const entries: {
  name: string;
  peer: Peer;
  prepare(client: QQClient, worker: Worker): (input: MessageInput) => Promise<SentMessage>;
}[] = [
  {
    name: 'root private',
    peer: { type: 'private', userId },
    prepare: (client) => (input) => client.sendPrivateMessage(userId, input),
  },
  {
    name: 'root group',
    peer: { type: 'group', groupId },
    prepare: (client) => (input) => client.sendGroupMessage(groupId, input),
  },
  {
    name: 'friend contact',
    peer: { type: 'private', userId },
    prepare: (client) => {
      const friend = client.pickFriend(userId);
      return (input) => friend.sendMessage(input);
    },
  },
  {
    name: 'group contact',
    peer: { type: 'group', groupId },
    prepare: (client) => {
      const group = client.pickGroup(groupId);
      return (input) => group.sendMessage(input);
    },
  },
  {
    name: 'private event reply',
    peer: { type: 'private', userId },
    prepare: (client, worker) => receive(client, worker, { type: 'private', userId }).reply,
  },
  {
    name: 'group event reply',
    peer: { type: 'group', groupId },
    prepare: (client, worker) => receive(client, worker, { type: 'group', groupId }).reply,
  },
];

for (const entry of entries) {
  test(`${entry.name} accepts legacy text, a single segment and readonly mixed input`, async (t) => {
    const { client, worker } = fixture();
    t.after(() => client.close());
    const send = entry.prepare(client, worker);
    const single = Object.freeze(segment.text('single'));
    const mixed = Object.freeze(['before ', Object.freeze(segment.face(1)), ' after'] as const);
    for (const input of ['plain', single, mixed] as const) assert.equal(await send(input), receipt);
    const method = entry.peer.type === 'group' ? 'sendGroupMessage' : 'sendPrivateMessage';
    const destination = entry.peer.type === 'group' ? { groupId } : { userId };
    assert.deepEqual(
      worker.requests.map(({ id: _id, ...command }) => command),
      [
        { method, ...destination, message: [{ type: 'text', text: 'plain' }] },
        { method, ...destination, message: [{ type: 'text', text: 'single' }] },
        {
          method,
          ...destination,
          message: [
            { type: 'text', text: 'before ' },
            { type: 'face', id: 1 },
            { type: 'text', text: ' after' },
          ],
        },
      ],
    );
    assert.deepEqual(single, { type: 'text', text: 'single' });
    assert.deepEqual(mixed, ['before ', { type: 'face', id: 1 }, ' after']);
  });

  test(`${entry.name} rejects invalid whole inputs before IPC without invoking accessors`, async (t) => {
    const { client, worker } = fixture();
    t.after(() => client.close());
    const send = entry.prepare(client, worker);
    let reads = 0;
    const getter = {
      get() {
        reads++;
        return 'accessor';
      },
    };
    const slot = Object.defineProperty(new Array(1), '0', getter);
    const element = Object.defineProperty({ type: 'text' }, 'text', getter);
    const inherited = new Array(1);
    Object.setPrototypeOf(inherited, { 0: 'inherited' });
    const invalid: unknown[] = [
      undefined,
      null,
      1,
      [],
      new Array(1),
      slot,
      inherited,
      element,
      Object.create({ type: 'text', text: 'inherited' }),
      [segment.text('valid first'), element],
      [segment.text('valid first'), ['nested']],
      [segment.text('valid first'), { type: 'unknown' }],
      segment.image('relative.png'),
      segment.record('https://example.invalid/record'),
      segment.file(resolve('fixture.txt'), 'invalid/name'),
      segment.reply('0'),
    ];
    for (const input of invalid)
      await assert.rejects(async () => Reflect.apply(send, undefined, [input]));
    assert.equal(reads, 0);
    assert.deepEqual(worker.requests, []);
  });
}

test('all existing segment kinds compose in a group with exact decimal identities and no eager I/O', async (t) => {
  const { client, worker } = fixture();
  t.after(() => client.close());
  const media = resolve('fixture-path-not-read-by-facade');
  const elements = Object.freeze([
    segment.reply(messageId),
    segment.at(userId, 'friend'),
    segment.at('all'),
    ' ',
    segment.text('body'),
    segment.face(1),
    segment.image(media),
    segment.record(media),
    segment.video(media),
    segment.file(media, 'file.txt'),
  ]);
  assert.equal(worker.requests.length, 0);
  await client.pickGroup(groupId).sendMessage(elements);
  const sent = worker.requests[0];
  assert.deepEqual(sent?.message, [
    { type: 'reply', messageId },
    { type: 'at', userId, text: 'friend' },
    { type: 'at', userId: 'all' },
    { type: 'text', text: ' ' },
    { type: 'text', text: 'body' },
    { type: 'face', id: 1 },
    { type: 'image', file: media },
    { type: 'record', file: media },
    { type: 'video', file: media },
    { type: 'file', file: media, name: 'file.txt' },
  ]);
  assert.equal(sent?.groupId, groupId);
});

test('construction defers validation, while private sends still reject mentions', async (t) => {
  const { client, worker } = fixture();
  t.after(() => client.close());
  const invalid = segment.face(-1);
  assert.equal(invalid.id, -1);
  assert.deepEqual(worker.requests, []);
  await assert.rejects(client.sendGroupMessage(groupId, invalid));
  await assert.rejects(client.pickFriend(userId).sendMessage(segment.at(userId)), /Mentions/);
  const message = receive(client, worker, { type: 'private', userId });
  await assert.rejects(message.reply(['hello', segment.at('all')]), /Mentions/);
  assert.deepEqual(worker.requests, []);
});

test('quoted replies prepend the received identity and capture mixed input without mutation', async (t) => {
  const { client, worker } = fixture();
  t.after(() => client.close());
  const message = receive(client, worker, { type: 'group', groupId });
  const content = Object.freeze(['hello ', Object.freeze(segment.at(userId))] as const);
  await message.reply(content, true);
  assert.deepEqual(worker.requests[0]?.message, [
    { type: 'reply', messageId },
    { type: 'text', text: 'hello ' },
    { type: 'at', userId },
  ]);
  assert.deepEqual(content, ['hello ', { type: 'at', userId }]);
});

test('single and mixed input captures are detached and bypass caller iterators', async (t) => {
  const { client, worker } = fixture();
  t.after(() => client.close());
  let iterations = 0;
  const element = segment.text('original');
  const single = client.sendPrivateMessage(userId, element);
  element.text = 'changed';
  await single;
  const mixed = ['prefix', element];
  Object.defineProperty(mixed, Symbol.iterator, {
    value() {
      iterations++;
      throw Error('caller iterator must not run');
    },
  });
  const pending = client.sendGroupMessage(groupId, mixed);
  element.text = 'changed again';
  mixed[0] = 'replaced';
  await pending;
  assert.equal(iterations, 0);
  assert.deepEqual(worker.requests[0]?.message, [{ type: 'text', text: 'original' }]);
  assert.deepEqual(worker.requests[1]?.message, [
    { type: 'text', text: 'prefix' },
    { type: 'text', text: 'changed' },
  ]);
});
