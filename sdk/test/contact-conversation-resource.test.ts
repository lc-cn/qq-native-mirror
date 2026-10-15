import assert from 'node:assert/strict';
import { ChildProcess, type Serializable } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { KernelRequestError, QQClient } from '../src/index.ts';
import type { SerializedKernelError } from '../src/errors.ts';
import type { ForwardTextNode, Message, Peer } from '../src/types.ts';

const account = { uin: '123', uid: 'u_self' };
const receipt = { messageId: '99', sequence: '1', time: 1, resourceId: 'fixture-resource' };
const node: ForwardTextNode = { userId: '456', nickname: 'author', time: 1, text: 'hello' };
const output = resolve('fixture-attachment.bin');

class Worker extends ChildProcess {
  readonly requests: Record<string, unknown>[] = [];
  result: unknown;
  failure?: SerializedKernelError;
  hold?: string;

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
    if (request.method === this.hold) return true;
    const { failure, result } = this;
    queueMicrotask(() => {
      this.emit(
        'message',
        failure ? { id: request.id, error: failure } : { id: request.id, result },
      );
      if (request.method === 'close') this.kill();
    });
    return true;
  }

  ready(value = account): void {
    this.emit('message', { event: 'ready', payload: value });
  }

  offline(): void {
    this.emit('message', { event: 'disconnected', payload: { retryable: false } });
  }

  override kill(): boolean {
    Object.defineProperty(this, 'connected', { value: false, configurable: true });
    Object.defineProperty(this, 'exitCode', { value: 0, configurable: true });
    this.emit('exit', 0, null);
    return true;
  }
}

function fixture(timeout = 500) {
  const worker = new Worker();
  const client = new QQClient(worker, timeout);
  worker.ready();
  return { worker, client };
}

function commands(worker: Worker) {
  return worker.requests.map(({ id: _id, ...command }) => command);
}

test('friend and group resource methods use the selected conversation and preserve operation results', async (t) => {
  for (const type of ['private', 'group'] as const) {
    const { client, worker } = fixture();
    t.after(() => client.close());
    const contact = type === 'private' ? client.pickFriend('000456') : client.pickGroup('000789');
    const peer: Peer =
      type === 'private' ? { type, userId: '000456' } : { type, groupId: '000789' };
    const message: Message = {
      messageId: '99',
      sequence: '1',
      time: 1,
      peer,
      sender: { userId: '456', uid: 'u_author', nickname: 'author' },
      elements: [{ type: 'text', text: 'hello' }],
      raw: {},
    };
    const messages = [message];
    worker.result = messages;
    assert.equal(await contact.getForwardMessages('00099'), messages);
    assert.equal(await contact.getForwardMessages('00099', '00100'), messages);
    worker.result = undefined;
    const destination: Peer = { type: 'group', groupId: '000987' };
    const ids: readonly string[] = Object.freeze(['00099', '00100', '00099']);
    assert.equal(await contact.forwardMessages(destination, ids), undefined);
    worker.result = receipt;
    assert.equal(await contact.sendMergedForward([node]), receipt);
    const downloaded = { file: output };
    worker.result = downloaded;
    assert.equal(await contact.downloadAttachment('00099', '001', output), downloaded);
    assert.deepEqual(commands(worker), [
      { method: 'getForwardMessages', peer, rootMessageId: '00099', parentMessageId: '00099' },
      { method: 'getForwardMessages', peer, rootMessageId: '00099', parentMessageId: '00100' },
      {
        method: 'forwardMessages',
        source: peer,
        destination,
        messageIds: ['00099', '00100', '00099'],
      },
      { method: 'sendMergedForward', peer, nodes: [node], options: {} },
      {
        method: 'downloadAttachment',
        peer,
        messageId: '00099',
        elementId: '001',
        destination: output,
      },
    ]);
  }
});

test('forward and merged-forward inputs detach before IPC without reading custom iterators', async (t) => {
  const { client, worker } = fixture();
  t.after(() => client.close());
  const contact = client.pickFriend('456');
  const ids = ['0099'];
  Object.defineProperty(ids, Symbol.iterator, {
    value: () => assert.fail('caller iterator must not run'),
  });
  const destination: Peer = { type: 'group', groupId: '00789' };
  const forwarded = contact.forwardMessages(destination, ids);
  destination.groupId = '999';
  ids[0] = '999';
  await forwarded;
  const input = [{ ...node }];
  Object.defineProperty(input, Symbol.iterator, {
    value: () => assert.fail('node iterator must not run'),
  });
  const options = { title: 'original title' };
  const merged = contact.sendMergedForward(input, options);
  input[0]!.text = 'changed';
  options.title = 'changed';
  await merged;
  assert.deepEqual(commands(worker), [
    {
      method: 'forwardMessages',
      source: { type: 'private', userId: '456' },
      destination: { type: 'group', groupId: '00789' },
      messageIds: ['0099'],
    },
    {
      method: 'sendMergedForward',
      peer: { type: 'private', userId: '456' },
      nodes: [node],
      options: { title: 'original title' },
    },
  ]);
});

test('invalid resource inputs and caller exceptions reject before any operation is dispatched', async (t) => {
  const { client, worker } = fixture();
  t.after(() => client.close());
  const contact = client.pickGroup('789');
  await assert.rejects(contact.getForwardMessages('bad'));
  await assert.rejects(contact.getForwardMessages('99', '-1'));
  await assert.rejects(contact.forwardMessages({ type: 'private', userId: 'bad' }, ['99']));
  await assert.rejects(contact.forwardMessages({ type: 'private', userId: '456' }, []));
  const ids = ['99'];
  Object.defineProperty(ids, '0', { get: () => assert.fail('array accessor must not run') });
  await assert.rejects(contact.forwardMessages({ type: 'private', userId: '456' }, ids));
  await assert.rejects(contact.sendMergedForward([]));
  await assert.rejects(contact.sendMergedForward([{ ...node, userId: '0' }]));
  await assert.rejects(
    contact.sendMergedForward([node], {
      get title() {
        return assert.fail('option accessor must not run');
      },
    }),
  );
  await assert.rejects(contact.downloadAttachment('99', 'bad', output));
  await assert.rejects(contact.downloadAttachment('99', '1', 'relative.bin'));
  const original = new Error('original destination getter failure');
  const destination: Peer = {
    type: 'group',
    get groupId(): string {
      throw original;
    },
  };
  await assert.rejects(contact.forwardMessages(destination, ['99']), (error) => error === original);
  assert.deepEqual(worker.requests, []);
});

test('input reentrancy cannot dispatch contact operations into a replacement account', async (t) => {
  const { client, worker } = fixture();
  t.after(() => client.close());
  const retire = () => {
    worker.offline();
    worker.ready({ uin: '987', uid: 'u_replacement' });
  };
  const contact = client.pickFriend('456');
  await assert.rejects(
    contact.forwardMessages(
      {
        type: 'group',
        get groupId() {
          retire();
          return '789';
        },
      },
      ['99'],
    ),
    /inactive|session/,
  );
  const replacement = client.pickGroup('789');
  const options = new Proxy(
    { title: 'original' },
    {
      getOwnPropertyDescriptor(target, key) {
        retire();
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  await assert.rejects(replacement.sendMergedForward([node], options), /inactive|session/);
  assert.deepEqual(worker.requests, []);
});

test('all resource methods reject retired or closed contacts without IPC', async (t) => {
  const { client, worker } = fixture();
  t.after(() => client.close());
  const contact = client.pickGroup('789');
  worker.offline();
  worker.ready();
  const actions = [
    () => contact.getForwardMessages('99'),
    () => contact.forwardMessages({ type: 'private', userId: '456' }, ['99']),
    () => contact.sendMergedForward([node]),
    () => contact.downloadAttachment('99', '1', output),
  ];
  for (const action of actions) await assert.rejects(action(), /inactive|session/);
  assert.deepEqual(worker.requests, []);
  const current = client.pickFriend('456');
  await client.close();
  const count = worker.requests.length;
  await assert.rejects(current.getForwardMessages('99'), /inactive|session/);
  await assert.rejects(
    current.forwardMessages({ type: 'group', groupId: '789' }, ['99']),
    /inactive|session/,
  );
  await assert.rejects(current.sendMergedForward([node]), /inactive|session/);
  await assert.rejects(current.downloadAttachment('99', '1', output), /inactive|session/);
  assert.equal(worker.requests.length, count);
});

test('operation errors retain native metadata and are never replayed by contact methods', async (t) => {
  const { client, worker } = fixture();
  t.after(async () => {
    worker.failure = undefined;
    await client.close();
  });
  const contact = client.pickFriend('456');
  worker.failure = { message: 'fixture failure', name: 'NativeFailure', code: 73 };
  for (const [method, action] of [
    ['getForwardMessages', () => contact.getForwardMessages('99')],
    ['forwardMessages', () => contact.forwardMessages({ type: 'group', groupId: '789' }, ['99'])],
    ['downloadAttachment', () => contact.downloadAttachment('99', '1', output)],
  ] as const) {
    const count = worker.requests.length;
    await assert.rejects(action(), (error) => {
      assert.ok(error instanceof KernelRequestError);
      assert.equal(error.operation, method);
      assert.equal(error.code, 73);
      assert.equal(error.message, 'fixture failure');
      assert.equal(error.originalName, 'NativeFailure');
      return true;
    });
    assert.equal(worker.requests.length, count + 1);
  }
  const progress = {
    phase: 'card',
    uploadCompletion: 'resource-received',
    cardCompletion: 'unknown',
    resourceId: 'fixture-resource',
  } as const;
  worker.failure = { ...worker.failure, mergedForward: progress };
  const count = worker.requests.length;
  await assert.rejects(contact.sendMergedForward([node]), (error) => {
    assert.ok(error instanceof KernelRequestError);
    assert.equal(error.operation, 'sendMergedForward');
    assert.equal(error.code, 73);
    assert.deepEqual(error.mergedForward, progress);
    return true;
  });
  assert.equal(worker.requests.length, count + 1);
});

test('a merged-forward timeout keeps both remote phases unknown without retrying', async (t) => {
  const { client, worker } = fixture(10);
  t.after(() => client.close());
  worker.hold = 'sendMergedForward';
  await assert.rejects(client.pickGroup('789').sendMergedForward([node]), (error) => {
    assert.ok(error instanceof KernelRequestError);
    assert.equal(error.operation, 'sendMergedForward');
    assert.deepEqual(error.mergedForward, {
      phase: 'operation',
      uploadCompletion: 'unknown',
      cardCompletion: 'unknown',
    });
    return true;
  });
  assert.equal(worker.requests.length, 1);
});
