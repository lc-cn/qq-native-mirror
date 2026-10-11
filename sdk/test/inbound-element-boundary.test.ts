import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeElements, mentionLookupUid } from '../src/features/messages/inbound-elements.ts';
function unknown(raw: object) {
  const decoded = decodeElements([raw])[0];
  assert.equal(decoded?.type, 'unknown');
  if (decoded?.type === 'unknown') assert.equal(decoded.data, raw);
}
for (const location of ['top', 'nested'] as const) {
  test(`inbound ${location} accessor stays unknown without executing getter`, () => {
    let reads = 0;
    const text =
      location === 'nested'
        ? Object.defineProperty({}, 'content', {
            get() {
              reads++;
              throw Error('getter must not run');
            },
          })
        : { content: 'hello', atType: 0 };
    const raw =
      location === 'top'
        ? Object.defineProperty({ elementType: 1 }, 'textElement', {
            get() {
              reads++;
              throw Error('getter must not run');
            },
          })
        : { elementType: 1, textElement: text };
    assert.equal(mentionLookupUid(raw), undefined);
    unknown(raw);
    assert.equal(reads, 0);
  });
}
for (const field of ['fileName', 'fileSize'] as const) {
  test(`inbound invalid ${field} preserves unknown instead of typed file`, () => {
    for (const value of [42, {}, null])
      unknown({
        elementType: 3,
        elementId: 'id',
        fileElement: { filePath: '/file', fileName: 'name', fileSize: '12', [field]: value },
      });
  });
}
test('inbound media and reply identifiers never coerce unknown values', () => {
  let coercions = 0;
  const hostile = {
    toString() {
      coercions++;
      throw Error('no coercion');
    },
    valueOf() {
      coercions++;
      throw Error('no coercion');
    },
  };
  for (const field of ['fileElement', 'videoElement', 'pttElement']) {
    for (const elementId of [42, hostile])
      unknown({ elementType: 3, elementId, [field]: { filePath: '/file' } });
  }
  for (const replayMsgId of [42, hostile])
    unknown({ elementType: 7, replyElement: { replayMsgId } });
  assert.equal(coercions, 0);
});
test('inbound legal variants and absent file metadata preserve compatibility', () => {
  const raw = [
    { elementType: 1, textElement: { content: 'hello', atType: 0 } },
    { elementType: 1, textElement: { content: '@all', atType: 1 } },
    { elementType: 2, picElement: { filePath: '', sourcePath: '/image' } },
    { elementType: 6, faceElement: { faceIndex: 12 } },
    { elementType: 7, replyElement: { replayMsgId: '42' } },
    {
      elementType: 3,
      elementId: 'id',
      fileElement: { filePath: '/file', fileName: 'name', fileSize: '12' },
    },
    { elementType: 3, fileElement: { filePath: '/bare' } },
  ];
  assert.deepEqual(decodeElements(raw), [
    { type: 'text', text: 'hello' },
    { type: 'at', userId: 'all', text: '@all' },
    { type: 'image', file: '/image' },
    { type: 'face', id: 12 },
    { type: 'reply', messageId: '42' },
    { type: 'file', file: '/file', elementId: 'id', name: 'name', size: '12' },
    { type: 'file', file: '/bare', elementId: '', name: undefined, size: undefined },
  ]);
  const mention = {
    elementType: 1,
    textElement: { content: '@friend', atType: 2, atUid: '0', atNtUid: 'u_friend' },
  };
  assert.equal(mentionLookupUid(mention), 'u_friend');
  assert.deepEqual(decodeElements([mention], new Map([['u_friend', '123']])), [
    { type: 'at', userId: '123', text: '@friend' },
  ]);
});
test('inbound sparse and nonobject elements remain malformed', () => {
  assert.throws(() => decodeElements(new Array(1)), /Invalid native message element/);
  for (const value of [null, undefined, 42, 'text', []])
    assert.throws(() => decodeElements([value]), /Invalid native message element/);
});

for (const [carrier, field] of [
  ['fileElement', 'filePath'],
  ['fileElement', 'fileName'],
  ['fileElement', 'fileSize'],
  ['replyElement', 'replayMsgId'],
  ['faceElement', 'faceIndex'],
  ['textElement', 'atType'],
] as const) {
  test(`inbound nested ${carrier}.${field} accessor remains untouched`, () => {
    let reads = 0;
    const nested = Object.defineProperty(
      {
        filePath: '/file',
        fileName: 'name',
        fileSize: '12',
        content: '@friend',
        atUid: '0',
        atNtUid: 'u_friend',
      },
      field,
      {
        get() {
          reads++;
          throw Error('sensitive getter');
        },
      },
    );
    const raw = { elementType: 1, elementId: 'id', [carrier]: nested };
    unknown(raw);
    assert.equal(mentionLookupUid(raw), undefined);
    assert.equal(reads, 0);
  });
}
test('inbound media elementId accessor remains untouched and null retains empty default', () => {
  let reads = 0;
  const raw = Object.defineProperty(
    { elementType: 3, fileElement: { filePath: '/file' } },
    'elementId',
    {
      get() {
        reads++;
        throw Error('sensitive getter');
      },
    },
  );
  unknown(raw);
  assert.equal(reads, 0);
  assert.deepEqual(
    decodeElements([{ elementType: 3, elementId: null, fileElement: { filePath: '/file' } }]),
    [{ type: 'file', file: '/file', elementId: '', name: undefined, size: undefined }],
  );
});
for (const field of ['atUid', 'atNtUid'] as const) {
  test(`inbound text ${field} accessor is unknown even for ordinary/all text`, () => {
    let reads = 0;
    for (const atType of [0, 1]) {
      const textElement = Object.defineProperty({ content: 'text', atType }, field, {
        get() {
          reads++;
          throw Error('sensitive mention getter');
        },
      });
      unknown({ elementType: 1, textElement });
    }
    assert.equal(reads, 0);
  });
}
