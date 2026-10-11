import assert from 'node:assert/strict';
import test from 'node:test';
import { captureMergedForward } from '../src/features/forward/merged-forward-input.ts';
import { createForwardResourceOwner } from '../src/features/forward/forward-resource-owner.ts';
const peer = { type: 'group', groupId: '000123' };
const node = () => ({ userId: '456', nickname: 'fixture', time: 1, text: 'text' });
function iterator(input: unknown[], replacement: unknown[]) {
  let calls = 0;
  Object.defineProperty(input, Symbol.iterator, {
    value() {
      calls++;
      return replacement[Symbol.iterator]();
    },
  });
  return () => calls;
}
test('merged forward ignores custom iterator and captures original dense nodes', () => {
  const original = node(),
    input = [original];
  const calls = iterator(input, [{ ...node(), text: 'replacement' }]);
  assert.deepEqual(captureMergedForward(peer, input).nodes, [original]);
  assert.equal(calls(), 0);
});
test('merged forward cannot hide malformed later own node before resolve or upload', async () => {
  const input = [node(), { ...node(), time: 'bad' }];
  const calls = iterator(input, [node()]);
  let effects = 0;
  const controller = new AbortController(),
    cleanup: (() => void)[] = [];
  const owner = createForwardResourceOwner({
    selfUid: 'u_self',
    signal: controller.signal,
    resolvePeer: async () => {
      effects++;
      return { chatType: 2, peerUid: '123' };
    },
    getMessageService() {
      effects++;
      throw Error('no upload');
    },
    sendPrepared: async () => {
      effects++;
      throw Error('no card');
    },
    defer: (value) => cleanup.push(value),
  });
  try {
    await assert.rejects(owner.sendMerged(peer, input, {}));
    assert.equal(effects, 0);
    assert.equal(calls(), 0);
  } finally {
    for (const close of cleanup) close();
  }
});
test('merged forward rejects accessor, sparse and inherited node slots without getter reads', () => {
  let reads = 0;
  const accessor = Object.defineProperty(new Array(1), '0', {
    get() {
      reads++;
      return node();
    },
  });
  const inherited = new Array(1);
  Object.setPrototypeOf(inherited, {
    0: node(),
    [Symbol.iterator]: Array.prototype[Symbol.iterator],
  });
  for (const input of [accessor, new Array(1), inherited])
    assert.throws(() => captureMergedForward(peer, input));
  assert.equal(reads, 0);
});
test('merged forward captures checked own descriptors without ordinary Proxy get reads', () => {
  let reads = 0;
  const proxy = <T extends object>(value: T): T =>
    new Proxy(value, {
      get() {
        reads++;
        throw Error('ordinary get must not execute');
      },
    });
  const captured = captureMergedForward(
    proxy(peer),
    [proxy(node())],
    proxy({ title: 'title', summary: 'summary', prompt: 'prompt' }),
  );
  assert.deepEqual(captured, {
    peer,
    nodes: [node()],
    options: { title: 'title', summary: 'summary', prompt: 'prompt' },
  });
  assert.equal(reads, 0);
});
test('merged forward retains strict fields/prototypes, uint32 bounds and writer validation', () => {
  const captured = captureMergedForward(
    { type: 'group', groupId: '4294967295' },
    [{ userId: '4294967295', nickname: 'n', time: 1, text: 'text' }],
    { title: 't' },
  );
  assert.equal(captured.peer.type, 'group');
  assert.deepEqual(captured.nodes, [
    { userId: '4294967295', nickname: 'n', time: 1, text: 'text' },
  ]);
  assert.deepEqual(captured.options, { title: 't' });
  assert.throws(() => captureMergedForward({ type: 'group', groupId: '4294967296' }, [node()]));
  for (const invalid of [
    { ...node(), userId: '4294967296' },
    { ...node(), userId: '0' },
    { ...node(), nickname: 1 },
    { ...node(), time: -1 },
    { ...node(), text: 42 },
    { ...node(), extra: true },
    Object.create(node()),
  ])
    assert.throws(() => captureMergedForward(peer, [invalid]));
  let reads = 0;
  const options = Object.defineProperty({}, 'title', {
    get() {
      reads++;
      return 'title';
    },
  });
  assert.throws(() => captureMergedForward(peer, [node()], options));
  assert.equal(reads, 0);
  const nullNode = Object.assign(Object.create(null) as Record<string, unknown>, node());
  assert.deepEqual(captureMergedForward(peer, [nullNode]).nodes, [node()]);
});
test('merged forward preserves original array count and writer/card validation limits', () => {
  for (const length of [1, 100]) {
    const input = Array.from({ length }, node);
    const calls = iterator(input, []);
    assert.equal(captureMergedForward(peer, input).nodes.length, length);
    assert.equal(calls(), 0);
  }
  assert.throws(() => captureMergedForward(peer, Array.from({ length: 101 }, node)));
  for (const field of ['nickname', 'text'] as const) {
    for (const value of ['', '\ud800'])
      assert.throws(() => captureMergedForward(peer, [{ ...node(), [field]: value }]));
  }
  for (const field of ['title', 'summary', 'prompt'])
    assert.throws(() => captureMergedForward(peer, [node()], { [field]: undefined }));
});
