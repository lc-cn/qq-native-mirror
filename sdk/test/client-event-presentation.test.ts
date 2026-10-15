import assert from 'node:assert/strict';
import { ChildProcess, type Serializable } from 'node:child_process';
import test from 'node:test';
import { createClientEventPresentation } from '../src/client/client-event-presentation.ts';
import { createMessageEvent } from '../src/client/message-event.ts';
import { QQClient } from '../src/index.ts';
import type { Message, MessageEvent } from '../src/types.ts';

function presentMessage(message: unknown) {
  return createMessageEvent(message, {
    assertActive() {},
    async sendPrivateMessage() {
      assert.fail('presentation must not send');
    },
    async sendGroupMessage() {
      assert.fail('presentation must not send');
    },
  });
}
const presenters = {
  message: presentMessage,
  friendRequest: () => undefined,
  groupRequest: () => undefined,
};

function fixture() {
  const events: [string, unknown][] = [];
  return {
    events,
    presentation: createClientEventPresentation(
      (event, payload) => events.push([event, payload]),
      presenters,
    ),
  };
}

test('presentation forwards unknown payloads without wrapping, copying or coercion', () => {
  const { presentation, events } = fixture();
  const value = { privateDetail: Symbol('opaque'), toString: () => assert.fail('coercion') };
  for (const payload of [value, null, undefined, false, 0, 'opaque']) {
    presentation.forward('future-worker-event', payload);
    assert.equal(events.at(-1)![0], 'future-worker-event');
    assert.equal(events.at(-1)![1], payload);
  }
  assert.deepEqual(presentation.audit, []);
});

test('worker message aliases cannot bypass immutable message presentation', () => {
  const { presentation, events } = fixture();
  for (const event of ['message.private', 'message.group'])
    presentation.forward(event, { peer: { type: 'private', userId: '123' } });
  assert.deepEqual(events, [
    ['diagnostic', { stage: 'invalid-worker-message-alias' }],
    ['diagnostic', { stage: 'invalid-worker-message-alias' }],
  ]);
});

test('QR presentation decodes in place once and preserves the original event object', () => {
  const { presentation, events } = fixture();
  const payload = { image: Buffer.from([0, 255, 42]).toString('base64'), untouched: 'fixture' };
  presentation.forward('qrcode', payload);
  assert.equal(events[0]![1], payload);
  assert.deepEqual(payload.image, Buffer.from([0, 255, 42]));
  const buffer = payload.image;
  presentation.forward('qrcode', payload);
  assert.equal(payload.image, buffer);
  assert.equal(payload.untouched, 'fixture');
});

test('login error presentation creates Error while unrelated failures remain opaque', () => {
  const { presentation, events } = fixture();
  const raw = { message: 'fixture rejection' };
  presentation.forward('login-error', raw);
  assert.ok(events[0]![1] instanceof Error);
  assert.equal(events[0]![1].message, 'fixture rejection');
  assert.equal(raw.message, 'fixture rejection');
  presentation.forward('login-error', null);
  assert.ok(events[1]![1] instanceof Error);
  assert.equal(events[1]![1].message, 'Native login failed');
  const failure = new Error('opaque reconnect failure');
  presentation.forward('reconnect-error', failure);
  assert.equal(events[2]![1], failure);
});

test('message delivery emits one captured event then its alias with the same payload', () => {
  const { presentation, events } = fixture();
  const group = { peer: { type: 'group', groupId: '456' }, messageId: '123' };
  presentation.forward('message', group);
  assert.deepEqual(
    events.map(([name]) => name),
    ['message', 'message.group'],
  );
  assert.equal(events[0]![1], events[1]![1]);
  assert.notEqual(events[0]![1], group);
  assert.equal(Object.hasOwn(group, 'reply'), false);
  events.length = 0;
  presentation.forward('message', undefined);
  assert.deepEqual(events, [['diagnostic', { stage: 'invalid-worker-message-peer' }]]);
});

test('synchronous observer errors retain identity and stop later aliases', () => {
  const payload = { peer: { type: 'private', userId: '789' } };
  const names: string[] = [];
  const failure = new Error('observer failed');
  const presentation = createClientEventPresentation((event) => {
    names.push(event);
    if (event === 'message') payload.peer.type = 'group';
    if (event === 'message.private') throw failure;
  }, presenters);
  assert.throws(
    () => presentation.forward('message', payload),
    (error) => error === failure,
  );
  assert.deepEqual(names, ['message', 'message.private']);
  const firstFailure = createClientEventPresentation(() => {
    throw failure;
  }, presenters);
  assert.throws(
    () => firstFailure.forward('message', payload),
    (error) => error === failure,
  );
});

test('source mutation during presentation or delivery cannot change the captured peer or alias', () => {
  for (const type of ['private', 'group'] as const) {
    const other = type === 'private' ? 'group' : 'private';
    const raw = {
      peer: type === 'private' ? { type, userId: '789' } : { type, groupId: '456' },
    };
    const original = { ...raw.peer };
    let presented: MessageEvent | undefined;
    const events: [string, unknown][] = [];
    const presentation = createClientEventPresentation(
      (name, value) => {
        events.push([name, value]);
        if (name === 'message') raw.peer.type = other;
      },
      {
        ...presenters,
        message: () => {
          presented = presentMessage(raw);
          raw.peer.type = other;
          return presented;
        },
      },
    );
    presentation.forward('message', raw);
    assert.deepEqual(events, [
      ['message', presented],
      [`message.${type}`, presented],
    ]);
    assert.deepEqual(presented?.peer, original);
  }
});

test('public message aliases and reply keep the original private or group destination', async () => {
  class Worker extends ChildProcess {
    readonly calls: Record<string, unknown>[] = [];
    constructor() {
      super();
      Object.defineProperty(this, 'connected', { value: true, configurable: true });
    }
    override send(value: Serializable, ...args: unknown[]): boolean {
      assert.ok(value && typeof value === 'object');
      const request = value as Record<string, unknown>;
      this.calls.push(request);
      const callback = args.find((argument) => typeof argument === 'function');
      if (typeof callback === 'function') Reflect.apply(callback, undefined, [null]);
      queueMicrotask(() => {
        this.emit('message', {
          id: request.id,
          result: { messageId: '99', sequence: '1', time: 1 },
        });
        if (request.method === 'close') {
          Object.defineProperty(this, 'connected', { value: false, configurable: true });
          Object.defineProperty(this, 'exitCode', { value: 0, configurable: true });
          this.emit('exit', 0, null);
        }
      });
      return true;
    }
  }
  for (const type of ['private', 'group'] as const) {
    const worker = new Worker();
    const client = new QQClient(worker, 500);
    try {
      worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'self' } });
      const message: Message = {
        messageId: '42',
        sequence: '1',
        time: 1,
        peer: type === 'private' ? { type, userId: '789' } : { type, groupId: '456' },
        sender: { userId: '789', uid: 'other', nickname: 'fixture' },
        elements: [],
        raw: {},
      };
      const aliases: string[] = [];
      let event: MessageEvent | undefined;
      client.on('message', (value) => {
        event = value;
        assert.equal(
          Reflect.set(value.peer, 'type', type === 'private' ? 'group' : 'private'),
          false,
        );
        assert.equal(Reflect.set(value, 'peer', { type: 'private', userId: '999' }), false);
        message.peer = { type: 'private', userId: '999' };
      });
      client.on('message.private', (value) => {
        assert.equal(value, event);
        assert.equal(value.peer.type, 'private');
        assert.equal(value.peer.userId, '789');
        aliases.push('private');
      });
      client.on('message.group', (value) => {
        assert.equal(value, event);
        assert.equal(value.peer.type, 'group');
        assert.equal(value.peer.groupId, '456');
        aliases.push('group');
      });
      worker.emit('message', { event: 'message', payload: message });
      assert.deepEqual(aliases, [type]);
      assert.ok(event);
      await event.reply('pong');
      const request = worker.calls.at(-1);
      assert.equal(request?.method, type === 'private' ? 'sendPrivateMessage' : 'sendGroupMessage');
      assert.equal(
        request?.[type === 'private' ? 'userId' : 'groupId'],
        type === 'private' ? '789' : '456',
      );
    } finally {
      await client.close();
    }
  }
});

test('shape audit is bounded, increments retained keys, and never exposes stored arrays or arguments', () => {
  const { presentation, events } = fixture();
  const payload = { family: 'Msg', name: 'receive', argumentTypes: ['object'], args: ['private'] };
  presentation.forward('native-callback', payload);
  payload.argumentTypes[0] = 'changed';
  const snapshot = presentation.audit;
  assert.deepEqual(snapshot, [
    { family: 'Msg', name: 'receive', argumentTypes: ['object'], count: 1 },
  ]);
  snapshot[0]!.argumentTypes[0] = 'changed snapshot';
  snapshot[0]!.count = 99;
  snapshot.length = 0;
  for (let i = 0; i < 150; i++)
    presentation.forward('native-callback', {
      family: 'Session',
      name: `method${i}`,
      argumentTypes: [],
    });
  presentation.forward('native-callback', {
    family: 'Msg',
    name: 'receive',
    argumentTypes: ['object'],
  });
  presentation.forward('native-callback', { family: 'Msg', name: 'invalid', argumentTypes: [1] });
  assert.equal(presentation.audit.length, 128);
  assert.deepEqual(presentation.audit[0], {
    family: 'Msg',
    name: 'receive',
    argumentTypes: ['object'],
    count: 2,
  });
  assert.equal(events[0]![1], payload);
  assert.equal(
    presentation.audit.some((row) => row.name === 'invalid'),
    false,
  );
});
