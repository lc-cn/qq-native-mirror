import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChildProcess, fork } from 'node:child_process';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Actual worker RPC and client error projection; bootstrap and operations are synthetic.
 * @param {{QQClient:typeof import('../../src/client/qq-client.ts').QQClient,
 * workerPath:string, kernelPath:string, nativeContractsPath:string, errorsPath:string}} options
 */
export async function verifyWorkerErrorRoutes({
  QQClient,
  workerPath,
  kernelPath,
  nativeContractsPath,
  errorsPath,
}) {
  await verifyClientIdentity(QQClient);
  await verifyClientPresentation(QQClient);
  await verifyClientClosing(QQClient);
  await verifyClientOffline(QQClient);
  await verifyClientLoginTimeout(QQClient);
  await verifyClientReconnectFailure(QQClient);
  await verifyClientReconnectEntry(QQClient);
  await verifyClientReconnectSpawnFailure(QQClient);
  await verifyClientCloseFailureNotification(QQClient);
  await verifyClientLoginFailureNotification(QQClient);
  await verifyClientNativeExportsSnapshot(QQClient);
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'qq-worker-error-')));
  /** @type {import("../../src/client/qq-client.ts").QQClient | undefined} */
  let client;
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let worker;
  try {
    const fixture = join(directory, 'kernel.mjs');
    const hook = join(directory, 'hook.mjs');
    await writeFile(
      fixture,
      `
import {MergedForwardError} from ${JSON.stringify(pathToFileURL(await realpath(errorsPath)).href)};
let count=0;
export function createKernel(_native,_options,emit){return {
 async prepare(){},async login(){const account={uin:'789',uid:'u_fixture'};emit('ready',account);return account;},
 invokeOperation(method,payload){
  count++; if(method==='getGroupInfo')return {groupId:'123',name:'fixture',count};
  const mode=payload.userId;
  if(mode==='unknown'){throw {toString(){throw Error('PRIVATE_SERIALIZER');}};}
  if(mode==='revoked'){const p=Proxy.revocable({},{});p.revoke();throw p.proxy;}
  let error=new Error('Synthetic operation failure');
  if(['message','name','code'].includes(mode))Object.defineProperty(error,mode,{get(){throw Error('PRIVATE_SERIALIZER');}});
  if(mode==='progress'||mode==='progress-getter'){
 error=new MergedForwardError('upload','Synthetic operation failure',{uploadCompletion:'unknown',cardCompletion:'not-dispatched'},23);
 const progress={};progress.self=progress;
 if(mode==='progress-getter')Object.defineProperty(progress,'uploadCompletion',{get(){throw Error('PRIVATE_SERIALIZER');}});
 Object.defineProperty(error,'progress',{value:progress});
 }
 if(['message','name','code'].includes(mode))emit('login-error',error);
  throw error;
 },async close(){}
};}
`,
    );
    const kernelUrl = pathToFileURL(await realpath(kernelPath)).href;
    const contractsUrl = pathToFileURL(await realpath(nativeContractsPath)).href;
    await writeFile(
      hook,
      `import{registerHooks}from'node:module';process.dlopen=()=>{};registerHooks({resolve(s,c,n){const r=n(s,c);if(r.url===${JSON.stringify(kernelUrl)})return{url:${JSON.stringify(pathToFileURL(fixture).href)},shortCircuit:true};return r;},load(u,c,n){if(u===${JSON.stringify(contractsUrl)})return{format:'module',source:'export async function inspectNativeContracts(){return undefined}',shortCircuit:true};return n(u,c);}});`,
    );
    worker = fork(await realpath(workerPath), [], {
      cwd: directory,
      execArgv: ['--import', pathToFileURL(hook).href],
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    assert.ok(worker.stdout);
    assert.ok(worker.stderr);
    worker.stdout.resume();
    worker.stderr.resume();
    /** @type {unknown[]} */
    const replies = [];
    /** @type {unknown[]} */
    const events = [];
    worker.on('message', (/** @type {unknown} */ message) => {
      if (!message || typeof message !== 'object') return;
      if ('id' in message && Number.isSafeInteger(message.id)) replies.push(message);
      if ('event' in message && message.event === 'login-error' && 'payload' in message)
        events.push(message.payload);
    });
    client = new QQClient(worker, 3000);
    await client.request('init', {
      options: {
        dataDir: join(directory, 'data'),
        wrapperPath: join(directory, 'fixture.node'),
        version: { clientVersion: 'fixture', appId: '1', qua: 'fixture' },
        preloadLibraries: [],
      },
    });
    await client.login({ method: 'restore', uin: '789' });
    /** @type {Error[]} */
    const loginErrors = [];
    client.on('login-error', (/** @type {Error} */ error) => loginErrors.push(error));
    let operations = 0;
    for (const mode of [
      'unknown',
      'message',
      'name',
      'code',
      'revoked',
      'progress',
      'progress-getter',
    ]) {
      const before = replies.length;
      await assert.rejects(
        client.request('getUserProfile', { userId: mode }),
        (/** @type {unknown} */ error) => {
          assert.ok(error instanceof Error);
          assert.equal(error.name, 'KernelRequestError');
          assert.ok('operation' in error);
          assert.equal(error.operation, 'getUserProfile');
          if (mode.startsWith('progress')) {
            assert.ok('code' in error);
            assert.ok('mergedForward' in error);
            assert.equal(error.code, 23);
            assert.equal(error.mergedForward, undefined);
          }
          assert.equal(typeof error.message, 'string');
          assert.ok(error.message.length > 0 && error.message.length < 1000);
          assert.ok(!error.message.includes('PRIVATE_SERIALIZER'));
          return true;
        },
      );
      assert.equal(replies.length, before + 1, 'one response, no retries');
      assert.equal(worker.connected, true);
      if (['message', 'name', 'code'].includes(mode)) {
        const event = events.at(-1);
        assert.ok(event && typeof event === 'object' && 'message' in event);
        assert.deepEqual(Object.keys(event), ['message']);
        assert.equal(typeof event.message, 'string');
        assert.ok(typeof event.message === 'string');
        assert.ok(!event.message.includes('PRIVATE_SERIALIZER'));
        const loginError = loginErrors.at(-1);
        assert.ok(loginError);
        assert.equal(loginError.message, event.message);
      }
      operations += 2;
      assert.deepEqual(await client.request('getGroupInfo', { groupId: '123' }), {
        groupId: '123',
        name: 'fixture',
        count: operations,
      });
    }
    await client.close();
    return {
      clientIdentityInstalledContract: true,
      clientLoginReentrancyContract: true,
      clientClosingObserverCleanupContract: true,
      clientOfflineObserverRetirementContract: true,
      clientOfflineBatchCancellationContract: true,
      clientNestedOfflineRestoreContract: true,
      clientLoginTimeoutObserverRetirementContract: true,
      clientReconnectFailureRetirementContract: true,
      clientReconnectEntryReservationContract: true,
      clientReconnectSpawnFailureContract: true,
      clientCloseFailureNotificationContract: true,
      clientLoginFailureNotificationContract: true,
      clientNativeExportsSnapshotContract: true,
      clientEventPresentationInstalledContract: true,
      workerOpaqueErrorContract: true,
      workerErrorRecoveryContract: true,
      workerErrorNoRetryContract: true,
      workerMergedForwardErrorContract: true,
      workerMessageOnlyErrorEventContract: true,
      nativeExecuted: false,
      accountUsed: false,
      realHttp: false,
    };
  } finally {
    try {
      await client?.close();
    } finally {
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        const activeWorker = worker;
        const exited = new Promise((resolve) =>
          activeWorker.once('exit', () => resolve(undefined)),
        );
        worker.kill('SIGKILL');
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
}

/** @param {typeof import('../../src/client/qq-client.ts').QQClient} QQClient */
async function verifyClientNativeExportsSnapshot(QQClient) {
  for (const malformed of [false, true]) {
    const previous = new ChildProcess(),
      replacement = new ChildProcess();
    let oldKills = 0,
      newKills = 0,
      loginCalls = 0;
    for (const child of [previous, replacement]) {
      Object.defineProperty(child, 'connected', { value: true, configurable: true });
      Object.defineProperty(child, 'kill', {
        value() {
          if (child === previous) oldKills++;
          else newKills++;
          Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
          queueMicrotask(() => child.emit('exit', 0, null));
          return true;
        },
      });
    }
    Object.defineProperty(replacement, 'send', {
      value(
        /** @type {{id:number,method?:string}} */ message,
        /** @type {(error:Error|null)=>void} */ callback,
      ) {
        callback(null);
        queueMicrotask(() => {
          if (message.method === 'login') {
            loginCalls++;
            replacement.emit('message', { event: 'ready', payload: { uin: '42', uid: 'fixture' } });
          }
          replacement.emit('message', {
            id: message.id,
            result:
              message.method === 'init'
                ? { exports: malformed ? ['valid', null] : ['first', 'second'] }
                : { uin: '42', uid: 'fixture' },
          });
        });
        return true;
      },
    });
    const client = new QQClient(
      previous,
      1000,
      { method: 'qr' },
      { spawn: () => replacement, payload: {} },
    );
    const oldView = client.nativeExports;
    oldView.push('caller-owned');
    Object.freeze(oldView);
    /** @type {{error:unknown}|undefined} */
    let failure;
    try {
      const outcome = client.reconnect({ method: 'qr' }).then(
        (value) => ({ value }),
        (/** @type {unknown} */ error) => ({ error }),
      );
      const result = await outcome;
      if (malformed) {
        assert.ok('error' in result);
        assert.deepEqual(client.nativeExports, []);
        assert.equal(loginCalls, 0);
        assert.equal(newKills, 1);
      } else {
        assert.deepEqual(result, { value: { uin: '42', uid: 'fixture' } });
        assert.deepEqual(client.nativeExports, ['first', 'second']);
        assert.equal(loginCalls, 1);
        assert.equal(newKills, 0);
        const changed = client.nativeExports;
        changed.splice(0, changed.length, 'tampered');
        assert.deepEqual(client.nativeExports, ['first', 'second']);
      }
      assert.deepEqual(oldView, ['caller-owned']);
      assert.equal(oldKills, 1);
    } catch (error) {
      failure = { error };
    }
    try {
      for (const child of [previous, replacement]) {
        Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
        child.emit('exit', 0, null);
      }
      await client.close();
    } catch (error) {
      if (failure)
        throw new AggregateError(
          [failure.error, error],
          'Native exports verification and teardown failed',
          { cause: error },
        );
      throw error;
    } finally {
      client.removeAllListeners();
    }
    if (failure) throw failure.error;
  }
}

/** @param {typeof import('../../src/client/qq-client.ts').QQClient} QQClient */
async function verifyClientLoginFailureNotification(QQClient) {
  for (const mode of ['reply', 'nested', 'connecting']) {
    const child = new ChildProcess();
    Object.defineProperty(child, 'connected', { value: true, configurable: true });
    const primary = Object.freeze({ connectingObserver: true }),
      notification = Object.freeze({ idleObserver: true });
    /** @type {{id:number,method:string}[]} */
    const sent = [];
    Object.defineProperty(child, 'send', {
      value(
        /** @type {{id:number,method?:string}} */ message,
        /** @type {(error:Error|null)=>void} */ callback,
      ) {
        callback(null);
        if (message.method) sent.push({ id: message.id, method: message.method });
        return true;
      },
    });
    const client = new QQClient(child, 1000);
    /** @type {{nested?:Promise<{error:unknown}|{value:unknown}>}} */
    const observed = {};
    let idleCalls = 0;
    const notify = (/** @type {string} */ state) => {
      if (state === 'connecting' && mode === 'connecting') throw primary;
      if (state === 'idle') {
        idleCalls++;
        if (mode === 'nested')
          observed.nested = client.login({ method: 'qr' }).then(
            (value) => ({ value }),
            (/** @type {unknown} */ error) => ({ error }),
          );
        throw notification;
      }
    };
    client.on('state', notify);
    const login = client.login({ method: 'qr' });
    const outcome = login.then(
      (value) => ({ value }),
      (/** @type {unknown} */ error) => ({ error }),
    );
    const joined = client.login({ method: 'qr' });
    const wait = client.waitForLogin();
    const joinedOutcome = joined.then(
      (value) => ({ value }),
      (/** @type {unknown} */ error) => ({ error }),
    );
    const waitOutcome = wait.then(
      (value) => ({ value }),
      (/** @type {unknown} */ error) => ({ error }),
    );
    assert.strictEqual(joined, login);
    assert.strictEqual(wait, login);
    if (mode !== 'connecting') {
      const request = sent[0];
      assert.ok(request);
      child.emit('message', {
        id: request.id,
        error: { message: 'controlled login failure', code: 7 },
      });
    }
    /** @type {{error:unknown}|undefined} */
    let failure;
    try {
      const result = await outcome;
      assert.ok('error' in result && result.error instanceof AggregateError);
      assert.equal(result.error.errors.length, 2);
      assert.strictEqual(result.error.errors[1], notification);
      if (mode === 'connecting') assert.strictEqual(result.error.errors[0], primary);
      else {
        assert.ok(result.error.errors[0] instanceof Error);
        assert.equal(result.error.errors[0].message, 'controlled login failure');
        assert.equal(Reflect.get(result.error.errors[0], 'code'), 7);
      }
      for (const value of await Promise.all([joinedOutcome, waitOutcome])) {
        assert.ok('error' in value);
        assert.strictEqual(value.error, result.error);
      }
      assert.equal(idleCalls, 1);
      assert.equal(sent.length, mode === 'connecting' ? 0 : mode === 'nested' ? 2 : 1);
      client.off('state', notify);
      const recovering =
        mode === 'nested'
          ? observed.nested
          : client.login({ method: 'qr' }).then(
              (value) => ({ value }),
              (/** @type {unknown} */ error) => ({ error }),
            );
      assert.ok(recovering);
      const request = sent.at(-1);
      assert.ok(request);
      child.emit('message', { event: 'ready', payload: { uin: '42', uid: 'recovered' } });
      child.emit('message', { id: request.id, result: { uin: '42', uid: 'recovered' } });
      assert.deepEqual(await recovering, { value: { uin: '42', uid: 'recovered' } });
      assert.equal(client.state, 'online');
      assert.equal(idleCalls, 1);
      assert.equal(sent.length, mode === 'connecting' ? 1 : 2);
    } catch (error) {
      failure = { error };
    }
    try {
      client.off('state', notify);
      Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
      child.emit('exit', 0, null);
      await Promise.all([outcome, joinedOutcome, waitOutcome, observed.nested]);
      await client.close();
    } catch (error) {
      if (failure)
        throw new AggregateError([failure.error, error], 'Login verification and cleanup failed', {
          cause: error,
        });
      throw error;
    } finally {
      client.removeAllListeners();
    }
    if (failure) throw failure.error;
  }
}

/** @param {typeof import('../../src/client/qq-client.ts').QQClient} QQClient */
async function verifyClientCloseFailureNotification(QQClient) {
  for (const retiring of [false, true]) {
    const child = new ChildProcess();
    Object.defineProperty(child, 'connected', { value: true, configurable: true });
    const closingError = Object.freeze({ closingObserver: true });
    const cleanupError = Object.freeze({ workerCleanup: true });
    const failedError = Object.freeze({ failedObserver: true });
    let kills = 0,
      spawns = 0;
    /** @type {string[]} */
    const sent = [];
    /** @type {{close?:Promise<void>,outcome?:Promise<{error:unknown}|{closed:true}>}} */
    const observed = {};
    Object.defineProperty(child, 'kill', {
      value() {
        kills++;
        if (retiring) {
          observed.close = client.close();
          observed.outcome = observed.close.then(
            () => ({ closed: true }),
            (/** @type {unknown} */ error) => ({ error }),
          );
        }
        throw cleanupError;
      },
    });
    Object.defineProperty(child, 'send', {
      value(
        /** @type {{id:number,method?:string}} */ message,
        /** @type {(error:Error|null)=>void} */ callback,
      ) {
        callback(null);
        if (message.method) sent.push(message.method);
        if (message.method === 'close')
          queueMicrotask(() =>
            child.emit('message', {
              id: message.id,
              error: { message: 'close IPC failure', code: 7 },
            }),
          );
        return true;
      },
    });
    const client = new QQClient(
      child,
      1000,
      { method: 'qr' },
      {
        spawn() {
          spawns++;
          throw new Error('Must not replace failed shutdown');
        },
        payload: {},
      },
    );
    child.emit('message', { event: 'ready', payload: { uin: '123', uid: 'fixture' } });
    client.on('state', (state) => {
      if (state === 'closing') throw closingError;
      if (state === 'failed') throw failedError;
    });
    const sibling = client.request('listFriends').then(
      (/** @type {unknown} */ value) => ({ value }),
      (/** @type {unknown} */ error) => ({ error }),
    );
    /** @type {Promise<{error:unknown}|{value:unknown}>|undefined} */
    let restart;
    if (retiring)
      restart = client.reconnect({ method: 'qr' }).then(
        (value) => ({ value }),
        (/** @type {unknown} */ error) => ({ error }),
      );
    else {
      observed.close = client.close();
      observed.outcome = observed.close.then(
        () => ({ closed: true }),
        (/** @type {unknown} */ error) => ({ error }),
      );
    }
    /** @type {{error:unknown}|undefined} */
    let primary;
    try {
      if (retiring) {
        assert.ok(restart);
        await restart;
      }
      assert.ok(observed.close && observed.outcome);
      assert.strictEqual(client.close(), observed.close);
      const result = await observed.outcome;
      assert.ok('error' in result);
      /** @param {unknown} value @returns {unknown[]} */
      const leaves = (value) =>
        value instanceof AggregateError ? value.errors.flatMap(leaves) : [value];
      const failures = leaves(result.error);
      assert.equal(failures.length, 3);
      assert.strictEqual(failures[0], closingError);
      assert.strictEqual(failures[1], cleanupError);
      assert.strictEqual(failures[2], failedError);
      assert.equal(kills, 1);
      assert.equal(spawns, 0);
      assert.equal(client.account, undefined);
      assert.equal(client.state, 'failed');
      assert.deepEqual(sent, retiring ? ['listFriends'] : ['listFriends', 'close']);
      const pending = await sibling;
      assert.ok('error' in pending && pending.error instanceof Error);
      const again = client.close();
      assert.strictEqual(again, observed.close);
      await assert.rejects(again, (error) => error === result.error);
      assert.equal(kills, 1);
    } catch (error) {
      primary = { error };
    }
    try {
      // kill threw: production did not observe an exit. Only fixture teardown emits it.
      Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
      child.emit('exit', 0, null);
      await Promise.all([sibling, restart, observed.outcome]);
    } catch (error) {
      if (primary)
        throw new AggregateError([primary.error, error], 'Close fixture and teardown failed', {
          cause: error,
        });
      throw error;
    } finally {
      client.removeAllListeners();
    }
    if (primary) throw primary.error;
  }
}

/** @param {typeof import('../../src/client/qq-client.ts').QQClient} QQClient */
async function verifyClientReconnectSpawnFailure(QQClient) {
  for (const mode of ['error', 'opaque', 'undefined-observer', 'no-observer']) {
    const previous = new ChildProcess(),
      replacement = new ChildProcess();
    const primary =
      mode === 'error' || mode === 'no-observer'
        ? new Error('Controlled spawn failure')
        : Object.freeze({ spawnFailure: true });
    const notification =
      mode === 'undefined-observer' ? undefined : Object.freeze({ failedObserver: true });
    let kills = 0,
      spawns = 0,
      initCalls = 0;
    /** @type {{id:number,method:string}[]} */
    const sent = [];
    for (const child of [previous, replacement]) {
      Object.defineProperty(child, 'connected', { value: true, configurable: true });
      Object.defineProperty(child, 'kill', {
        value() {
          kills++;
          Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
          queueMicrotask(() => child.emit('exit', 0, null));
          return true;
        },
      });
      Object.defineProperty(child, 'send', {
        value(
          /** @type {{id:number,method?:string}} */ message,
          /** @type {(error:Error|null)=>void} */ callback,
        ) {
          callback(null);
          if (child === previous && message.method)
            sent.push({ id: message.id, method: message.method });
          if (child === replacement) {
            if (message.method === 'init') initCalls++;
            queueMicrotask(() => {
              if (message.method === 'login')
                child.emit('message', { event: 'ready', payload: { uin: '42', uid: 'recovered' } });
              child.emit('message', {
                id: message.id,
                result:
                  message.method === 'init' ? { exports: [] } : { uin: '42', uid: 'recovered' },
              });
            });
          }
          return true;
        },
      });
    }
    let allowRecovery = false;
    const client = new QQClient(
      previous,
      1000,
      { method: 'qr' },
      {
        spawn() {
          spawns++;
          if (!allowRecovery) throw primary;
          return replacement;
        },
        payload: {},
      },
    );
    previous.emit('message', { event: 'ready', payload: { uin: '123', uid: 'original' } });
    const pending = client.request('listFriends').then(
      (/** @type {unknown} */ value) => ({ value }),
      (/** @type {unknown} */ error) => ({ error }),
    );
    const merged = client.request('sendMergedForward').then(
      (/** @type {unknown} */ value) => ({ value }),
      (/** @type {unknown} */ error) => ({ error }),
    );
    /** @type {{joined?:ReturnType<typeof client.reconnect>,joinOutcome?:Promise<{error:unknown}|{value:unknown}>,different?:Promise<{error:unknown}|{value:unknown}>}} */
    const observed = {};
    const notify = (/** @type {string} */ state) => {
      if (state === 'connecting' && !observed.joined) {
        observed.joined = client.reconnect({ method: 'qr' });
        observed.joinOutcome = observed.joined.then(
          (value) => ({ value }),
          (/** @type {unknown} */ error) => ({ error }),
        );
        observed.different = client.reconnect({ method: 'restore', uin: '456' }).then(
          (value) => ({ value }),
          (/** @type {unknown} */ error) => ({ error }),
        );
      }
      if (state === 'failed' && mode !== 'no-observer') throw notification;
    };
    client.on('state', notify);
    const reconnect = client.reconnect({ method: 'qr' });
    const outcome = reconnect.then(
      (value) => ({ value }),
      (/** @type {unknown} */ error) => ({ error }),
    );
    /** @type {{error:unknown}|undefined} */
    let verificationFailure;
    try {
      assert.strictEqual(reconnect, observed.joined);
      const result = await outcome;
      assert.ok('error' in result);
      if (mode === 'no-observer') assert.strictEqual(result.error, primary);
      else {
        assert.ok(result.error instanceof AggregateError);
        assert.equal(result.error.errors.length, 2);
        assert.strictEqual(result.error.errors[0], primary);
        assert.strictEqual(result.error.errors[1], notification);
      }
      assert.ok(observed.joinOutcome && observed.different);
      assert.deepEqual(await observed.joinOutcome, result);
      const mismatch = await observed.different;
      assert.ok('error' in mismatch && mismatch.error instanceof Error);
      assert.match(mismatch.error.message, /different reconnect/i);
      const retired = await pending;
      assert.ok('error' in retired && retired.error instanceof Error);
      assert.match(retired.error.message, /reconnecting/);
      const mergedResult = await merged;
      assert.ok('error' in mergedResult && mergedResult.error instanceof Error);
      assert.deepEqual(Reflect.get(mergedResult.error, 'mergedForward'), {
        phase: 'operation',
        uploadCompletion: 'unknown',
        cardCompletion: 'unknown',
      });
      assert.equal(client.account, undefined);
      assert.equal(client.state, 'failed');
      assert.equal(kills, 1);
      assert.equal(spawns, 1);
      assert.equal(initCalls, 0);
      if (mode === 'no-observer') {
        client.off('state', notify);
        allowRecovery = true;
        assert.deepEqual(await client.reconnect({ method: 'qr' }), { uin: '42', uid: 'recovered' });
        assert.equal(spawns, 2);
        assert.equal(initCalls, 1);
        assert.equal(kills, 1);
      }
    } catch (error) {
      verificationFailure = { error };
    }
    try {
      client.off('state', notify);
      for (const child of [previous, replacement]) {
        Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
        child.emit('exit', 0, null);
      }
      await Promise.all([pending, merged, outcome, observed.joinOutcome, observed.different]);
      await client.close();
    } catch (cleanupError) {
      if (verificationFailure)
        throw new AggregateError(
          [verificationFailure.error, cleanupError],
          'Spawn verification and cleanup failed',
          { cause: cleanupError },
        );
      throw cleanupError;
    } finally {
      client.removeAllListeners();
    }
    if (verificationFailure) throw verificationFailure.error;
  }
}

/** @param {typeof import('../../src/client/qq-client.ts').QQClient} QQClient */
async function verifyClientReconnectEntry(QQClient) {
  for (const closeReentry of [false, true]) {
    const previous = new ChildProcess(),
      replacement = new ChildProcess();
    const original = Object.freeze({ reconnectEntryObserver: true });
    let kills = 0,
      spawns = 0;
    /** @type {{id:number,method:string}[]} */
    const oldSent = [];
    /** @type {{id:number,method:string}[]} */
    const newSent = [];
    for (const child of [previous, replacement]) {
      Object.defineProperty(child, 'connected', { value: true, configurable: true });
      Object.defineProperty(child, 'kill', {
        value() {
          kills++;
          Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
          queueMicrotask(() => child.emit('exit', 0, null));
          return true;
        },
      });
      Object.defineProperty(child, 'send', {
        value(
          /** @type {{id:number,method?:string}} */ message,
          /** @type {(error:Error|null)=>void} */ callback,
        ) {
          callback(null);
          if (message.method)
            (child === previous ? oldSent : newSent).push({
              id: message.id,
              method: message.method,
            });
          if (child === replacement || message.method === 'close')
            queueMicrotask(() => {
              if (message.method === 'login')
                child.emit('message', { event: 'ready', payload: { uin: '42', uid: 'recovered' } });
              child.emit('message', {
                id: message.id,
                result:
                  message.method === 'init'
                    ? { exports: [] }
                    : message.method === 'login'
                      ? { uin: '42', uid: 'recovered' }
                      : null,
              });
            });
          return true;
        },
      });
    }
    const client = new QQClient(
      previous,
      1000,
      { method: 'qr' },
      {
        spawn() {
          spawns++;
          return replacement;
        },
        payload: {},
      },
    );
    previous.emit('message', { event: 'ready', payload: { uin: '123', uid: 'original' } });
    const pending = client.request('listFriends').then(
      (/** @type {unknown} */ value) => ({ value }),
      (/** @type {unknown} */ error) => ({ error }),
    );
    /** @type {{joined?:ReturnType<typeof client.reconnect>,joinedObserved?:Promise<{error:unknown}|{value:unknown}>,different?:Promise<{error:unknown}|{value:unknown}>,closing?:Promise<{closed:true}|{error:unknown}>}} */
    const observed = {};
    const notify = (/** @type {string} */ state) => {
      if (state !== 'connecting') return;
      observed.joined = client.reconnect({ method: 'qr' });
      observed.joinedObserved = observed.joined.then(
        (value) => ({ value }),
        (/** @type {unknown} */ error) => ({ error }),
      );
      observed.different = client.reconnect({ method: 'restore', uin: '456' }).then(
        (value) => ({ value }),
        (/** @type {unknown} */ error) => ({ error }),
      );
      if (closeReentry) {
        observed.closing = client.close().then(
          () => ({ closed: true }),
          (/** @type {unknown} */ error) => ({ error }),
        );
      }
      throw original;
    };
    client.on('state', notify);
    /** @type {ReturnType<typeof client.reconnect>|undefined} */
    let outer;
    /** @type {{error:unknown}|undefined} */
    let primary;
    try {
      assert.doesNotThrow(() => {
        outer = client.reconnect({ method: 'qr' });
      });
      assert.ok(outer && observed.joinedObserved && observed.different);
      assert.strictEqual(outer, observed.joined);
      await assert.rejects(outer, (error) => error === original);
      assert.deepEqual(await observed.joinedObserved, { error: original });
      const mismatch = await observed.different;
      assert.ok('error' in mismatch && mismatch.error instanceof Error);
      assert.match(mismatch.error.message, /different reconnect/i);
      assert.equal(spawns, 0);
      assert.equal(newSent.length, 0);
      if (closeReentry) {
        assert.ok(observed.closing);
        assert.deepEqual(await observed.closing, { closed: true });
        assert.equal(client.state, 'closed');
        assert.equal(client.account, undefined);
        const retired = await pending;
        assert.ok('error' in retired);
      } else {
        assert.equal(kills, 0);
        assert.equal(client.state, 'online');
        assert.deepEqual(client.account, { uin: '123', uid: 'original' });
        const request = oldSent.find((value) => value.method === 'listFriends');
        assert.ok(request);
        previous.emit('message', { id: request.id, result: 'old request still alive' });
        assert.deepEqual(await pending, { value: 'old request still alive' });
        client.off('state', notify);
        assert.deepEqual(await client.reconnect({ method: 'qr' }), { uin: '42', uid: 'recovered' });
        assert.equal(spawns, 1);
        assert.deepEqual(
          newSent.map((value) => value.method),
          ['init', 'login'],
        );
      }
    } catch (error) {
      primary = { error };
    }
    try {
      client.off('state', notify);
      for (const child of [previous, replacement]) {
        Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
        child.emit('exit', 0, null);
      }
      await Promise.all([pending, observed.joinedObserved, observed.different]);
      await observed.closing;
      await client.close();
    } catch (cleanupError) {
      if (primary)
        throw new AggregateError(
          [primary.error, cleanupError],
          'Reconnect entry verification and cleanup failed',
          { cause: cleanupError },
        );
      throw cleanupError;
    } finally {
      client.removeAllListeners();
    }
    if (primary) throw primary.error;
  }
}

/** @param {typeof import('../../src/client/qq-client.ts').QQClient} QQClient */
async function verifyClientReconnectFailure(QQClient) {
  for (const mode of ['init', 'cleanup-failure', 'close-reentry', 'login-timeout']) {
    const previous = new ChildProcess();
    const replacement = new ChildProcess();
    const observer = Object.freeze({ reconnectObserver: true });
    const cleanup = Object.freeze({ reconnectCleanup: true });
    /** @type {{id:number,method:string}[]} */
    const sent = [];
    let oldKills = 0,
      newKills = 0,
      exited = false;
    for (const child of [previous, replacement]) {
      Object.defineProperty(child, 'connected', { value: true, configurable: true });
      Object.defineProperty(child, 'kill', {
        value() {
          if (child === previous) oldKills++;
          else newKills++;
          if (child === replacement && mode === 'cleanup-failure') throw cleanup;
          setTimeout(() => {
            if (child === replacement) exited = true;
            Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
            child.emit('exit', 0, null);
          }, 5);
          return true;
        },
      });
    }
    Object.defineProperty(replacement, 'send', {
      value(
        /** @type {{id:number,method?:string}} */ message,
        /** @type {(error:Error|null)=>void} */ callback,
      ) {
        callback(null);
        if (message.method) sent.push({ id: message.id, method: message.method });
        if (message.method === 'init' && mode === 'login-timeout')
          queueMicrotask(() =>
            replacement.emit('message', { id: message.id, result: { exports: [] } }),
          );
        return true;
      },
    });
    const client = new QQClient(
      previous,
      mode === 'login-timeout' ? 100 : 1000,
      { method: 'qr' },
      { spawn: () => replacement, payload: {} },
    );
    /** @type {Promise<{closed:true}|{error:unknown}>|undefined} */
    let closing;
    let notifications = 0;
    client.on('state', (state) => {
      if (state !== 'failed' || notifications++) return;
      for (const message of sent.filter((value) => !['init', 'login'].includes(value.method)))
        replacement.emit('message', { id: message.id, result: 'late' });
      replacement.emit('message', { event: 'ready', payload: { uin: '123', uid: 'late' } });
      if (mode === 'close-reentry')
        closing = client.close().then(
          () => ({ closed: true }),
          (/** @type {unknown} */ error) => ({ error }),
        );
      throw observer;
    });
    const reconnect = client.reconnect({ method: 'qr' }).then(
      (value) => ({ value }),
      (/** @type {unknown} */ error) => ({ error }),
    );
    // Previous worker termination has a real asynchronous exit gate.
    for (
      let attempt = 0;
      !sent.some((value) => value.method === 'init') && attempt < 100;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 1));
    const sibling = client.request('listFriends').then(
      (/** @type {unknown} */ value) => ({ value }),
      (/** @type {unknown} */ error) => ({ error }),
    );
    const merged = client.request('sendMergedForward').then(
      (/** @type {unknown} */ value) => ({ value }),
      (/** @type {unknown} */ error) => ({ error }),
    );
    const init = sent.find((value) => value.method === 'init');
    assert.ok(init);
    if (mode !== 'login-timeout')
      replacement.emit('message', {
        id: init.id,
        error: { message: 'controlled init failure', code: 7 },
      });
    /** @type {{error:unknown}|undefined} */
    let primaryFailure;
    try {
      const result = await reconnect;
      assert.ok('error' in result && result.error instanceof AggregateError);
      const failures = result.error.errors;
      assert.ok(failures[0] instanceof Error);
      if (mode === 'login-timeout') assert.match(failures[0].message, /login timed out/i);
      else {
        assert.equal(failures[0].message, 'controlled init failure');
        assert.equal(Reflect.get(failures[0], 'code'), 7);
      }
      assert.strictEqual(failures[1], observer);
      assert.equal(failures.length, mode === 'cleanup-failure' ? 3 : 2);
      if (mode === 'cleanup-failure') assert.strictEqual(failures[2], cleanup);
      const siblingResult = await sibling;
      assert.ok('error' in siblingResult);
      assert.strictEqual(siblingResult.error, failures[0]);
      const mergedResult = await merged;
      assert.ok('error' in mergedResult && mergedResult.error instanceof Error);
      assert.equal(mergedResult.error.message, failures[0].message);
      assert.deepEqual(Reflect.get(mergedResult.error, 'mergedForward'), {
        phase: 'operation',
        uploadCompletion: 'unknown',
        cardCompletion: 'unknown',
      });
      assert.equal(notifications, 1);
      assert.equal(oldKills, 1);
      assert.equal(newKills, 1);
      assert.equal(client.account, undefined);
      assert.equal(client.state, mode === 'close-reentry' ? 'closed' : 'failed');
      if (mode !== 'cleanup-failure') assert.equal(exited, true);
      if (closing) assert.deepEqual(await closing, { closed: true });
      assert.equal(sent.filter((value) => value.method === 'init').length, 1);
      assert.equal(
        sent.filter((value) => value.method === 'login').length,
        mode === 'login-timeout' ? 1 : 0,
      );
    } catch (error) {
      primaryFailure = { error };
    }
    try {
      for (const child of [previous, replacement]) {
        Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
        child.emit('exit', 0, null);
      }
      await Promise.all([reconnect, sibling, merged]);
      if (mode === 'cleanup-failure')
        await assert.rejects(client.close(), (error) => error === cleanup);
      else await client.close();
      assert.equal(newKills, 1);
    } catch (cleanupError) {
      if (primaryFailure)
        throw new AggregateError(
          [primaryFailure.error, cleanupError],
          'Controlled reconnect verification and cleanup failed',
          { cause: cleanupError },
        );
      throw cleanupError;
    } finally {
      client.removeAllListeners();
    }
    if (primaryFailure) throw primaryFailure.error;
  }
}

/** @param {typeof import('../../src/client/qq-client.ts').QQClient} QQClient */
async function verifyClientLoginTimeout(QQClient) {
  for (const [cleanupFails, closeReentry] of [
    [false, false],
    [true, false],
    [false, true],
  ]) {
    const child = new ChildProcess();
    Object.defineProperty(child, 'connected', { value: true, configurable: true });
    /** @type {{id:number,method:string}[]} */
    const sent = [];
    Object.defineProperty(child, 'send', {
      value(
        /** @type {{id:number,method?:string}} */ message,
        /** @type {(error:Error|null)=>void} */ callback,
      ) {
        callback(null);
        if (message.method) sent.push({ id: message.id, method: message.method });
        return true;
      },
    });
    const observer = Object.freeze({ timeoutObserver: true });
    const cleanup = Object.freeze({ timeoutCleanup: true });
    let kills = 0;
    let exited = false;
    /** @type {Promise<{closed:true}|{error:unknown}>|undefined} */
    let reentrantClose;
    Object.defineProperty(child, 'kill', {
      value() {
        kills++;
        if (cleanupFails) throw cleanup;
        setTimeout(() => {
          exited = true;
          Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
          child.emit('exit', 0, null);
        }, 5);
        return true;
      },
    });
    const client = new QQClient(child, 20);
    let failedNotifications = 0;
    client.on('state', (state) => {
      if (state !== 'failed' || failedNotifications++) return;
      for (const message of sent.filter((value) => value.method !== 'login'))
        child.emit('message', { id: message.id, result: 'late sibling success' });
      child.emit('message', { event: 'ready', payload: { uin: '123', uid: 'late' } });
      if (closeReentry) {
        reentrantClose = client.close().then(
          () => ({ closed: true }),
          (/** @type {unknown} */ error) => ({ error }),
        );
      }
      throw observer;
    });
    const login = client.login({ method: 'qr' }).then(
      (value) => ({ value }),
      (/** @type {unknown} */ error) => ({ error }),
    );
    const sibling = client.request('listFriends').then(
      (/** @type {unknown} */ value) => ({ value }),
      (/** @type {unknown} */ error) => ({ error }),
    );
    const merged = client.request('sendMergedForward').then(
      (/** @type {unknown} */ value) => ({ value }),
      (/** @type {unknown} */ error) => ({ error }),
    );
    try {
      const result = await login;
      assert.ok('error' in result && result.error instanceof AggregateError);
      const errors = result.error.errors;
      assert.ok(errors[0] instanceof Error);
      assert.match(errors[0].message, /timed out|timeout/i);
      assert.strictEqual(errors[1], observer);
      assert.equal(errors.length, cleanupFails ? 3 : 2);
      if (cleanupFails) assert.strictEqual(errors[2], cleanup);
      assert.equal(kills, 1);
      assert.equal(client.state, closeReentry ? 'closed' : 'failed');
      assert.equal(client.account, undefined);
      const siblingResult = await sibling;
      assert.ok('error' in siblingResult && siblingResult.error instanceof Error);
      assert.strictEqual(siblingResult.error, errors[0]);
      const mergedResult = await merged;
      assert.ok('error' in mergedResult && mergedResult.error instanceof Error);
      assert.equal(mergedResult.error.message, errors[0].message);
      assert.ok('mergedForward' in mergedResult.error);
      assert.deepEqual(mergedResult.error.mergedForward, {
        phase: 'operation',
        uploadCompletion: 'unknown',
        cardCompletion: 'unknown',
      });
      assert.equal(sent.filter((value) => value.method === 'login').length, 1);
      if (!cleanupFails) {
        assert.equal(exited, true);
        assert.equal(child.exitCode, 0);
      }
      if (reentrantClose) assert.deepEqual(await reentrantClose, { closed: true });
    } finally {
      Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
      child.emit('exit', 0, null);
      await Promise.all([login, sibling, merged]);
      if (cleanupFails) await assert.rejects(client.close(), (error) => error === cleanup);
      else await client.close();
      assert.equal(kills, 1);
      client.removeAllListeners();
    }
  }
}

/** Public state observers run only after old RPCs retire; their errors remain opaque.
 * @param {typeof import('../../src/client/qq-client.ts').QQClient} QQClient */
async function verifyClientOffline(QQClient) {
  for (const offline of ['disconnected', 'logout', 'kicked']) {
    for (const throws of [false, true]) {
      const child = new ChildProcess();
      Object.defineProperty(child, 'connected', { value: true, configurable: true });
      /** @type {{id:number,method:string}[]} */
      const sent = [];
      /** @type {number[]} */
      const cancelled = [];
      Object.defineProperty(child, 'send', {
        value(
          /** @type {{id:number,method?:string,control?:string}} */ message,
          /** @type {(error:Error|null)=>void} */ callback,
        ) {
          callback(null);
          if (message.control === 'cancel-read') {
            cancelled.push(message.id);
            // The actual parent transport can reenter with any sibling response.
            for (const pending of sent.slice())
              child.emit('message', { id: pending.id, result: 'late' });
          } else {
            assert.equal(typeof message.method, 'string');
            assert.ok(message.method);
            sent.push({ id: message.id, method: message.method });
          }
          return true;
        },
      });
      const client = new QQClient(child, 1000);
      const original = Object.freeze({ observer: offline });
      let rawEvents = 0;
      EventEmitter.prototype.on.call(client, offline, () => {
        rawEvents++;
      });
      child.emit('message', { event: 'ready', payload: { uin: '123', uid: 'fixture' } });
      client.on('state', (state) => {
        if (state !== 'disconnected') return;
        assert.equal(client.account, undefined);
        for (const message of sent.slice())
          child.emit('message', { id: message.id, result: 'late' });
        if (throws) throw original;
      });
      const read = client.listFriends().then(
        (value) => ({ value }),
        (/** @type {unknown} */ error) => ({ error }),
      );
      const merged = client.request('sendMergedForward').then(
        (/** @type {unknown} */ value) => ({ value }),
        (/** @type {unknown} */ error) => ({ error }),
      );
      const closing = client.request('close').then(
        (/** @type {unknown} */ value) => ({ value }),
        (/** @type {unknown} */ error) => ({ error }),
      );
      const cancelledReads = [
        client.getGroupEssencePage('123'),
        client.listGroupNotices('123'),
      ].map((pending) =>
        pending.then(
          (value) => ({ value }),
          (/** @type {unknown} */ error) => ({ error }),
        ),
      );
      try {
        const notify = () =>
          child.emit('message', { event: offline, payload: { retryable: false } });
        if (throws) assert.throws(notify, (error) => error === original);
        else notify();
        assert.equal(client.state, 'disconnected');
        const readResult = await read;
        assert.ok('error' in readResult && readResult.error instanceof Error);
        assert.match(readResult.error.message, /offline/);
        const mergedResult = await merged;
        assert.ok('error' in mergedResult && mergedResult.error instanceof Error);
        assert.ok('mergedForward' in mergedResult.error);
        assert.deepEqual(mergedResult.error.mergedForward, {
          phase: 'operation',
          uploadCompletion: 'unknown',
          cardCompletion: 'unknown',
        });
        assert.deepEqual(await closing, { value: 'late' });
        for (const result of await Promise.all(cancelledReads)) {
          assert.ok('error' in result && result.error instanceof Error);
          assert.match(result.error.message, /offline/);
        }
        assert.equal(cancelled.length, 2);
        assert.equal(rawEvents, throws ? 0 : 1);
      } finally {
        Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
        child.emit('exit', 0, null);
        await Promise.all([read, merged, closing, ...cancelledReads]);
        await client.close();
        client.removeAllListeners();
      }
    }
  }
  const child = new ChildProcess();
  Object.defineProperty(child, 'connected', { value: true });
  // No process exists; any obsolete automatic restore would enter the controlled factory.
  Object.defineProperty(child, 'exitCode', { value: 0 });
  let spawns = 0;
  const client = new QQClient(
    child,
    1000,
    { method: 'qr' },
    {
      spawn() {
        spawns++;
        throw new Error('Obsolete restore');
      },
      payload: {},
    },
    { delayMs: 1, maxAttempts: 1 },
  );
  client.on('disconnected', (info) => {
    if (info?.retryable === true)
      child.emit('message', { event: 'disconnected', payload: { retryable: false } });
  });
  try {
    child.emit('message', { event: 'ready', payload: { uin: '123', uid: 'fixture' } });
    child.emit('message', { event: 'disconnected', payload: { retryable: true } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(spawns, 0, 'The newer nonretryable notification owns the restore decision');
    assert.equal(client.state, 'disconnected');
  } finally {
    child.emit('exit', 0, null);
    await client.close();
    client.removeAllListeners();
  }
}

/** Synchronous presentation failures cannot bypass the actual public owner's shutdown.
 * @param {typeof import('../../src/client/qq-client.ts').QQClient} QQClient */
async function verifyClientClosing(QQClient) {
  for (const cleanupFails of [false, true]) {
    const child = new ChildProcess();
    Object.defineProperty(child, 'connected', { value: true, configurable: true });
    const original = Object.freeze({ observer: 'controlled closing failure' });
    const cleanup = new Error('controlled worker kill failure');
    /** @type {string[]} */
    const order = [];
    let kills = 0;
    Object.defineProperty(child, 'send', {
      value(
        /** @type {{id:number,method:string}} */ message,
        /** @type {(error:Error|null)=>void} */ callback,
      ) {
        order.push(message.method);
        callback(cleanupFails ? new Error('controlled close IPC failure') : null);
        if (!cleanupFails)
          queueMicrotask(() => child.emit('message', { id: message.id, result: null }));
        return true;
      },
    });
    Object.defineProperty(child, 'kill', {
      value() {
        kills++;
        throw cleanup;
      },
    });
    const client = new QQClient(child, 1000);
    /** @type {Promise<void>|undefined} */
    let nested;
    client.on('state', (state) => {
      if (state !== 'closing') return;
      order.push('closing');
      nested = client.close();
      throw original;
    });
    const closing = client.close();
    const outcome = closing.then(
      () => undefined,
      (/** @type {unknown} */ error) => error,
    );
    assert.strictEqual(nested, closing);
    assert.deepEqual(order, ['closing', 'close']);
    try {
      if (cleanupFails) {
        const failure = await outcome;
        assert.ok(failure instanceof AggregateError);
        assert.deepEqual(failure.errors, [original, cleanup]);
        assert.equal(kills, 1);
        assert.equal(client.state, 'failed');
      } else {
        let settled = false;
        outcome.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false, 'Shutdown still waits for the worker exit');
        Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
        child.emit('exit', 0, null);
        assert.strictEqual(await outcome, original);
        assert.equal(kills, 0);
        assert.equal(client.state, 'closed');
      }
      assert.strictEqual(client.close(), closing);
    } finally {
      Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
      child.emit('exit', 0, null);
      await outcome;
      client.removeAllListeners();
    }
  }
}

/** Controlled IPC into the actual installed facade; no child is spawned.
 * @param {typeof import('../../src/client/qq-client.ts').QQClient} QQClient */
async function verifyClientPresentation(QQClient) {
  const child = new ChildProcess();
  const client = new QQClient(child, 100);
  try {
    const types = ['string'];
    const payload = { family: 'Msg', name: 'first', argumentTypes: types };
    let observedAuditCount = 0;
    EventEmitter.prototype.on.call(client, 'native-callback', () => {
      observedAuditCount = client.nativeCallbackAudit[0]?.count ?? 0;
    });
    child.emit('message', { event: 'native-callback', payload });
    assert.equal(observedAuditCount, 1);
    types.push('number');
    child.emit('message', {
      event: 'native-callback',
      payload: { family: 'Msg', name: 'first', argumentTypes: ['string'] },
    });
    for (let index = 0; index < 140; index++)
      child.emit('message', {
        event: 'native-callback',
        payload: { family: 'Msg', name: `callback-${index}`, argumentTypes: [] },
      });
    child.emit('message', {
      event: 'native-callback',
      payload: { family: 'Msg', name: 'first', argumentTypes: ['string'] },
    });
    assert.equal(observedAuditCount, 3);
    const snapshot = client.nativeCallbackAudit;
    assert.equal(snapshot.length, 128);
    assert.deepEqual(snapshot[0], {
      family: 'Msg',
      name: 'first',
      argumentTypes: ['string'],
      count: 3,
    });
    snapshot[0].argumentTypes.push('mutated');
    snapshot[0].count = 99;
    snapshot.pop();
    assert.equal(client.nativeCallbackAudit.length, 128);
    assert.equal(client.nativeCallbackAudit[0].count, 3);
    assert.deepEqual(client.nativeCallbackAudit[0].argumentTypes, ['string']);
    const qr = { image: Buffer.from('fixture').toString('base64') };
    /** @type {unknown[]} */
    const observed = [];
    EventEmitter.prototype.on.call(client, 'qrcode', (value) => observed.push(value));
    child.emit('message', { event: 'qrcode', payload: qr });
    assert.strictEqual(observed[0], qr);
    assert.ok(Buffer.isBuffer(qr.image));
    assert.equal(qr.image.toString(), 'fixture');
    EventEmitter.prototype.on.call(client, 'login-error', (value) => observed.push(value));
    child.emit('message', { event: 'login-error', payload: { message: 'controlled failure' } });
    assert.ok(observed[1] instanceof Error);
    assert.equal(observed[1].message, 'controlled failure');
    /** @type {[string,unknown][]} */
    const messages = [];
    for (const event of ['message', 'message.group', 'message.private', 'fixture-opaque'])
      EventEmitter.prototype.on.call(client, event, (value) => messages.push([event, value]));
    const group = { peer: { type: 'group' }, unknown: { retained: true } };
    const direct = { peer: { type: 'private' } };
    const opaque = Object.freeze({ value: Symbol('opaque') });
    child.emit('message', { event: 'message', payload: group });
    child.emit('message', { event: 'message', payload: direct });
    child.emit('message', { event: 'fixture-opaque', payload: opaque });
    assert.deepEqual(
      messages.map(([event]) => event),
      ['message', 'message.group', 'message', 'message.private', 'fixture-opaque'],
    );
    assert.strictEqual(messages[0][1], group);
    assert.strictEqual(messages[1][1], group);
    assert.strictEqual(messages[2][1], direct);
    assert.strictEqual(messages[3][1], direct);
    assert.strictEqual(messages[4][1], opaque);
    child.emit('message', { event: 'fixture-opaque', payload: null });
    assert.strictEqual(messages[5][1], null);
    const mutation = { peer: { type: 'group' } };
    EventEmitter.prototype.once.call(client, 'message', () => {
      mutation.peer.type = 'private';
    });
    child.emit('message', { event: 'message', payload: mutation });
    assert.equal(messages[7][0], 'message.private');
    assert.strictEqual(messages[7][1], mutation);
    Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
    child.emit('exit', 0, null);
    child.emit('message', { event: 'fixture-opaque', payload: opaque });
    assert.equal(messages.length, 8);
    const failingChild = new ChildProcess();
    const failingClient = new QQClient(failingChild, 100);
    const original = Error('controlled presentation observer');
    let aliasCalls = 0;
    try {
      EventEmitter.prototype.on.call(failingClient, 'message', () => {
        throw original;
      });
      EventEmitter.prototype.on.call(failingClient, 'message.group', () => {
        aliasCalls++;
      });
      assert.throws(
        () => failingChild.emit('message', { event: 'message', payload: group }),
        (error) => error === original,
      );
      assert.equal(aliasCalls, 0);
    } finally {
      Object.defineProperty(failingChild, 'exitCode', { value: 0, configurable: true });
      failingChild.emit('exit', 0, null);
      await failingClient.close();
      failingClient.removeAllListeners();
    }
  } finally {
    Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
    child.emit('exit', 0, null);
    await client.close();
    client.removeAllListeners();
  }
}

/** Account identities cross the actual facade/lifecycle boundary as unknown IPC.
 * @param {typeof import('../../src/client/qq-client.ts').QQClient} QQClient */
async function verifyClientIdentity(QQClient) {
  const child = new ChildProcess();
  Object.defineProperty(child, 'connected', { value: true });
  /** @type {number[]} */
  const requests = [];
  Object.defineProperty(child, 'send', {
    value(/** @type {unknown} */ message) {
      assert.ok(
        message && typeof message === 'object' && 'id' in message && typeof message.id === 'number',
      );
      requests.push(message.id);
      return true;
    },
  });
  const client = new QQClient(child, 1000);
  const readAccount = () => client.account;
  /** @type {unknown[]} */
  const ready = [];
  /** @type {unknown[]} */
  const diagnostics = [];
  /** @type {unknown[]} */
  const states = [];
  EventEmitter.prototype.on.call(client, 'ready', (value) => ready.push(value));
  EventEmitter.prototype.on.call(client, 'diagnostic', (value) => diagnostics.push(value));
  EventEmitter.prototype.on.call(client, 'state', (value) => states.push(value));
  try {
    let coercions = 0,
      getterReads = 0;
    const invalid = {
      errMsg: 'SECRET_NATIVE_WORDING',
      uin: '123',
      uid: {
        toString() {
          coercions++;
          return 'SECRET_IDENTITY';
        },
      },
    };
    child.emit('message', { event: 'ready', payload: invalid });
    const getterIdentity = {
      uin: '123',
      get uid() {
        getterReads++;
        return 'fixture';
      },
    };
    child.emit('message', { event: 'ready', payload: getterIdentity });
    assert.equal(ready.length, 0);
    assert.equal(states.includes('online'), false);
    assert.equal(readAccount(), undefined);
    assert.deepEqual(diagnostics, [
      { stage: 'invalid-worker-ready-account' },
      { stage: 'invalid-worker-ready-account' },
    ]);
    assert.equal(coercions, 0);
    assert.equal(getterReads, 0);
    /** @type {Promise<import('../../src/contracts/client.ts').Account> | undefined} */
    let nestedLogin;
    /** @type {Promise<import('../../src/contracts/client.ts').Account> | undefined} */
    let nestedWait;
    /** @type {Promise<void> | undefined} */
    let differentLogin;
    /** @param {import('../../src/contracts/client.ts').ClientState} state */
    const onConnecting = (state) => {
      if (state !== 'connecting') return;
      client.off('state', onConnecting);
      assert.equal(requests.length, 0, 'Connecting must precede login dispatch');
      nestedLogin = client.login({ method: 'qr' });
      nestedWait = client.waitForLogin();
      differentLogin = assert.rejects(
        client.login({ method: 'quick', uin: '456' }),
        /different login request/,
      );
    };
    client.on('state', onConnecting);
    const pending = client.login({ method: 'qr' });
    assert.strictEqual(nestedLogin, pending);
    assert.strictEqual(nestedWait, pending);
    assert.ok(differentLogin);
    await differentLogin;
    assert.strictEqual(client.login({ method: 'qr' }), pending);
    assert.equal(requests.length, 1);
    const rejection = assert.rejects(pending, { message: 'Invalid worker login account identity' });
    child.emit('message', { id: requests[0], result: invalid });
    await rejection;
    assert.equal(coercions, 0);
    const account = { uin: '000184467440737095516150000', uid: ' arbitrary-id ' };
    const success = client.login({ method: 'qr' });
    assert.strictEqual(client.waitForLogin(), success);
    child.emit('message', { id: requests[1], result: account });
    assert.deepEqual(await success, account);
    child.emit('message', { event: 'ready', payload: account });
    assert.deepEqual(readAccount(), account);
    assert.equal(ready.length, 1);
    assert.equal(states.includes('online'), true);
    const snapshot = readAccount();
    assert.ok(snapshot);
    // Mutating the original IPC object cannot replace the stored captured scalar.
    account.uin = '9';
    account.uid = 'changed';
    assert.equal(readAccount()?.uin, '000184467440737095516150000');
    assert.equal(readAccount()?.uid, ' arbitrary-id ');
    child.emit('message', { event: 'ready', payload: { uin: '0', uid: 'zero-id' } });
    assert.deepEqual(readAccount(), { uin: '0', uid: 'zero-id' });
    assert.equal(ready.length, 2);
    Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
    child.emit('exit', 0, null);
    child.emit('message', { event: 'ready', payload: { uin: '0', uid: 'late' } });
    assert.equal(ready.length, 2);
  } finally {
    Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
    child.emit('exit', 0, null);
    await client.close();
    client.removeAllListeners();
  }
}
