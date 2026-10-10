import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { QQClient, KernelRequestError } from '../src/index.ts';

class Worker extends EventEmitter {
  connected = true;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  requests: any[] = [];
  send(value: any, callback: (error: Error | null) => void) {
    this.requests.push(value);
    callback(null);
    if (value.method === 'close')
      queueMicrotask(() => this.emit('message', { id: value.id, result: null }));
  }
  kill() {
    this.connected = false;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }
}
const node = () => ({ userId: '456', nickname: 'fixture', time: 100, text: 'fixture text' });

// These exercise the actual public IPC boundary; the worker supplies no QQ native implementation.
test('public merged-forward input is validated before IPC and online state is required', async () => {
  const worker = new Worker(),
    client = new QQClient(worker as unknown as ChildProcess, 500);
  try {
    await assert.rejects(
      client.sendMergedForward({ type: 'group', groupId: '123' }, [node()]),
      /not online/,
    );
    worker.emit('message', { event: 'ready', payload: { uin: '789', uid: 'u_self' } });
    for (const nodes of [
      [],
      Array(1),
      [node(), { ...node(), text: {} }],
      [{ ...node(), userId: '0' }],
      [{ ...node(), time: 1.5 }],
    ]) {
      await assert.rejects(
        client.sendMergedForward({ type: 'private', userId: '456' }, nodes as any),
      );
    }
    await assert.rejects(
      client.sendMergedForward({ type: 'group', groupId: '123' }, [node()], { title: 42 } as any),
    );
    assert.equal(worker.requests.length, 0);
  } finally {
    await client.close();
  }
});

test('public merged-forward snapshots the whole request and close rejects pending IPC without replay', async () => {
  const worker = new Worker(),
    client = new QQClient(worker as unknown as ChildProcess, 500);
  worker.emit('message', { event: 'ready', payload: { uin: '789', uid: 'u_self' } });
  try {
    const peer = { type: 'group' as const, groupId: '123' },
      nodes = [node()],
      options = { title: 'original' };
    const pending = client.sendMergedForward(peer, nodes, options);
    peer.groupId = '999';
    nodes[0].text = 'mutated';
    options.title = 'mutated';
    const request = worker.requests.at(-1);
    assert.equal(request.method, 'sendMergedForward');
    assert.deepEqual(request.peer, { type: 'group', groupId: '123' });
    assert.deepEqual(request.nodes, [node()]);
    assert.deepEqual(request.options, { title: 'original' });
    const rejected = assert.rejects(pending, /closed/);
    await client.close();
    await rejected;
    assert.equal(
      worker.requests.filter((request) => request.method === 'sendMergedForward').length,
      1,
    );
  } finally {
    await client.close();
  }
});

test('public merged-forward preserves IPC-safe progress and native code without replay', async () => {
  const worker = new Worker(),
    client = new QQClient(worker as unknown as ChildProcess, 500);
  worker.emit('message', { event: 'ready', payload: { uin: '789', uid: 'u_self' } });
  try {
    for (const [phase, progress] of [
      ['upload', { uploadCompletion: 'unknown', cardCompletion: 'not-dispatched' }],
      [
        'card',
        { uploadCompletion: 'resource-received', cardCompletion: 'unknown', resourceId: 'r' },
      ],
    ] as const) {
      const pending = client.sendMergedForward({ type: 'group', groupId: '123' }, [node()]);
      const request = worker.requests.at(-1);
      worker.emit('message', {
        id: request.id,
        error: JSON.parse(
          JSON.stringify({
            message: 'Merged-forward failed',
            code: 23,
            mergedForward: { phase, ...progress },
          }),
        ),
      });
      await assert.rejects(pending, (error: any) => {
        assert.equal(error.operation, 'sendMergedForward');
        assert.equal(error.code, 23);
        assert.deepEqual(error.mergedForward, { phase, ...progress });
        return true;
      });
    }
    assert.equal(
      worker.requests.filter((request) => request.method === 'sendMergedForward').length,
      2,
    );
  } finally {
    await client.close();
  }
});

test('public merged-forward result exposes the uploaded resource and exact sent receipt', async () => {
  const worker = new Worker(),
    client = new QQClient(worker as unknown as ChildProcess, 500);
  worker.emit('message', { event: 'ready', payload: { uin: '789', uid: 'u_self' } });
  try {
    const pending = client.sendMergedForward({ type: 'private', userId: '456' }, [node()]);
    const request = worker.requests.at(-1);
    const receipt = {
      messageId: '900719925474099312345',
      sequence: '9',
      time: 100,
      resourceId: 'r',
    };
    worker.emit('message', { id: request.id, result: receipt });
    assert.deepEqual(await pending, receipt);
    assert.equal(
      worker.requests.filter((request) => request.method === 'sendMergedForward').length,
      1,
    );
  } finally {
    await client.close();
  }
});

function operationUnknown(error: unknown) {
  assert.ok(error instanceof KernelRequestError);
  assert.equal(error.operation, 'sendMergedForward');
  assert.deepEqual(error.mergedForward, {
    phase: 'operation',
    uploadCompletion: 'unknown',
    cardCompletion: 'unknown',
  });
  assert.equal(error.mergedForward.resourceId, undefined);
  return true;
}
for (const failure of ['timeout', 'close', 'offline', 'worker-exit'] as const)
  test(`submitted merged-forward ${failure} retains unknown progress without replay`, async () => {
    const worker = new Worker(),
      client = new QQClient(worker as unknown as ChildProcess, failure === 'timeout' ? 10 : 500);
    worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_fixture' } });
    const pending = client.sendMergedForward({ type: 'group', groupId: '123' }, [node()]);
    const rejected = assert.rejects(pending, operationUnknown);
    const submitted = worker.requests.find((request) => request.method === 'sendMergedForward');
    assert.ok(submitted);
    assert.equal(
      worker.requests.filter((request) => request.method === 'sendMergedForward').length,
      1,
    );
    try {
      if (failure === 'close') await client.close();
      else if (failure === 'offline')
        worker.emit('message', {
          event: 'disconnected',
          payload: { source: 'login', kind: 'unknown', retryable: false, args: [] },
        });
      else if (failure === 'worker-exit') {
        worker.connected = false;
        worker.emit('exit', 1, null);
      }
      await rejected;
      // A later worker completion cannot replace the rejected caller result.
      worker.emit('message', {
        id: submitted.id,
        result: { messageId: '42', sequence: '9', time: 1, resourceId: 'late-resource' },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        worker.requests.filter((request) => request.method === 'sendMergedForward').length,
        1,
      );
    } finally {
      await client.close();
    }
  });

test('reconnect rejects a submitted merged-forward as unknown and never replays it to replacement worker', async () => {
  class ReplacementWorker extends Worker {
    override send(value: any, callback: (error: Error | null) => void) {
      super.send(value, callback);
      if (value.method === 'init')
        queueMicrotask(() => this.emit('message', { id: value.id, result: { exports: ['fake'] } }));
      if (value.method === 'login')
        queueMicrotask(() => {
          const account = { uin: '123', uid: 'u_fixture' };
          this.emit('message', { event: 'ready', payload: account });
          this.emit('message', { id: value.id, result: account });
        });
    }
  }
  const previous = new Worker(),
    replacement = new ReplacementWorker();
  let spawns = 0;
  const client = new QQClient(
    previous as unknown as ChildProcess,
    500,
    { method: 'qr' },
    {
      spawn() {
        spawns++;
        return replacement as unknown as ChildProcess;
      },
      payload: {},
    },
  );
  previous.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_fixture' } });
  const pending = client.sendMergedForward({ type: 'private', userId: '456' }, [node()]);
  const rejected = assert.rejects(pending, operationUnknown);
  const submitted = previous.requests.find((request) => request.method === 'sendMergedForward');
  assert.ok(submitted);
  try {
    assert.deepEqual(await client.reconnect({ method: 'restore', uin: '123' }), {
      uin: '123',
      uid: 'u_fixture',
    });
    await rejected;
    assert.equal(spawns, 1);
    previous.emit('message', {
      id: submitted.id,
      result: { messageId: '42', sequence: '9', time: 1, resourceId: 'retired-resource' },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      previous.requests.filter((request) => request.method === 'sendMergedForward').length,
      1,
    );
    assert.equal(
      replacement.requests.filter((request) => request.method === 'sendMergedForward').length,
      0,
    );
    assert.deepEqual(
      replacement.requests.map((request) => request.method),
      ['init', 'login'],
    );
  } finally {
    await client.close();
  }
});
