import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
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
