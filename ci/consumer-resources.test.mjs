import assert from 'node:assert/strict';
import test from 'node:test';
import { closeConsumerResources } from './consumer-resources.mjs';

function fixture() {
  /** @type {string[]} */
  const calls = [];
  /** @type {import('./consumer-resources.mjs').ConsumerResources} */
  const resources = {
    client: {
      async close() {
        calls.push('client');
      },
    },
    server: {
      close(done) {
        calls.push('server');
        done();
      },
      closeAllConnections() {
        calls.push('connections');
      },
    },
    async removeDirectory() {
      calls.push('directory');
    },
  };
  return { resources, calls };
}

await test('consumer closes every resource once in ownership order', async () => {
  const f = fixture();
  await closeConsumerResources(f.resources);
  assert.deepEqual(f.calls, ['client', 'server', 'connections', 'directory']);
});

await test('client cleanup failure still closes registry and removes directory', async () => {
  const f = fixture();
  const failure = new Error('Client close failed');
  f.resources.client = {
    async close() {
      f.calls.push('client');
      throw failure;
    },
  };
  await assert.rejects(closeConsumerResources(f.resources), (error) => error === failure);
  assert.deepEqual(f.calls, ['client', 'server', 'connections', 'directory']);
});

await test('primary failure retains identity after complete cleanup', async () => {
  const f = fixture();
  const primary = new Error('Consumer failed');
  await assert.rejects(
    closeConsumerResources(f.resources, { error: primary }),
    (error) => error === primary,
  );
  assert.deepEqual(f.calls, ['client', 'server', 'connections', 'directory']);
});

await test('primary and independent cleanup failures are retained together', async () => {
  const f = fixture();
  const primary = new Error('Consumer failed');
  const client = new Error('Client close failed');
  const server = new Error('Registry close failed');
  const directory = new Error('Directory removal failed');
  f.resources.client = {
    async close() {
      f.calls.push('client');
      throw client;
    },
  };
  f.resources.server.close = (done) => {
    f.calls.push('server');
    done(server);
  };
  f.resources.removeDirectory = async () => {
    f.calls.push('directory');
    throw directory;
  };
  await assert.rejects(closeConsumerResources(f.resources, { error: primary }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [primary, client, server, directory]);
    return true;
  });
  assert.deepEqual(f.calls, ['client', 'server', 'connections', 'directory']);
});

await test('throw undefined is a failure rather than an absent primary', async () => {
  const f = fixture();
  await closeConsumerResources(f.resources, { error: undefined }).then(
    () => assert.fail('Undefined primary was lost'),
    (error) => assert.equal(error, undefined),
  );
  assert.deepEqual(f.calls, ['client', 'server', 'connections', 'directory']);
});

await test('synchronous registry failure and callback success cannot mask each other', async () => {
  for (const callbackFirst of [false, true]) {
    const f = fixture();
    const failure = new Error('Registry close threw');
    f.resources.server.close = (done) => {
      f.calls.push('server');
      if (callbackFirst) done();
      throw failure;
    };
    await assert.rejects(closeConsumerResources(f.resources), (error) => error === failure);
    assert.deepEqual(f.calls, ['client', 'server', 'connections', 'directory']);
  }
});

await test('connection cleanup failure retains registry failure and still removes directory', async () => {
  const f = fixture();
  const server = new Error('Registry failure');
  const connections = new Error('Connection failure');
  f.resources.server.close = (done) => {
    f.calls.push('server');
    done(server);
  };
  f.resources.server.closeAllConnections = () => {
    f.calls.push('connections');
    throw connections;
  };
  await assert.rejects(closeConsumerResources(f.resources), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [server, connections]);
    return true;
  });
  assert.deepEqual(f.calls, ['client', 'server', 'connections', 'directory']);
});

await test('registry callback and invocation failures retain distinct errors without duplication', async () => {
  for (const sameFailure of [false, true]) {
    const f = fixture();
    const callback = new Error('Registry callback failed');
    const invocation = sameFailure ? callback : new Error('Registry invocation failed');
    f.resources.server.close = (done) => {
      f.calls.push('server');
      done(callback);
      throw invocation;
    };
    await assert.rejects(closeConsumerResources(f.resources), (error) => {
      if (sameFailure) assert.equal(error, callback);
      else {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [callback, invocation]);
      }
      return true;
    });
    assert.deepEqual(f.calls, ['client', 'server', 'connections', 'directory']);
  }
});

await test('registry deadline releases directory and late callbacks cannot change settlement', async () => {
  const f = fixture();
  /** @type {(error?:Error)=>void} */
  let complete = () => {};
  f.resources.server.close = (done) => {
    f.calls.push('server');
    complete = done;
  };
  f.resources.serverCloseTimeoutMs = 10;
  await assert.rejects(closeConsumerResources(f.resources), /registry did not close/);
  assert.deepEqual(f.calls, ['client', 'server', 'connections', 'directory']);
  complete(new Error('Late callback failure'));
  complete();
  await new Promise((resolve) => setImmediate(resolve));
});

await test('unacquired client does not prevent registry and directory retirement', async () => {
  const f = fixture();
  delete f.resources.client;
  await closeConsumerResources(f.resources);
  assert.deepEqual(f.calls, ['server', 'connections', 'directory']);
});
