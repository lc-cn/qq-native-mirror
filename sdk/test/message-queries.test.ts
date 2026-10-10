import type { NativePeer } from '../src/native/message-contracts.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMessageQueries,
  type MessageQueriesContext,
} from '../src/features/messages/message-queries.ts';
import { NativeServiceLifetime } from '../src/runtime/native-service-lifetime.ts';

function fixture() {
  const lifetime = new NativeServiceLifetime();
  const order: string[] = [];
  const row = (id: string) => ({ msgId: id, chatType: 2, peerUid: '123', elements: [] });
  let response: unknown = { result: 0, msgList: [row('2'), row('1')] };
  const service = {
    async getMsgsByMsgId() {
      order.push('query');
      return response;
    },
    async getMsgsIncludeSelf() {
      order.push('history');
      return { result: 0, msgList: [] };
    },
  };
  const context: MessageQueriesContext = {
    signal: lifetime.signal,
    awaitAlive: lifetime.awaitAlive,
    getMessageService() {
      order.push('service');
      return service;
    },
    async resolvePeer() {
      order.push('peer');
      return { chatType: 2 as const, peerUid: '123' };
    },
    async decode(rows) {
      order.push('decode');
      return rows.map((row) => ({
        messageId: row.msgId,
        sequence: '1',
        time: 0,
        peer: { type: 'group', groupId: '123' },
        sender: { userId: '123', uid: 'u_123', nickname: '' },
        elements: [],
        raw: row,
      }));
    },
  };
  return {
    lifetime,
    context,
    order,
    setResponse(value: unknown) {
      response = value;
    },
    row,
  };
}

test('query captures IDs before await, restores requested missing positions and getter order', async () => {
  const f = fixture();
  let release!: () => void;
  f.context.resolvePeer = async () => {
    f.order.push('peer');
    await new Promise<void>((r) => {
      release = r;
    });
    return { chatType: 2, peerUid: '123' };
  };
  const ids = ['1', '9', '2'];
  const query = createMessageQueries(f.context);
  const pending = query.getMessages({ type: 'group', groupId: '123' }, ids);
  ids[0] = '7';
  release();
  assert.deepEqual(
    (await pending).map((v) => v?.messageId),
    ['1', undefined, '2'],
  );
  assert.deepEqual(f.order, ['service', 'peer', 'query', 'decode']);
  f.lifetime.close();
});
test('whole response validates before decode and preserves native error identity', async () => {
  const f = fixture();
  f.setResponse({ result: 0, msgList: [f.row('1'), { ...f.row('2'), peerUid: 'other' }] });
  await assert.rejects(
    createMessageQueries(f.context).getMessages({ type: 'group', groupId: '123' }, ['1', '2']),
  );
  assert.equal(f.order.includes('decode'), false);
  const error = Error('synthetic');
  f.context.getMessageService = () => ({
    getMsgsByMsgId: async () => {
      throw error;
    },
  });
  await assert.rejects(
    createMessageQueries(f.context).getMessage({ type: 'group', groupId: '123' }, '1'),
    (e: unknown) => e === error,
  );
  f.lifetime.close();
});
test('close interrupts stalled native query without decoding its late response', async () => {
  const f = fixture();
  let release!: (v: unknown) => void;
  f.context.getMessageService = () => ({
    getMsgsByMsgId: () =>
      new Promise((r) => {
        release = r;
      }),
  });
  const pending = createMessageQueries(f.context).getMessages({ type: 'group', groupId: '123' }, [
    '1',
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.lifetime.close();
  await assert.rejects(pending);
  release({ result: 0, msgList: [f.row('1')] });
  await Promise.resolve();
  assert.equal(f.order.includes('decode'), false);
});
test('history resolves peer before obtaining Msg while invalid IDs obtain nothing', async () => {
  const f = fixture();
  const queries = createMessageQueries(f.context);
  await queries.getHistory({ type: 'group', groupId: '123' }, {});
  assert.deepEqual(f.order, ['peer', 'service', 'history', 'decode']);
  f.order.length = 0;
  await assert.rejects(queries.getMessages({ type: 'group', groupId: '123' }, ['1', '1']));
  assert.deepEqual(f.order, []);
  f.lifetime.close();
});

test('narrow query ports retain native receiver and accept only validated unknown results', async () => {
  const { queryNativeMessage, queryNativeHistory } =
    await import('../src/features/messages/message-query.ts');
  const peer = { chatType: 2 as const, peerUid: '123' };
  const calls: unknown[][] = [];
  const service = {
    getMsgsByMsgId(actualPeer: NativePeer, ids: string[]): unknown {
      assert.equal(this, service);
      calls.push([actualPeer, ids]);
      return { result: 0, msgList: [] };
    },
    getMsgsIncludeSelf(
      actualPeer: NativePeer,
      before: string,
      count: number,
      reverse: boolean,
    ): unknown {
      assert.equal(this, service);
      calls.push([actualPeer, before, count, reverse]);
      return { result: 0, msgList: [] };
    },
  };
  assert.equal(await queryNativeMessage(service, peer, '1'), undefined);
  assert.deepEqual(await queryNativeHistory(service, peer, '0', 1, false), []);
  assert.deepEqual(calls, [
    [peer, ['1']],
    [peer, '0', 1, false],
  ]);
  await assert.rejects(queryNativeMessage({ getMsgsByMsgId: () => 0 }, peer, '1'));
  await assert.rejects(
    queryNativeHistory({ getMsgsIncludeSelf: () => undefined }, peer, '0', 1, false),
  );
});

for (const method of ['getMessage', 'getMessages', 'getHistory'] as const) {
  const invoke = (queries: ReturnType<typeof createMessageQueries>) =>
    method === 'getMessage'
      ? queries.getMessage({ type: 'group', groupId: '123' }, '1')
      : method === 'getMessages'
        ? queries.getMessages({ type: 'group', groupId: '123' }, ['1'])
        : queries.getHistory({ type: 'group', groupId: '123' }, {});
  test(`${method} cancels resolution before query dispatch`, async () => {
    const f = fixture();
    f.context.resolvePeer = async () => {
      f.lifetime.close();
      return { chatType: 2, peerUid: '123' };
    };
    await assert.rejects(invoke(createMessageQueries(f.context)));
    assert.equal(f.order.includes('query') || f.order.includes('history'), false);
  });
  test(`${method} rejects retirement during decoding`, async () => {
    const f = fixture();
    f.setResponse({ result: 0, msgList: [f.row('1')] });
    f.context.decode = async () => {
      f.lifetime.close();
      return [
        {
          messageId: '1',
          sequence: '1',
          time: 0,
          peer: { type: 'group', groupId: '123' },
          sender: { userId: '123', uid: 'u_123', nickname: '' },
          elements: [],
          raw: {},
        },
      ];
    };
    await assert.rejects(invoke(createMessageQueries(f.context)));
  });
  test(`${method} method getter cancellation prevents dispatch`, async () => {
    const f = fixture();
    let calls = 0;
    f.context.getMessageService = () =>
      Object.defineProperty({}, method === 'getHistory' ? 'getMsgsIncludeSelf' : 'getMsgsByMsgId', {
        get() {
          f.lifetime.close();
          return () => {
            calls++;
            return { result: 0, msgList: [] };
          };
        },
      });
    await assert.rejects(invoke(createMessageQueries(f.context)));
    assert.equal(calls, 0);
  });
}

for (const phase of ['resolvePeer', 'decode'] as const) {
  test(`close interrupts stalled ${phase} and observes late failure`, async () => {
    const f = fixture();
    f.setResponse({ result: 0, msgList: [f.row('1')] });
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    let reject!: (reason: unknown) => void;
    if (phase === 'resolvePeer')
      f.context.resolvePeer = () => {
        entered();
        return new Promise((_, r) => {
          reject = r;
        });
      };
    else
      f.context.decode = () => {
        entered();
        return new Promise((_, r) => {
          reject = r;
        });
      };
    const pending = createMessageQueries(f.context).getMessage(
      { type: 'group', groupId: '123' },
      '1',
    );
    await started;
    f.lifetime.close();
    await assert.rejects(pending);
    reject(Error('synthetic late provider failure'));
    await new Promise<void>((r) => setImmediate(r));
    if (phase === 'resolvePeer') assert.equal(f.order.includes('query'), false);
  });
}
