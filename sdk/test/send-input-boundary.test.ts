import assert from 'node:assert/strict';
import test from 'node:test';
import { captureSendInput } from '../src/features/messages/send-input.ts';
import { createNativeMessageSender } from '../src/features/messages/native-message-sender.ts';
import { createNativeEventChannel } from '../src/runtime/native-event-channel.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';
function senderFixture() {
  const life = new NativeServiceLifetime(),
    channel = createNativeEventChannel(life.signal);
  let effects = 0;
  const sender = createNativeMessageSender({
    signal: life.signal,
    awaitAlive: life.awaitAlive,
    eventCall: channel.call,
    uidFor: async () => {
      effects++;
      return 'u_friend';
    },
    getMessageService() {
      effects++;
      throw Error('unexpected preparation');
    },
    getServerTimeService() {
      effects++;
      throw Error('unexpected server time');
    },
  });
  return {
    sender,
    effects: () => effects,
    close() {
      sender.close();
      channel.close();
      life.close();
    },
  };
}
for (const [type, field, first, second] of [
  ['text', 'text', 'valid', 42],
  ['face', 'id', 1, 'bad'],
  ['reply', 'messageId', '00042', {}],
  ['file', 'file', '/file', 42],
  ['at', 'userId', '123', {}],
  ['at', 'text', 'label', 42],
] as const) {
  test(`send input ${type}.${field} accessor is rejected before recipient or preparation`, async () => {
    let reads = 0;
    const raw = Object.defineProperty(
      { type, text: 'label', userId: '123', file: '/file' },
      field,
      {
        get() {
          return ++reads === 1 ? first : second;
        },
      },
    );
    const f = senderFixture();
    try {
      await assert.rejects(f.sender.sendGroupMessage('123', [raw]));
      assert.equal(reads, 0);
      assert.equal(f.effects(), 0);
    } finally {
      f.close();
    }
  });
}
test('send input captures own dense array slots without invoking custom iterator', () => {
  let iterations = 0;
  const input = [{ type: 'text', text: 'original' }];
  Object.defineProperty(input, Symbol.iterator, {
    value() {
      iterations++;
      return [{ type: 'text', text: 'replacement' }][Symbol.iterator]();
    },
  });
  assert.deepEqual(captureSendInput(input, true), [{ type: 'text', text: 'original' }]);
  assert.equal(iterations, 0);
});
test('send input rejects sparse, inherited and accessor array slots without execution', () => {
  let reads = 0;
  const getter = Object.defineProperty(new Array(1), '0', {
    get() {
      reads++;
      return { type: 'text', text: 'valid' };
    },
  });
  const inherited = new Array(1);
  Object.setPrototypeOf(inherited, {
    0: { type: 'text', text: 'inherited' },
    [Symbol.iterator]: Array.prototype[Symbol.iterator],
  });
  for (const input of [new Array(1), getter, inherited])
    assert.throws(() => captureSendInput(input, true));
  assert.equal(reads, 0);
});
test('send input rejects inherited selected fields and opaque discriminator without coercion', () => {
  let coercions = 0;
  assert.throws(() => captureSendInput([Object.create({ type: 'text', text: 'inherited' })], true));
  assert.throws(() =>
    captureSendInput(
      [
        {
          type: {
            toString() {
              coercions++;
              throw Error('sensitive');
            },
          },
        },
      ],
      true,
    ),
  );
  assert.equal(coercions, 0);
});
test('send input preserves legal variants, nullish mention alias, empty text and leading-zero reply', () => {
  const input = [
    { type: 'text', text: '' },
    { type: 'at', userId: null, id: '00123', text: '' },
    { type: 'at', id: 'all' },
    { type: 'face', id: 1 },
    { type: 'reply', messageId: '00042' },
    { type: 'image', file: '/image' },
    { type: 'video', file: '/video' },
    { type: 'record', file: '/record' },
    { type: 'file', file: '/file', name: 'name' },
  ];
  assert.deepEqual(captureSendInput(input, true), [
    { type: 'text', text: '' },
    { type: 'at', userId: '00123', text: '' },
    { type: 'at', userId: 'all' },
    ...input.slice(3),
  ]);
  assert.deepEqual(captureSendInput('', false), [{ type: 'text', text: '' }]);
  assert.throws(() => captureSendInput([{ type: 'at', id: '123' }], false), /Mentions require/);
});
test('send input ignores irrelevant mention alias and image name accessors', () => {
  let reads = 0;
  const getter = {
    get() {
      reads++;
      throw Error('irrelevant getter');
    },
  };
  const mention = Object.defineProperty({ type: 'at', userId: '00123' }, 'id', getter);
  const image = Object.defineProperty({ type: 'image', file: '/image' }, 'name', getter);
  assert.deepEqual(captureSendInput([mention, image], true), [
    { type: 'at', userId: '00123' },
    { type: 'image', file: '/image' },
  ]);
  assert.equal(reads, 0);
});
test('send input rejects selected type, optional name/text and array accessors without executing them', () => {
  let reads = 0;
  const getter = {
    get() {
      reads++;
      throw Error('selected getter');
    },
  };
  const discriminator = Object.defineProperty({ text: 'hello' }, 'type', getter);
  const file = Object.defineProperty({ type: 'file', file: '/file' }, 'name', getter);
  const mention = Object.defineProperty({ type: 'at', userId: '123' }, 'text', getter);
  for (const raw of [discriminator, file, mention])
    assert.throws(() => captureSendInput([raw], true));
  assert.throws(() => captureSendInput(Object.defineProperty(new Array(1), '0', getter), true));
  assert.equal(reads, 0);
});
test('send input accepts own-data class instances and null-prototype elements', () => {
  class TextElement {
    type = 'text';
    text = 'class';
  }
  const plain = Object.assign(Object.create(null) as Record<string, unknown>, {
    type: 'text',
    text: 'null prototype',
  });
  assert.deepEqual(captureSendInput([new TextElement(), plain], true), [
    { type: 'text', text: 'class' },
    { type: 'text', text: 'null prototype' },
  ]);
});
