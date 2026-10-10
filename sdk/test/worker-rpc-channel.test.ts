import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkerRpcChannel, type WorkerRpcTransport } from '../src/runtime/worker-rpc-channel.ts';
function fixture(timeout?: (method: string, error: Error) => Error | Promise<Error>) {
  const sent: { id: number; method: string }[] = [];
  const callbacks: ((error: Error | null) => void)[] = [];
  const transport: WorkerRpcTransport = {
    send(message, callback) {
      sent.push(message);
      callbacks.push(callback);
    },
  };
  const channel = new WorkerRpcChannel(() => transport, {
    failure: (method, error) => new Error(`${method}: ${error.message}`),
    responseFailure: (method, error) => new Error(`${method}: native ${String(error)}`),
    timeout,
  });
  return { channel, sent, callbacks };
}
test('correlation handles out-of-order replies and late send failure without disturbing another request', async () => {
  const { channel, sent, callbacks } = fixture();
  const first = channel.request('first', {}, 1000),
    second = channel.request('second', {}, 1000);
  channel.receive({ id: sent[1].id, result: { value: 2 } });
  callbacks[1](new Error('late send failure'));
  channel.receive({ id: sent[0].id, result: 1 });
  channel.receive({ id: sent[0].id, error: 'late native failure' });
  assert.deepEqual(await second, { value: 2 });
  assert.equal(await first, 1);
});
test('timeout removes the request before retirement and consumes late reply/native error', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let retired = 0;
  const f = fixture((method, error) => {
    assert.equal(method, 'login');
    retired++;
    f.channel.rejectPending(error);
    return error;
  });
  const channel = f.channel;
  const login = assert.rejects(channel.request('login', {}, 10), /login: Kernel login timed out/);
  const sibling = assert.rejects(
    channel.request('query', {}, 100),
    /query: Kernel login timed out/,
  );
  context.mock.timers.tick(10);
  assert.equal(retired, 1);
  channel.receive({ id: f.sent[0].id, result: 'late ready' });
  await Promise.all([login, sibling]);
});
test('retirement failure retains cleanup error, settles once, and late rejection cannot replay', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const cleanup = new AggregateError(
    [new Error('timeout'), new Error('cleanup')],
    'failed retirement',
  );
  const f = fixture(() => Promise.reject(cleanup));
  const rejected = assert.rejects(f.channel.request('login', {}, 1), (error) => error === cleanup);
  context.mock.timers.tick(1);
  await rejected;
  f.callbacks[0](new Error('late'));
  assert.equal(f.sent.length, 1);
});
test('offline can preserve close request; all other errors pass method policy and late responses remain ignored', async () => {
  const f = fixture();
  const work = assert.rejects(f.channel.request('mutation', {}, 1000), /mutation: offline/);
  const close = f.channel.request('close', {}, 1000);
  f.channel.rejectPending(new Error('offline'), (method) => method === 'close');
  f.channel.receive({ id: f.sent[0].id, result: 'too late' });
  f.channel.receive({ id: f.sent[1].id, result: null });
  await work;
  assert.equal(await close, null);
});
test('synchronous transport reply followed by send throw does not replace completed result', async () => {
  const channel: WorkerRpcChannel = new WorkerRpcChannel(
    () => ({
      send(message) {
        channel.receive({ id: message.id, result: 42 });
        throw new Error('after reply');
      },
    }),
    { failure: (_method, error) => error, responseFailure: () => new Error('native') },
  );
  assert.equal(await channel.request('fixture', {}, 1000), 42);
});

test('read timeout cancels its original transport after detaching its request', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const cancelled: number[] = [];
  let current: WorkerRpcTransport;
  const original: WorkerRpcTransport = {
    send() {},
    cancelRead(id) {
      cancelled.push(id);
      channel.receive({ id, result: 'late result' });
      channel.rejectPending(new Error('offline'));
    },
  };
  current = original;
  const channel = new WorkerRpcChannel(() => current, {
    failure: (_method, error) => error,
    responseFailure: () => new Error('native'),
  });
  const read = assert.rejects(
    channel.request('listGroupEssenceMessages', {}, 10),
    /Kernel listGroupEssenceMessages timed out/,
  );
  const sibling = assert.rejects(channel.request('other', {}, 1000), /offline/);
  current = {
    send() {},
    cancelRead() {
      assert.fail('replacement worker must not be cancelled');
    },
  };
  context.mock.timers.tick(10);
  await Promise.all([read, sibling]);
  assert.deepEqual(cancelled, [1]);
});

test('all reviewed reads cancel on send failure; cancellation failure preserves the original error', async () => {
  for (const method of ['getGroupEssencePage', 'listGroupEssenceMessages', 'listGroupNotices']) {
    const cancelled: number[] = [];
    const failed = new Error('send failed');
    const channel = new WorkerRpcChannel(
      () => ({
        send(_message, callback) {
          callback(failed);
        },
        cancelRead(id) {
          cancelled.push(id);
          throw new Error('cancel failed');
        },
      }),
      { failure: (_method, error) => error, responseFailure: () => new Error('native') },
    );
    await assert.rejects(channel.request(method, {}, 1000), (error) => error === failed);
    assert.deepEqual(cancelled, [1]);
  }
});

test('settled reads, mutations, login and unreviewed queries never send cancellation', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const cancelled: number[] = [];
  const callbacks: ((error: Error | null) => void)[] = [];
  const channel = new WorkerRpcChannel(
    () => ({
      send(_message, callback) {
        callbacks.push(callback);
      },
      cancelRead(id) {
        cancelled.push(id);
      },
    }),
    { failure: (_method, error) => error, responseFailure: () => new Error('native') },
  );
  const completed = channel.request('getGroupEssencePage', {}, 10);
  channel.receive({ id: 1, result: [] });
  callbacks[0](new Error('late send failure'));
  await completed;
  const failed = ['setGroupEssenceMessage', 'login', 'getMessages'].map((method) =>
    assert.rejects(channel.request(method, {}, 10), /timed out/),
  );
  context.mock.timers.tick(10);
  await Promise.all(failed);
  assert.deepEqual(cancelled, []);
});

test('offline cancels a pending read once and preserves reserved correlation fields', async () => {
  const cancelled: number[] = [];
  const sent: { id: number; method: string }[] = [];
  const channel = new WorkerRpcChannel(
    () => ({
      send(message) {
        sent.push(message);
      },
      cancelRead(id) {
        cancelled.push(id);
      },
    }),
    { failure: (_method, error) => error, responseFailure: () => new Error('native') },
  );
  const failed = assert.rejects(
    channel.request('listGroupNotices', { id: 50, method: 'login' }, 1000),
    /offline/,
  );
  assert.deepEqual(sent, [{ id: 1, method: 'listGroupNotices' }]);
  channel.rejectPending(new Error('offline'));
  channel.rejectPending(new Error('again'));
  channel.receive({ id: 1, result: [] });
  await failed;
  assert.deepEqual(cancelled, [1]);
});
