import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessageQueries } from '../src/features/messages/message-queries.ts';
import {
  queryNativeMessage,
  queryNativeMessages,
  queryNativeHistory,
  type MessageQueryPort,
} from '../src/features/messages/message-query.ts';
const peer = () => ({ chatType: 2 as const, peerUid: '123' });
const row = (msgId = '00042') => ({ msgId, chatType: 2, peerUid: '123', elements: [{}] });
function fixture(response: unknown) {
  let calls = 0;
  const port: MessageQueryPort = {
    getMsgsByMsgId() {
      assert.equal(this, port);
      calls++;
      return response;
    },
    getMsgsIncludeSelf() {
      assert.equal(this, port);
      calls++;
      return response;
    },
  };
  return { port, calls: () => calls };
}
const queries = {
  single: (port: MessageQueryPort) => queryNativeMessage(port, peer(), '00042'),
  batch: (port: MessageQueryPort) => queryNativeMessages(port, peer(), ['00042']),
  history: (port: MessageQueryPort) => queryNativeHistory(port, peer(), '0', 20, false),
};
for (const [name, query] of Object.entries(queries)) {
  test(`query ${name} refuses selected accessors without executing them`, async () => {
    for (const field of ['result', 'msgList', 'msgId', 'chatType', 'peerUid', 'elements']) {
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
      await assert.rejects(query(f.port));
      assert.equal(reads, 0, field);
      assert.equal(f.calls(), 1);
    }
  });
}
test('query native array accessor slots are rejected without reads', async () => {
  for (const elements of [false, true]) {
    let reads = 0;
    const array = Object.defineProperty(new Array(1), '0', {
      get() {
        reads++;
        return elements ? {} : row();
      },
    });
    const f = fixture({ result: 0, msgList: elements ? [{ ...row(), elements: array }] : array });
    await assert.rejects(queryNativeMessage(f.port, peer(), '00042'));
    assert.equal(reads, 0);
  }
});
test('query row and element iterators cannot conceal invalid own slots', async () => {
  for (const elements of [false, true]) {
    let iterations = 0;
    const array: unknown[] = elements ? [{}, null] : [row(), null];
    Object.defineProperty(array, Symbol.iterator, {
      value() {
        iterations++;
        return (elements ? [{}] : [row()])[Symbol.iterator]();
      },
    });
    const f = fixture({ result: 0, msgList: elements ? [{ ...row(), elements: array }] : array });
    await assert.rejects(queryNativeHistory(f.port, peer(), '0', 20, false));
    assert.equal(iterations, 0);
  }
});
test('query single expected conversation is isolated from caller and vendor mutation', async () => {
  for (const callerMutation of [false, true]) {
    const target = peer();
    let resolve!: (value: unknown) => void;
    const response = new Promise<unknown>((yes) => {
      resolve = yes;
    });
    const port: MessageQueryPort = {
      getMsgsByMsgId(destination) {
        if (!callerMutation) destination.peerUid = '999';
        return response;
      },
    };
    const pending = queryNativeMessage(port, target, '00042');
    if (callerMutation) target.peerUid = '999';
    resolve({ result: 0, msgList: [{ ...row(), peerUid: '999' }] });
    await assert.rejects(pending, /mismatched/);
  }
});
for (const history of [false, true]) {
  test(`query ${history ? 'history' : 'ID'} method captured once preserves receiver`, async () => {
    let reads = 0,
      calls = 0;
    const port: MessageQueryPort = {};
    Object.defineProperty(port, history ? 'getMsgsIncludeSelf' : 'getMsgsByMsgId', {
      get() {
        reads++;
        return function (this: MessageQueryPort) {
          assert.equal(this, port);
          calls++;
          return { result: 0, msgList: [row()] };
        };
      },
    });
    await (history
      ? queryNativeHistory(port, peer(), '0', 20, false)
      : queryNativeMessage(port, peer(), '00042'));
    assert.equal(reads, 1);
    assert.equal(calls, 1);
  });
}
test('query retains negative code, successful empty/missing and native history order', async () => {
  const f = fixture({ result: -7, errMsg: 'sensitive native wording' });
  await assert.rejects(queryNativeMessage(f.port, peer(), '00042'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(Object.getOwnPropertyDescriptor(error, 'code')?.value, -7);
    assert.equal(error.message.includes('sensitive'), false);
    return true;
  });
  const empty = fixture({ result: 0, msgList: [] });
  assert.equal(await queryNativeMessage(empty.port, peer(), '00042'), undefined);
  assert.deepEqual(await queryNativeMessages(empty.port, peer(), ['00042', '9']), [
    undefined,
    undefined,
  ]);
  const reversed = fixture({ result: 0, msgList: [row('9'), row()] });
  assert.deepEqual(
    (await queryNativeMessages(reversed.port, peer(), ['00042', '9', '8'])).map(
      (value) => value?.msgId,
    ),
    ['00042', '9', undefined],
  );
  assert.deepEqual(
    (await queryNativeHistory(reversed.port, peer(), '0', 20, false)).map((value) => value.msgId),
    ['9', '00042'],
  );
});

for (const history of [false, true]) {
  test(`high-level ${history ? 'history' : 'batch'} validates all rows before any decode`, async () => {
    let decodes = 0;
    const controller = new AbortController();
    const f = fixture({ result: 0, msgList: [row(), { ...row('9'), elements: [null] }] });
    const queries = createMessageQueries({
      signal: controller.signal,
      getMessageService: () => f.port,
      resolvePeer: async () => peer(),
      awaitAlive: async (value) => value,
      decode: async () => {
        decodes++;
        return [];
      },
    });
    await assert.rejects(
      history
        ? queries.getHistory({ type: 'group', groupId: '123' }, {})
        : queries.getMessages({ type: 'group', groupId: '123' }, ['00042', '9']),
    );
    assert.equal(decodes, 0);
    assert.equal(f.calls(), 1);
  });
}
test('query envelope retains original raw identity and stable selected projection fields', async () => {
  const original = row();
  const element = original.elements[0];
  const f = fixture({ result: 0, msgList: [original] });
  const captured = await queryNativeMessage(f.port, peer(), '00042');
  assert.ok(captured);
  assert.equal(captured.raw, original);
  assert.notEqual(captured.message, original);
  original.msgId = '99';
  original.peerUid = '999';
  original.elements = [];
  assert.equal(captured.msgId, '00042');
  assert.equal(captured.peerUid, '123');
  assert.equal(Object.getOwnPropertyDescriptor(captured.message, 'msgId')?.value, '00042');
  assert.equal(Object.getOwnPropertyDescriptor(captured.message, 'peerUid')?.value, '123');
  assert.deepEqual(captured.elements, [element]);
  assert.equal(captured.elements[0], element);
});
for (const [name, query] of Object.entries(queries)) {
  test(`query ${name} malformed envelopes retain invalid-result code`, async () => {
    for (const value of [null, undefined, 42, 'invalid', false, []]) {
      const f = fixture(value);
      await assert.rejects(query(f.port), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(Object.getOwnPropertyDescriptor(error, 'code')?.value, 'invalid-result');
        return true;
      });
      assert.equal(f.calls(), 1);
    }
  });
}
