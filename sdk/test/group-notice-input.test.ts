import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { QQClient } from '../src/index.ts';
import { ClientWorkerFixture } from '../scripts/consumers/client-worker-fixture.mjs';
import { createGroupNotices } from '../src/features/groups/group-notices.ts';

function fixture() {
  const worker = new ClientWorkerFixture();
  const client = new QQClient(worker, 500);
  worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_self' } });
  return { client, worker };
}

test('notice facade captures options before dispatch and shares selected-group routing', async (t) => {
  const { client, worker } = fixture();
  t.after(() => client.close());
  const notices = client.pickGroup('000789').notices;
  assert.equal(notices.groupId, '000789');
  assert.equal(Reflect.set(notices, 'groupId', '999'), false);
  assert.equal(worker.requests.length, 0);
  const options = { pinned: true, imagePath: resolve('fixture.png') };
  const publish = notices.publish('hello', options);
  options.pinned = false;
  await publish;
  await client.publishGroupNotice('000789', 'direct', { confirmRequired: true });
  const page = { notices: [], raw: {} };
  worker.respond = () => page;
  assert.equal(await notices.list(), page);
  await notices.delete('opaque-id');
  assert.deepEqual(
    worker.requests.map(({ id: _id, ...command }) => command),
    [
      {
        method: 'publishGroupNotice',
        groupId: '000789',
        text: 'hello',
        options: { pinned: true, imagePath: options.imagePath },
      },
      {
        method: 'publishGroupNotice',
        groupId: '000789',
        text: 'direct',
        options: { confirmRequired: true },
      },
      { method: 'listGroupNotices', groupId: '000789' },
      { method: 'deleteGroupNotice', groupId: '000789', noticeId: 'opaque-id' },
    ],
  );
});

test('invalid notice input is rejected by direct and selected APIs before IPC without reading accessors', async (t) => {
  const { client, worker } = fixture();
  t.after(() => client.close());
  const notices = client.pickGroup('789').notices;
  let reads = 0;
  const accessor = {
    get pinned() {
      reads++;
      return true;
    },
  };
  await assert.rejects(notices.publish('hello', accessor), /data property/);
  await assert.rejects(client.publishGroupNotice('789', 'hello', accessor), /data property/);
  await assert.rejects(notices.publish('\ud800'), URIError);
  await assert.rejects(
    client.publishGroupNotice('789', 'hello', { imagePath: 'relative.png' }),
    /absolute local/,
  );
  await assert.rejects(client.listGroupNotices('0'), /group identifier/);
  await assert.rejects(client.deleteGroupNotice('789', ''), /non-empty/);
  await assert.rejects(notices.delete(''), /non-empty/);
  assert.equal(reads, 0);
  assert.deepEqual(worker.requests, []);
});

test('notice input reentrancy retires a selected capability before dispatch', async (t) => {
  const { client, worker } = fixture();
  t.after(() => client.close());
  const notices = client.pickGroup('789').notices;
  const options = new Proxy(
    { pinned: true },
    {
      getOwnPropertyDescriptor(target, key) {
        worker.emit('message', {
          event: 'disconnected',
          payload: { source: 'login', kind: 'transport', retryable: false, args: [] },
        });
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  await assert.rejects(notices.publish('hello', options), /session|inactive/);
  worker.emit('message', { event: 'ready', payload: { uin: '123', uid: 'u_self' } });
  await assert.rejects(notices.list(), /session|inactive/);
  await assert.rejects(notices.delete('opaque'), /session|inactive/);
  assert.deepEqual(worker.requests, []);
  const fresh = client.pickGroup('789').notices;
  worker.failure = { message: 'notice denied', code: 47 };
  await assert.rejects(fresh.publish('hello'), { message: 'notice denied', code: 47 });
  assert.equal(worker.requests.length, 1);
  worker.failure = undefined;
  await client.close();
  const count = worker.requests.length;
  await assert.rejects(fresh.publish('stale'), /session|inactive/);
  assert.equal(worker.requests.length, count);
});

test('worker notice preflight rejects invalid Unicode and accessor options before ticket acquisition', async () => {
  let acquisitions = 0;
  let reads = 0;
  const service = createGroupNotices({
    signal: new AbortController().signal,
    getGroupService: () => undefined,
    getTipOffService() {
      acquisitions++;
      return undefined;
    },
    awaitAlive: async (value) => value,
  });
  try {
    await assert.rejects(
      service.invokeOperation('publishGroupNotice', { groupId: '789', text: '\ud800' }),
      URIError,
    );
    await assert.rejects(
      service.invokeOperation('publishGroupNotice', {
        groupId: '789',
        text: 'hello',
        options: {
          get pinned() {
            reads++;
            return true;
          },
        },
      }),
      /data property/,
    );
    assert.equal(reads, 0);
    assert.equal(acquisitions, 0);
  } finally {
    service.close();
  }
});
