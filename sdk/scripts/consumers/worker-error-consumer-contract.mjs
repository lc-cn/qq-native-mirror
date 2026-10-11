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
    const pending = client.login({ method: 'qr' });
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
