import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import {
  buildTextForwardPayload,
  buildTextForwardRequest,
  type TextForwardInput,
} from '../src/features/forward/long-message-request.ts';
// Independent test reader: BigInt accumulator, separate from production writer.
function fields(data: Buffer) {
  let cursor = 0;
  const result = new Map<number, Array<bigint | Buffer>>();
  const integer = () => {
    let n = 0n,
      shift = 0n;
    for (let i = 0; i < 10; i++) {
      assert.ok(cursor < data.length, 'truncated varint');
      const byte = data[cursor++];
      n |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return n;
      shift += 7n;
    }
    throw Error('overflow');
  };
  while (cursor < data.length) {
    const tag = integer(),
      id = Number(tag >> 3n),
      wire = Number(tag & 7n);
    assert.ok(id > 0);
    let value: bigint | Buffer;
    if (wire === 0) value = integer();
    else {
      assert.equal(wire, 2);
      const length = Number(integer());
      assert.ok(cursor + length <= data.length, 'truncated length');
      value = data.subarray(cursor, cursor + length);
      cursor += length;
    }
    result.set(id, [...(result.get(id) ?? []), value]);
  }
  return result;
}
const nested = (m: ReturnType<typeof fields>, id: number) => fields(m.get(id)![0] as Buffer);
const scalar = (m: ReturnType<typeof fields>, id: number) => m.get(id)![0];
const utf = (m: ReturnType<typeof fields>, id: number) =>
  (m.get(id)![0] as Buffer).toString('utf8');
const sample: TextForwardInput = {
  selfUid: 'u_fixture',
  target: { type: 'private' },
  nodes: [
    {
      senderUin: 0xffffffff,
      displayName: 'Alice中',
      timeSeconds: 0xffffffff,
      text: 'A中😀',
      sequence: 0xffffffff,
    },
  ],
};
test('whole private/group request decodes independently with exact authors, UTF8, settings and deterministic gzip', () => {
  for (const target of [
    { type: 'private' } as const,
    { type: 'group', groupUin: 0xffffffff } as const,
  ]) {
    const input = { ...sample, target },
      request = buildTextForwardRequest(input);
    assert.equal(request.command, 'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg');
    assert.deepEqual(request, buildTextForwardRequest(input));
    const outer = fields(request.data),
      info = nested(outer, 2);
    assert.equal(scalar(info, 1), target.type === 'private' ? 1n : 3n);
    assert.equal(utf(nested(info, 2), 2), target.type === 'private' ? 'u_fixture' : '4294967295');
    assert.equal(scalar(info, 3), target.type === 'private' ? 0n : 4294967295n);
    const compressed = scalar(info, 4) as Buffer;
    assert.equal(compressed.readUInt32LE(4), 0, 'gzip mtime is deterministic zero');
    const raw = gunzipSync(compressed);
    assert.deepEqual(raw, buildTextForwardPayload(input));
    const action = nested(fields(raw), 2);
    assert.equal(utf(action, 1), 'MultiMsg');
    const nodes = nested(action, 2).get(1)!;
    assert.equal(nodes.length, 1);
    const record = fields(nodes[0] as Buffer),
      author = nested(record, 1),
      content = nested(record, 2);
    assert.equal(scalar(author, 1), 4294967295n);
    assert.equal(utf(author, 2), '');
    assert.equal(scalar(content, 5), 4294967295n);
    assert.equal(scalar(content, 6), 4294967295n);
    assert.equal(scalar(content, 1), target.type === 'private' ? 9n : 82n);
    const forward = nested(content, 15);
    assert.equal(scalar(forward, 3), target.type === 'private' ? 2n : 1n);
    assert.equal(utf(forward, 5), utf(forward, 6));
    if (target.type === 'private') {
      assert.equal(utf(author, 6), 'u_fixture');
      assert.equal(utf(nested(author, 7), 6), 'Alice中');
      assert.equal(scalar(content, 2), 4n);
      assert.equal(scalar(content, 9), 4n);
      assert.ok(!author.has(8));
    } else {
      const group = nested(author, 8);
      assert.equal(scalar(group, 1), 4294967295n);
      assert.equal(utf(group, 4), 'Alice中');
      assert.equal(scalar(group, 5), 2n);
      assert.ok(!author.has(6) && !author.has(7) && !content.has(2) && !content.has(9));
    }
    const rich = nested(nested(record, 3), 1),
      element = fields(rich.get(2)![0] as Buffer);
    assert.equal(utf(nested(element, 1), 1), 'A中😀');
    const settings = nested(outer, 15);
    assert.deepEqual(
      [...settings.entries()],
      [
        [1, [4n]],
        [2, [1n]],
        [3, [7n]],
        [4, [0n]],
      ],
    );
  }
});
test('hand-constructed elementary text bytes appear in payload; multiple nodes preserve order', () => {
  const input = {
    ...sample,
    nodes: [
      { ...sample.nodes[0], text: 'A', sequence: 0 },
      { ...sample.nodes[0], text: '中', sequence: 1 },
    ],
  };
  const raw = buildTextForwardPayload(input);
  assert.ok(raw.includes(Buffer.from('0a0712050a030a0141', 'hex')));
  assert.ok(raw.includes(Buffer.from('0a0912070a050a03e4b8ad', 'hex')));
  const records = nested(nested(fields(raw), 2), 2).get(1)!;
  assert.deepEqual(
    records.map((v) => scalar(nested(fields(v as Buffer), 2), 5)),
    [0n, 1n],
  );
});
test('strict dense whole-input validation refuses malformed strings, overflow and media before encoding', () => {
  const changes: Array<(v: any) => void> = [
    (v) => (v.nodes = Array(1)),
    (v) => (v.nodes = []),
    (v) => (v.nodes = Array(101).fill(sample.nodes[0])),
    (v) => (v.nodes[0].senderUin = 0),
    (v) => (v.nodes[0].senderUin = 2 ** 32),
    (v) => (v.nodes[0].sequence = -1),
    (v) => (v.nodes[0].timeSeconds = 1.5),
    (v) => (v.nodes[0].text = '\ud800'),
    (v) => (v.nodes[0].displayName = '\udc00'),
    (v) => (v.selfUid = '\ud800'),
    (v) => (v.nodes[0].image = 'photo'),
    (v) => (v.target = { type: 'group', groupUin: 0 }),
    (v) => (v.target = { type: 'private', groupUin: 1 }),
    (v) => (v.extra = true),
    (v) => (v.nodes[0].text = 'x'.repeat(1024 * 1024 + 1)),
    (v) =>
      (v.nodes = [
        { ...sample.nodes[0], text: 'x'.repeat(600000) },
        { ...sample.nodes[0], text: 'x'.repeat(600000) },
      ]),
    (v) => (v.nodes[0].text = 'x'.repeat(1024 * 1024)),
  ];
  for (const change of changes) {
    const input = structuredClone(sample);
    change(input);
    assert.throws(() => buildTextForwardRequest(input));
    assert.throws(() => buildTextForwardPayload(input));
  }
});
