import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { ChildProcess, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Owned fake-service/worker contracts; no native addon or account operations.
 * @param {{QQClient:typeof import('../../src/index.ts').QQClient,
 * createNativeServices:typeof import('../../src/native-services.ts').createNativeServices,
 * observeWatchFailures:typeof import('../../src/cli.ts').observeWatchFailures,
 * prepareCommand:typeof import('../../src/cli.ts').prepareCommand}} context
 */
export async function checkHistoryLifecycle({
  QQClient,
  createNativeServices,
  observeWatchFailures,
  prepareCommand,
}) {
  let uidCalls = 0,
    historyCalls = 0;
  /** @type {(value:{uidInfo:Map<string,string>})=>void} */
  let finishUid = () => assert.fail('UID resolver not installed');
  const uid = new Promise(
    /** @param {(value:{uidInfo:Map<string,string>})=>void} resolve */ (resolve) => {
      finishUid = resolve;
    },
  );
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
        getMsgsIncludeSelf(/** @type {unknown[]} */ ...args) {
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
        getUid(/** @type {string[]} */ ids) {
          uidCalls++;
          assert.deepEqual(ids, ['456']);
          return uid;
        },
      }),
    },
    version: '7.0.2-53644',
    events: { emit: () => {} },
  });
  /** @type {Extract<import('../../src/contracts/messages.ts').Peer,{type:'private'}>} */
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
    assert.ok(Array.isArray(messages));
    assert.equal(messages.length, 1);
    /** @type {unknown} */
    const message = messages[0];
    assert.ok(message !== null && typeof message === 'object');
    assert.ok('messageId' in message && 'peer' in message);
    assert.equal(message.messageId, raw.msgId);
    assert.deepEqual(message.peer, { type: 'private', userId: '456' });
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
  /** @type {[import('../../src/runtime/operations.ts').ServiceOperation,Record<string,unknown>,string][]} */
  const queries = [
    ['getHistory', { peer: { type: 'group', groupId: '123' } }, 'getMsgsIncludeSelf'],
    ['getMessage', { peer: { type: 'group', groupId: '123' }, messageId: '42' }, 'getMsgsByMsgId'],
    [
      'getMessages',
      { peer: { type: 'group', groupId: '123' }, messageIds: ['42'] },
      'getMsgsByMsgId',
    ],
  ];
  for (const reentrant of [false, true])
    for (const [method, query, nativeMethod] of queries) {
      /** @type {()=>void} */
      let begin = () => assert.fail('Begin resolver not installed');
      /** @type {(reason:unknown)=>void} */
      let rejectNative = () => assert.fail('Rejection observer not installed');
      let calls = 0;
      /** @type {ReturnType<typeof setTimeout>|undefined} */
      let deadline;
      /** @type {Promise<void>} */
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

  // Genuine ChildProcess shape, controlled IPC only; construction does not spawn.
  class Worker extends ChildProcess {
    autoExitAfterClose = true;
    /** @type {(Record<string,unknown>&{id:number,method:string})[]} */
    requests = [];
    constructor() {
      super();
      Object.defineProperty(this, 'connected', { value: true, configurable: true });
      Object.defineProperty(this, 'send', {
        value: (
          /** @type {Record<string,unknown>&{id:number,method:string}} */ value,
          /** @type {(error:Error|null)=>void} */ callback,
        ) => {
          this.requests.push(value);
          callback(null);
          if (value.method === 'close')
            queueMicrotask(() => {
              this.emit('message', { id: value.id, result: null });
              setImmediate(() => {
                if (!this.autoExitAfterClose) return;
                Object.defineProperty(this, 'connected', { value: false, configurable: true });
                this.exitCode = 0;
                this.emit('exit', 0, null);
              });
            });
          return true;
        },
      });
      Object.defineProperty(this, 'kill', {
        value: () => {
          Object.defineProperty(this, 'connected', { value: false, configurable: true });
          queueMicrotask(() => this.emit('exit', 0, null));
          return true;
        },
      });
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
      await assert.rejects(
        Reflect.apply(client.getHistory, client, [{ type: 'group', groupId: '123' }, invalid]),
      );
    assert.equal(worker.requests.length, 1);
    /** @type {Extract<import('../../src/contracts/messages.ts').Peer,{type:'group'}>} */
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

  const watched = new QQClient(new Worker(), 500);
  /** @type {Error[]} */
  const failures = [];
  const remove = observeWatchFailures(watched, { maxAttempts: 2 }, (error) => failures.push(error));
  watched.emit('disconnected', { source: 'msf', kind: 'transport', args: [], retryable: true });
  assert.equal(failures.length, 0);
  watched.emit('disconnected', { source: 'msf', kind: 'unknown', args: [], retryable: false });
  assert.equal(failures.length, 1);
  watched.emit('kicked', { source: 'kicked', kind: 'forced', args: [], retryable: true });
  assert.equal(failures.length, 2);
  remove();
  watched.emit('logout', undefined);
  assert.equal(failures.length, 2);
  await watched.close();
  const action = await prepareCommand('history', {
    kind: 'group',
    target: '123',
    before: raw.msgId,
    limit: '2',
  });
  const cliWorker = new Worker();
  const cliClient = new QQClient(cliWorker, 500);
  try {
    const login = cliClient.login({ method: 'restore', uin: '123' });
    const account = { uin: '123', uid: 'u_fixture' };
    cliWorker.emit('message', { event: 'ready', payload: account });
    cliWorker.emit('message', { id: cliWorker.requests[0].id, result: account });
    await login;
    const pending = action(cliClient);
    const request = cliWorker.requests[1];
    assert.equal(request.method, 'getHistory');
    assert.deepEqual(request.peer, { type: 'group', groupId: '123' });
    assert.deepEqual(request.options, { before: raw.msgId, limit: 2, reverse: false });
    cliWorker.emit('message', { id: request.id, result: [] });
    assert.deepEqual(await pending, []);
    assert.equal(cliWorker.requests.filter((value) => value.method === 'getHistory').length, 1);
  } finally {
    await cliClient.close();
  }
  return {
    pendingReadCloseContract: true,
    reentrantReadCloseContract: true,
    historyInputCaptureContract: true,
    loginWaitIdentityContract: true,
    watchReconnectPolicyContract: true,
    nativeHistoryQueryAttempted: false,
  };
}

/** @param {string} packageRoot */
export async function verifyHistoryLifecycleConsumer(packageRoot) {
  /** @type {Promise<typeof import('../../src/index.ts')>} */
  const clientModule = import(pathToFileURL(join(packageRoot, 'dist/index.js')).href);
  /** @type {Promise<typeof import('../../src/native-services.ts')>} */
  const servicesModule = import(pathToFileURL(join(packageRoot, 'dist/native-services.js')).href);
  /** @type {Promise<typeof import('../../src/cli.ts')>} */
  const cliModule = import(pathToFileURL(join(packageRoot, 'dist/cli.js')).href);
  const [{ QQClient }, { createNativeServices }, { observeWatchFailures, prepareCommand }] =
    await Promise.all([clientModule, servicesModule, cliModule]);
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
