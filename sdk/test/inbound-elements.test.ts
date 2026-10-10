import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeElements } from '../src/features/messages/inbound-elements.ts';

test('inbound decode preserves all media and unknown element payloads', () => {
  const native = [
    { elementType: 6, faceElement: { faceIndex: 1 } },
    { elementType: 7, replyElement: { replayMsgId: '9' } },
    { elementType: 2, picElement: { filePath: '/tmp/x.png' } },
    { elementType: 4, pttElement: { fileUuid: 'opaque' } },
    { elementType: 3, fileElement: { fileName: 'attachment' } },
  ];
  const result = decodeElements(native);
  assert.deepEqual(result.slice(0, 3), [
    { type: 'face', id: 1 },
    { type: 'reply', messageId: '9' },
    { type: 'image', file: '/tmp/x.png' },
  ]);
  assert.deepEqual(result[3], { type: 'unknown', nativeType: 4, data: native[3] });
  assert.deepEqual(result[4], { type: 'unknown', nativeType: 3, data: native[4] });
  assert.equal(result.length, native.length);
});

test('inbound file video and record local paths retain element identifiers', () => {
  assert.deepEqual(
    decodeElements([
      {
        elementType: 3,
        elementId: '1',
        fileElement: { filePath: '/tmp/a.txt', fileName: 'a.txt', fileSize: '5' },
      },
      { elementType: 5, elementId: '2', videoElement: { filePath: '/tmp/a.mp4' } },
      { elementType: 4, elementId: '3', pttElement: { filePath: '/tmp/a.silk' } },
    ]),
    [
      { type: 'file', file: '/tmp/a.txt', elementId: '1', name: 'a.txt', size: '5' },
      { type: 'video', file: '/tmp/a.mp4', elementId: '2' },
      { type: 'record', file: '/tmp/a.silk', elementId: '3' },
    ],
  );
});

test('inbound mentions preserve decimal identity and correct signed int32 IDs without Number truncation', () => {
  assert.deepEqual(
    decodeElements([
      { elementType: 1, textElement: { atType: 1, content: '@all' } },
      { elementType: 1, textElement: { atType: 2, atUid: '-1', content: '@friend' } },
      {
        elementType: 1,
        textElement: { atType: 2, atUid: '900719925474099312345', content: '@long' },
      },
    ]),
    [
      { type: 'at', userId: 'all', text: '@all' },
      { type: 'at', userId: '4294967295', text: '@friend' },
      { type: 'at', userId: '900719925474099312345', text: '@long' },
    ],
  );
});

test('unresolved, unsupported or malformed mentions retain their native element instead of false IDs or plain text', () => {
  for (const textElement of [
    { atType: 2, content: '@friend' },
    { atType: 2, atUid: '0', atNtUid: 'u_friend', content: '@friend' },
    { atType: 2, atUid: {}, content: '@friend' },
    { atType: 2, atUid: '1.2', content: '@friend' },
    { atType: 2, atUid: '-2147483649', content: '@friend' },
    { atType: 512, atUid: '456', content: '@category' },
    { atType: 8, atUid: '456', content: '@role' },
    { atType: 2, atUid: '456', content: {} },
  ]) {
    const raw = { elementType: 1, textElement };
    assert.deepEqual(decodeElements([raw]), [{ type: 'unknown', nativeType: 1, data: raw }]);
  }
});
