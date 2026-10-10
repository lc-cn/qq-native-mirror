import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Owned fake-service/worker contracts; no native addon or account operations. */
export async function checkHistoryLifecycle({
  QQClient,
  createNativeServices,
  observeWatchFailures,
  prepareCommand,
}) {
  let uidCalls = 0,
    historyCalls = 0,
    finishUid;
  const uid = new Promise((resolve) => {
    finishUid = resolve;
  });
  const raw = {
    msgId: '900719925474099312345',
    msgSeq: '9',
    msgTime: '100',
    chatType: 1,
    peerUid: 'u_456',
    peerUin: '456',
    senderUin: '789',
    senderUid: 'u_789',
    sendNickName: 'fixture',
    elements: [],
  };
  const services = createNativeServices({
    session: {
      getMsgService: () => ({
        addKernelMsgListener() {},
        getMsgsIncludeSelf(...args) {
          historyCalls++;
          assert.deepEqual(args, [
            { chatType: 1, peerUid: 'u_456' },
            '000900719925474099312345',
            2,
            false,
          ]);
          return { result: 0, msgList: [raw] };
        },
      }),
      getBuddyService: () => ({ addKernelBuddyListener() {} }),
      getGroupService: () => ({ addKernelGroupListener() {} }),
      getUixConvertService: () => ({
        getUid(ids) {
          uidCalls++;
          assert.deepEqual(ids, ['456']);
          return uid;
        },
      }),
    },
    version: '7.0.2-53644',
    events: { emit: () => {} },
  });
  const peer = { type: 'private', userId: '456' },
    options = { before: '000900719925474099312345', limit: 2 };
  try {
    for (const invalid of [
      { before: 42 },
      { limit: '2' },
      { reverse: 'false' },
      { limit: 2, count: 3 },
    ]) {
      await assert.rejects(services.invokeOperation('getHistory', { peer, options: invalid }));
    }
    assert.equal(uidCalls, 0);
    assert.equal(historyCalls, 0);
    const result = services.invokeOperation('getHistory', { peer, options });
    assert.equal(uidCalls, 1);
    peer.userId = '999';
    options.before = '42';
    options.limit = 100;
    finishUid({ uidInfo: new Map([['456', 'u_456']]) });
    const messages = await result;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].messageId, raw.msgId);
    assert.deepEqual(messages[0].peer, { type: 'private', userId: '456' });
    assert.equal(historyCalls, 1);
  } finally {
    services.close();
  }
  await assert.rejects(
    services.invokeOperation('getHistory', { peer: { type: 'group', groupId: '123' } }),
    /closed/,
  );
  assert.equal(historyCalls, 1);

  // Observe service shutdown before a dispatched native Promise ever settles.
  // Releasing this late Promise cannot replay or deliver the retired operation.
  for (const reentrant of [false, true])
    for (const [method, query, nativeMethod] of [
      ['getHistory', { peer: { type: 'group', groupId: '123' } }, 'getMsgsIncludeSelf'],
      [
        'getMessage',
        { peer: { type: 'group', groupId: '123' }, messageId: '42' },
        'getMsgsByMsgId',
      ],
      [
        'getMessages',
        { peer: { type: 'group', groupId: '123' }, messageIds: ['42'] },
        'getMsgsByMsgId',
      ],
    ]) {
      let begin,
        rejectNative,
        calls = 0,
        deadline;
      const began = new Promise((resolve) => {
        begin = resolve;
      });
      const native = new Promise((_resolve, reject) => {
        rejectNative = reject;
      });
      const stopped = createNativeServices({
        session: {
          getMsgService: () => ({
            addKernelMsgListener() {},
            [nativeMethod]() {
              calls++;
              if (reentrant) stopped.close();
              begin();
              return native;
            },
          }),
          getBuddyService: () => ({ addKernelBuddyListener() {} }),
          getGroupService: () => ({ addKernelGroupListener() {} }),
        },
        version: '7.0.2-53644',
        events: { emit: () => {} },
      });
      try {
        const result = stopped.invokeOperation(method, query);
        const rejected = assert.rejects(result, /closed|abort/i);
        await began;
        stopped.close();
        await Promise.race([
          rejected,
          new Promise((_resolve, reject) => {
            deadline = setTimeout(() => reject(new Error('Closed read remained pending')), 500);
          }),
        ]);
        assert.equal(calls, 1);
        rejectNative(new Error('late native rejection'));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(calls, 1);
      } finally {
        clearTimeout(deadline);
        stopped.close();
        rejectNative(new Error('late cleanup rejection'));
      }
    }

  class Worker extends EventEmitter {
    connected = true;
    autoExitAfterClose = true;
    exitCode = null;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    requests = [];
    send(value, callback) {
      this.requests.push(value);
      callback(null);
      if (value.method === 'close')
        queueMicrotask(() => {
          this.emit('message', { id: value.id, result: null });
          setImmediate(() => {
            if (!this.autoExitAfterClose) return;
            this.connected = false;
            this.exitCode = 0;
            this.emit('exit', 0, null);
          });
        });
    }
    kill() {
      this.connected = false;
      queueMicrotask(() => this.emit('exit', 0, null));
      return true;
    }
  }
  const worker = new Worker(),
    client = new QQClient(worker, 500);
  try {
    const login = client.login({ method: 'restore', uin: '123' });
    assert.equal(client.waitForLogin(), login);
    const account = { uin: '123', uid: 'u_original' };
    worker.emit('message', { event: 'ready', payload: account });
    worker.emit('message', { id: worker.requests[0].id, result: account });
    (await login).uin = '456';
    assert.deepEqual(await client.waitForLogin(), { uin: '123', uid: 'u_original' });
    for (const invalid of [{ before: 42 }, { limit: '2' }, { reverse: 'false' }])
      await assert.rejects(client.getHistory({ type: 'group', groupId: '123' }, invalid));
    assert.equal(worker.requests.length, 1);
    const peer = { type: 'group', groupId: '123' },
      options = { before: raw.msgId, limit: 2 };
    const history = client.getHistory(peer, options);
    peer.groupId = '999';
    options.before = '0';
    options.limit = 100;
    const request = worker.requests[1];
    assert.deepEqual(
      { peer: request.peer, options: request.options },
      {
        peer: { type: 'group', groupId: '123' },
        options: { before: raw.msgId, limit: 2, reverse: false },
      },
    );
    worker.emit('message', { id: request.id, result: [] });
    assert.deepEqual(await history, []);
    const pending = client.getHistory({ type: 'group', groupId: '123' });
    const rejected = assert.rejects(pending, /closed/);
    await client.close();
    await rejected;
    assert.equal(worker.requests.filter((r) => r.method === 'getHistory').length, 2);
    await assert.rejects(client.waitForLogin(), /closed/);
  } finally {
    await client.close();
  }

  const watched = new EventEmitter(),
    failures = [];
  const remove = observeWatchFailures(watched, { maxAttempts: 2 }, (error) => failures.push(error));
  watched.emit('disconnected', { retryable: true });
  assert.equal(failures.length, 0);
  watched.emit('disconnected', { retryable: false });
  assert.equal(failures.length, 1);
  watched.emit('kicked', { retryable: true });
  assert.equal(failures.length, 2);
  remove();
  watched.emit('logout');
  assert.equal(failures.length, 2);
  const action = await prepareCommand('history', {
    kind: 'group',
    target: '123',
    before: raw.msgId,
    limit: '2',
  });
  let cliCalls = 0;
  await action({
    getHistory(peer, options) {
      cliCalls++;
      assert.deepEqual(peer, { type: 'group', groupId: '123' });
      assert.deepEqual(options, { before: raw.msgId, limit: 2 });
      return [];
    },
  });
  assert.equal(cliCalls, 1);
  return {
    pendingReadCloseContract: true,
    reentrantReadCloseContract: true,
    historyInputCaptureContract: true,
    loginWaitIdentityContract: true,
    watchReconnectPolicyContract: true,
    nativeHistoryQueryAttempted: false,
  };
}

export async function verifyHistoryLifecycleConsumer(packageRoot) {
  const load = (file) => import(pathToFileURL(join(packageRoot, 'dist', file)).href);
  const [{ QQClient }, { createNativeServices }, { observeWatchFailures, prepareCommand }] =
    await Promise.all([load('index.js'), load('native-services.js'), load('cli.js')]);
  const checks = await checkHistoryLifecycle({
    QQClient,
    createNativeServices,
    observeWatchFailures,
    prepareCommand,
  });
  const direct = spawnSync(process.execPath, [join(packageRoot, 'dist/cli.js'), '--help'], {
    encoding: 'utf8',
  });
  assert.equal(direct.status, 0);
  assert.match(direct.stdout, /qq-native-client <command>/);
  if (process.platform !== 'win32') {
    const bin = join(dirname(packageRoot), '.bin', 'qq-native-client');
    const linked = spawnSync(bin, ['--help'], { encoding: 'utf8' });
    assert.equal(linked.status, 0);
    assert.match(linked.stdout, /qq-native-client <command>/);
    const invalid = spawnSync(bin, ['forward-resource'], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /resource-id/);
  }
  return {
    ...checks,
    installedCliEntrypointContract: true,
    posixNpmBinEntrypointChecked: process.platform !== 'win32',
  };
}
