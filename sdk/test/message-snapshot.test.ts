import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureNativeMessage,
  projectNativeMessage,
} from '../src/features/messages/inbound-messages.ts';
import type { NativeObject } from '../src/native/native-object.ts';
const row = (): NativeObject => ({
  chatType: 1,
  msgId: '1',
  msgSeq: '1',
  msgTime: '100',
  peerUid: 'u_peer',
  peerUin: '123',
  senderUid: 'u_sender',
  senderUin: '456',
  sendNickName: 'name',
  elements: [],
});
test('capture reads each known field once and never executes unrelated enumerable getters', () => {
  const source = row(),
    reads = new Map<string, number>();
  for (const [key, value] of Object.entries(source))
    Object.defineProperty(source, key, {
      enumerable: true,
      get() {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return value;
      },
    });
  Object.defineProperty(source, 'unrelated', {
    enumerable: true,
    get() {
      throw new Error('Must not run');
    },
  });
  const captured = captureNativeMessage(source);
  assert.deepEqual([...reads.values()], Array(10).fill(1));
  assert.equal(projectNativeMessage(captured, [], new Map(), source).raw, source);
  assert.equal(captured.msgId, '1');
});
test('validated first metadata read survives changing accessor and invalid captured receipt rejects', () => {
  const source = row();
  let reads = 0;
  Object.defineProperty(source, 'msgId', {
    enumerable: true,
    get() {
      return ++reads === 1 ? '1' : 'invalid';
    },
  });
  assert.equal(captureNativeMessage(source).msgId, '1');
  assert.equal(reads, 1);
  assert.throws(() => captureNativeMessage({ ...row(), msgId: 'invalid' }), /metadata/);
});
test('unknown element raw identity and known nested snapshots survive caller mutation', () => {
  const element = { elementType: 999, opaque: 'original' },
    text = { elementType: 1, textElement: { content: 'before', atType: 0 } };
  const source: NativeObject = { ...row(), elements: [element, text] };
  const captured = captureNativeMessage(source);
  text.textElement.content = 'after';
  source.msgId = '2';
  const projected = projectNativeMessage(
    captured,
    [
      { type: 'unknown', nativeType: 999, data: null },
      { type: 'text', text: 'before' },
    ],
    new Map(),
    source,
  );
  assert.equal(projected.elements[0]?.type, 'unknown');
  if (projected.elements[0]?.type === 'unknown') assert.equal(projected.elements[0].data, element);
  assert.equal(captured.elements[1].textElement.content, 'before');
  assert.equal(projected.messageId, '1');
});

test('group snapshot ignores unrelated peerUin getter and nonstring values', () => {
  for (const peerUin of [42, {}]) {
    const source = { ...row(), chatType: 2, peerUid: '789', peerUin };
    const captured = captureNativeMessage(source);
    assert.equal(captured.peerUin, undefined);
    assert.deepEqual(projectNativeMessage(captured, [], new Map()).peer, {
      type: 'group',
      groupId: '789',
    });
  }
  const source = { ...row(), chatType: 2, peerUid: '789' };
  let reads = 0;
  Object.defineProperty(source, 'peerUin', {
    get() {
      reads++;
      throw new Error('Unrelated group property');
    },
  });
  assert.equal(captureNativeMessage(source).peerUin, undefined);
  assert.equal(reads, 0);
});
