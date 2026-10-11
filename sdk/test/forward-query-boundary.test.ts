import assert from 'node:assert/strict';
import test from 'node:test';
import { createForwardMessages } from '../src/features/forward/forward-messages.ts';
import type { Message } from '../src/contracts/messages.ts';
const row = (msgId = '00042', chatType = 1) => ({
  msgId,
  chatType,
  elements: [{}],
  opaque: { marker: true },
});
function fixture(
  response: unknown,
  decode?: (
    messages: Record<string, unknown>[],
    raw?: unknown[],
  ) => Promise<(Message | undefined)[]>,
) {
  let decodes = 0,
    calls = 0;
  const controller = new AbortController();
  const service = {
    getMultiMsg() {
      assert.equal(this, service);
      calls++;
      return response;
    },
  };
  const owner = createForwardMessages({
    signal: controller.signal,
    awaitAlive: async (value) => value,
    getMessageService: () => service,
    resolvePeer: async () => ({ chatType: 2, peerUid: '123' }),
    decodeMessage: () => {
      throw Error('batch decoder expected');
    },
    decodeMessages: async (messages, raw) => {
      decodes++;
      return decode ? decode(messages, raw) : [];
    },
  });
  return {
    owner,
    calls: () => calls,
    decodes: () => decodes,
    query: () =>
      owner.invokeOperation('getForwardMessages', {
        peer: { type: 'group', groupId: '123' },
        rootMessageId: '42',
        parentMessageId: '0',
      }),
  };
}
for (const field of ['result', 'msgList', 'msgId', 'chatType', 'elements']) {
  test(`forward query selected ${field} accessor rejects before decode without executing it`, async () => {
    let reads = 0;
    const raw = row(),
      response = { result: 0, msgList: [raw] };
    Object.defineProperty(field === 'result' || field === 'msgList' ? response : raw, field, {
      get() {
        reads++;
        throw Error('sensitive getter');
      },
    });
    const f = fixture(response);
    try {
      await assert.rejects(f.query());
      assert.equal(reads, 0);
      assert.equal(f.decodes(), 0);
      assert.equal(f.calls(), 1);
    } finally {
      f.owner.close();
    }
  });
}
for (const elements of [false, true]) {
  test(`forward query ${elements ? 'element' : 'row'} dense own slots reject accessors and ignore hiding iterator`, async () => {
    let reads = 0,
      iterations = 0;
    const accessor = Object.defineProperty(new Array(1), '0', {
      get() {
        reads++;
        return elements ? {} : row();
      },
    });
    const hidden: unknown[] = elements ? [{}, null] : [row(), null];
    Object.defineProperty(hidden, Symbol.iterator, {
      value() {
        iterations++;
        return (elements ? [{}] : [row()])[Symbol.iterator]();
      },
    });
    for (const data of [accessor, hidden, new Array(1)]) {
      const f = fixture({ result: 0, msgList: elements ? [{ ...row(), elements: data }] : data });
      try {
        await assert.rejects(f.query());
        assert.equal(f.decodes(), 0);
      } finally {
        f.owner.close();
      }
    }
    assert.equal(reads, 0);
    assert.equal(iterations, 0);
  });
}
test('forward query validates entire mixed-source batch before decoding', async () => {
  const f = fixture({ result: 0, msgList: [row(), { ...row('9', 2), elements: [null] }] });
  try {
    await assert.rejects(f.query());
    assert.equal(f.decodes(), 0);
  } finally {
    f.owner.close();
  }
});
test('forward decoder receives stable selected snapshot and original raw identities in native order', async () => {
  const originals = [row('00042', 1), row('900719925474099312345', 2)];
  const ids = originals.map((value) => value.msgId),
    element = originals[0]!.elements[0],
    opaque = originals[0]!.opaque;
  const f = fixture({ result: 0, msgList: originals }, async (messages, raw) => {
    assert.deepEqual(raw, originals);
    assert.equal(raw?.[0], originals[0]);
    assert.notEqual(messages[0], originals[0]);
    originals[0]!.msgId = '99';
    originals[0]!.chatType = 2;
    originals[0]!.elements.length = 0;
    assert.equal(messages[0]?.msgId, '00042');
    assert.equal(messages[0]?.chatType, 1);
    assert.deepEqual(messages[0]?.elements, [element]);
    assert.equal(messages[0]?.opaque, opaque);
    assert.deepEqual(
      messages.map((value) => value.msgId),
      ids,
    );
    return [];
  });
  try {
    await assert.rejects(f.query(), /Invalid decoded forwarded message batch/);
    assert.equal(f.decodes(), 1);
  } finally {
    f.owner.close();
  }
});
