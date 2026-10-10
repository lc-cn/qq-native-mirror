import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeReceivedForward } from '../src/features/forward/received-forward.ts';
import { buildMergedForwardCard } from '../src/features/forward/merged-forward-card.ts';
const cardId = '12345678-1234-4123-8123-123456789abc';
const raw = (detail: Record<string, unknown> = {}, extra: unknown = {}) => ({
  elementType: 10,
  arkElement: {
    bytesData: JSON.stringify({
      app: 'com.tencent.multimsg',
      view: 'contact',
      meta: { detail: { resid: 'resource', ...detail } },
      extra,
    }),
  },
});
test('owned formatter roundtrip and hand JSON preserve receive-only fields without UUID requirement', () => {
  const card = buildMergedForwardCard({
    resourceId: 'r',
    cardId,
    nodes: [{ displayName: 'A', text: '中😀' }],
  });
  assert.deepEqual(decodeReceivedForward(card), {
    type: 'forward',
    format: 'ark',
    resourceId: 'r',
    cardId,
    title: '聊天记录',
    summary: '查看1条消息',
    prompt: '[聊天记录]',
    count: 1,
    previews: ['A:中😀'],
  });
  assert.deepEqual(
    decodeReceivedForward(
      raw({ uniseq: 'not-a-UUID', news: [{ text: '' }] }, { filename: 'not-a-UUID', tsum: 0 }),
    ),
    {
      type: 'forward',
      format: 'ark',
      resourceId: 'resource',
      cardId: 'not-a-UUID',
      count: 0,
      previews: [''],
    },
  );
});
test('native16 treats XML as opaque and omits empty fileName without mutating input', () => {
  const value = {
    elementType: 16,
    multiForwardMsgElement: {
      xmlContent: 'not XML <!DOCTYPE external SYSTEM "https://never.invalid">',
      resId: 'native-resource',
      fileName: '',
    },
  };
  const before = structuredClone(value);
  assert.deepEqual(decodeReceivedForward(value), {
    type: 'forward',
    format: 'native',
    resourceId: 'native-resource',
  });
  assert.deepEqual(value, before);
  assert.equal(
    decodeReceivedForward({
      ...value,
      multiForwardMsgElement: { ...value.multiForwardMsgElement, fileName: 'raw-card' },
    })?.cardId,
    'raw-card',
  );
});
test('malformed/foreign JSON, all invalid optionals, identity conflicts and bounds remain unknown', () => {
  const values = [
    raw({ resid: '' }),
    raw({ resid: 2 }),
    raw({ resid: '\ud800' }),
    raw({ resid: 'x'.repeat(4097) }),
    raw({ source: 1 }),
    raw({ summary: null }),
    raw({ uniseq: null }),
    raw({ uniseq: 'a' }, { filename: 'b' }),
    raw({ news: [{ text: 1 }] }),
    raw({ news: Array(1001).fill({ text: 'A' }) }),
    raw({}, { tsum: -1 }),
    raw({}, { tsum: 1.5 }),
    raw({}, { filename: 123 }),
    raw({}, null),
    { elementType: 10, arkElement: { bytesData: '{' } },
    {
      elementType: 10,
      arkElement: { bytesData: JSON.stringify({ app: 'other', view: 'contact' }) },
    },
    raw({ source: 'x'.repeat(1024 * 1024) }),
    { elementType: 16, multiForwardMsgElement: { resId: 'r', fileName: '', xmlContent: '\udc00' } },
    { elementType: 16, multiForwardMsgElement: { resId: 'r', fileName: 2, xmlContent: '' } },
  ];
  for (const value of values) assert.equal(decodeReceivedForward(value), undefined);
});
test('getters, inherited fields and coercions are never invoked', () => {
  let calls = 0;
  const getter = {
    get elementType() {
      calls++;
      return 10;
    },
  };
  assert.equal(decodeReceivedForward(getter), undefined);
  const native = {
    elementType: 16,
    multiForwardMsgElement: {
      resId: {
        toString() {
          calls++;
          return 'r';
        },
      },
      xmlContent: '',
      fileName: '',
    },
  };
  assert.equal(decodeReceivedForward(native), undefined);
  const ark = {
    elementType: 10,
    arkElement: {
      get bytesData() {
        calls++;
        return raw().arkElement.bytesData;
      },
    },
  };
  assert.equal(decodeReceivedForward(ark), undefined);
  assert.equal(decodeReceivedForward(Object.create(raw())), undefined);
  assert.equal(calls, 0);
});

test('native UTF8 boundaries accept exact limits and reject overflow', () => {
  const value = {
    elementType: 16,
    multiForwardMsgElement: {
      resId: 'r'.repeat(4096),
      fileName: 'f'.repeat(4096),
      xmlContent: 'x'.repeat(1024 * 1024),
    },
  };
  assert.equal(decodeReceivedForward(value)?.resourceId.length, 4096);
  assert.equal(
    decodeReceivedForward({
      ...value,
      multiForwardMsgElement: {
        ...value.multiForwardMsgElement,
        xmlContent: value.multiForwardMsgElement.xmlContent + 'x',
      },
    }),
    undefined,
  );
});

test('empty optional ARK identifiers are absent, nonempty alternative supplies cardId', () => {
  assert.equal(
    decodeReceivedForward(raw({ uniseq: '' }, { filename: 'fallback' }))?.cardId,
    'fallback',
  );
  assert.equal(
    decodeReceivedForward(raw({ uniseq: 'fallback' }, { filename: '' }))?.cardId,
    'fallback',
  );
  assert.deepEqual(decodeReceivedForward(raw({ uniseq: '' }, { filename: '' })), {
    type: 'forward',
    format: 'ark',
    resourceId: 'resource',
  });
  assert.equal(decodeReceivedForward(raw({ uniseq: 'a' }, { filename: 'b' })), undefined);
});
